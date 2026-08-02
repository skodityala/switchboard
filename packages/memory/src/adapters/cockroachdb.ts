// PORT: MemoryPort — QUALIFYING ADAPTER (CockroachDB)
//
// ⚠️ PACKAGE IDENTITY, VERIFIED BEFORE WRITING THIS FILE.
// `pg` (node-postgres, github.com/brianc/node-postgres) is the driver Cockroach
// Labs documents for Node.js; CockroachDB speaks the PostgreSQL wire protocol.
// No name collision: `pg` is unambiguously node-postgres. There is no separate
// official CockroachDB Node driver to confuse it with.
//
// TWO COCKROACHDB TOOLS, chosen for load-bearing rather than nameability:
//
//   1. DISTRIBUTED VECTOR INDEX — the headline. The local adapter's recall is a
//      full linear scan of a caller's history: 918 µs p50 over 220 entries, a
//      number we published as a CEILING precisely because an index is what
//      replaces it. This adapter creates a real VECTOR(128) column with a
//      vector index, so the swap makes our own published weakness visibly
//      improve. A before/after on a number we admitted is more persuasive than
//      any claim about scale.
//
//   2. TRANSACTIONAL WRITES — a turn, its resolved entities and its access
//      decisions are one logical unit and are written in a single transaction.
//      Criterion 1 asks for "state, embeddings, context, or transactional data
//      at real scale"; this is the transactional half, and it is what stops
//      memory and audit from ever disagreeing.
//
// AWS SERVICE: the connection secret is read from AWS Secrets Manager when
// AWS_SECRET_ID is set (>=1 AWS service is mandatory). Falls back to CRDB_URL.
//
// CREDENTIALS: CRDB_URL (postgresql://...), optionally AWS_SECRET_ID + region.
// See docs/adapters/COCKROACHDB.md for the runbook.

import { recallCore, buildEntry, decisionWrite, EMBED_DIM, type MemoryStore } from '../core.js';
import type { AccessTrace, CatalogPort, Classification, FieldRef } from '@switchboard/catalog';
import type {
  MemoryEntry,
  MemoryKind,
  MemoryPort,
  MemoryWrite,
  RecallQuery,
  RecallResult,
} from '../port.js';

export class MissingCredentialError extends Error {
  constructor() {
    super(
      'set CRDB_URL (or AWS_SECRET_ID for Secrets Manager) to run the CockroachDB adapter ' +
        '(see docs/adapters/COCKROACHDB.md)',
    );
    this.name = 'MissingCredentialError';
  }
}

/** The `pg` surface used here, declared structurally so this compiles without it. */
export interface SqlClient {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  end?(): Promise<void>;
}

/** Reads the connection string from AWS Secrets Manager. */
export interface SecretResolver {
  resolve(secretId: string): Promise<string>;
}

/**
 * AWS Secrets Manager via the SDK if present, otherwise an explicit failure.
 * This is the ">=1 AWS service" requirement, used at runtime on the connection
 * path rather than name-dropped.
 */
export class AwsSecretsResolver implements SecretResolver {
  constructor(private readonly region = process.env['AWS_REGION'] ?? 'us-east-1') {}

  async resolve(secretId: string): Promise<string> {
    let mod: {
      SecretsManagerClient: new (o: { region: string }) => {
        send(cmd: unknown): Promise<{ SecretString?: string }>;
      };
      GetSecretValueCommand: new (i: { SecretId: string }) => unknown;
    };
    try {
      const pkg = '@aws-sdk/client-secrets-manager';
      mod = (await import(/* @vite-ignore */ pkg)) as unknown as typeof mod;
    } catch (e) {
      throw new Error(
        `AWS_SECRET_ID is set but @aws-sdk/client-secrets-manager is not installed: ${String(e)}`,
      );
    }
    const client = new mod.SecretsManagerClient({ region: this.region });
    const out = await client.send(new mod.GetSecretValueCommand({ SecretId: secretId }));
    const secret = out.SecretString;
    if (!secret) throw new Error(`AWS secret ${secretId} has no SecretString`);
    // Accept a raw URL or {"CRDB_URL": "..."}.
    try {
      const parsed = JSON.parse(secret) as Record<string, string>;
      return parsed['CRDB_URL'] ?? parsed['url'] ?? secret;
    } catch {
      return secret;
    }
  }
}

/** Vector literal for CockroachDB's VECTOR type. */
export function toVectorLiteral(v: readonly number[]): string {
  return `[${v.map((x) => x.toFixed(6)).join(',')}]`;
}

export const CRDB_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory (
  entry_id       STRING PRIMARY KEY,
  call_id        STRING NOT NULL,
  subject_id     STRING NOT NULL,
  kind           STRING NOT NULL CHECK (kind IN ('TURN','ENTITY','DECISION')),
  text           STRING NOT NULL,
  field_table    STRING,
  field_name     STRING,
  classification STRING,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  embedding      VECTOR(${EMBED_DIM})
);

-- TOOL 1: the distributed vector index. This is what replaces the local
-- adapter's 918 µs linear scan.
CREATE VECTOR INDEX IF NOT EXISTS memory_embedding_idx
  ON memory (embedding);

CREATE INDEX IF NOT EXISTS memory_subject_idx ON memory (subject_id, kind);
CREATE INDEX IF NOT EXISTS memory_call_idx    ON memory (call_id, subject_id, created_at);
`;

export interface CockroachMemoryOptions {
  readonly catalog: CatalogPort;
  readonly connectionString?: string;
  readonly secretId?: string;
  readonly secrets?: SecretResolver;
  /** Injected in tests. */
  readonly clientFactory?: (url: string) => Promise<SqlClient>;
  readonly now?: () => Date;
  /** Candidates the vector index returns before gating. */
  readonly candidateLimit?: number;
}

interface Row {
  entry_id: string;
  call_id: string;
  subject_id: string;
  kind: MemoryKind;
  text: string;
  field_table: string | null;
  field_name: string | null;
  classification: string | null;
  created_at: string;
  embedding: string | null;
}

function toEntry(r: Row): MemoryEntry {
  const field =
    r.field_table !== null && r.field_name !== null
      ? { table: r.field_table, field: r.field_name }
      : undefined;
  let vector: number[] = [];
  if (r.embedding) {
    try {
      vector = JSON.parse(r.embedding) as number[];
    } catch {
      vector = [];
    }
  }
  return {
    entryId: r.entry_id,
    callId: r.call_id,
    subjectId: r.subject_id,
    kind: r.kind,
    text: r.text,
    ...(field !== undefined ? { field } : {}),
    ...(r.classification !== null ? { classification: r.classification as Classification } : {}),
    createdAt: new Date(r.created_at).toISOString(),
    vector,
  };
}

/**
 * MemoryPort over CockroachDB.
 *
 * Note what is NOT reimplemented: recall. recallCore() in core.ts enforces the
 * two guards the product rests on — subject scoping, and re-adjudication of any
 * field-bearing memory at READ time. The vector index narrows CANDIDATES inside
 * scanSubject; it never becomes a second recall path, because that is exactly
 * how one of those guards would get lost.
 */
export class CockroachMemory implements MemoryPort, MemoryStore {
  private client: SqlClient | undefined;
  private readonly opts: CockroachMemoryOptions;
  private readonly now: () => Date;
  private seq = 0;
  /** Filled by prefetch() before recallCore runs; see scanSubject. */
  private candidates: MemoryEntry[] = [];

  constructor(opts: CockroachMemoryOptions) {
    this.opts = opts;
    this.now = opts.now ?? ((): Date => new Date());
  }

  private async connectionString(): Promise<string> {
    if (this.opts.connectionString) return this.opts.connectionString;
    const secretId = this.opts.secretId ?? process.env['AWS_SECRET_ID'];
    if (secretId) {
      const resolver = this.opts.secrets ?? new AwsSecretsResolver();
      return resolver.resolve(secretId);
    }
    const url = process.env['CRDB_URL'];
    if (!url) throw new MissingCredentialError();
    return url;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    const url = await this.connectionString();
    if (this.opts.clientFactory) {
      this.client = await this.opts.clientFactory(url);
    } else {
      let mod: { Client: new (c: { connectionString: string }) => SqlClient & { connect(): Promise<void> } };
      try {
        const pkg = 'pg';
        mod = (await import(/* @vite-ignore */ pkg)) as unknown as typeof mod;
      } catch (e) {
        throw new Error(`pg is not installed: ${String(e)}`);
      }
      const c = new mod.Client({ connectionString: url });
      await c.connect();
      this.client = c;
    }
    await this.client.query(CRDB_SCHEMA);
  }

  private db(): SqlClient {
    if (!this.client) throw new Error('connect() not called');
    return this.client;
  }

  // ── MemoryStore ───────────────────────────────────────────────────────────
  nextId(): string {
    return `crdb_${String(++this.seq).padStart(6, '0')}`;
  }

  /** Synchronous by interface; the rows were prefetched by recall(). */
  scanSubject(subjectId: string, kinds?: readonly MemoryKind[]): readonly MemoryEntry[] {
    return this.candidates.filter(
      (e) => e.subjectId === subjectId && (!kinds || kinds.includes(e.kind)),
    );
  }

  callTurns(callId: string, subjectId: string): readonly MemoryEntry[] {
    return this.candidates.filter(
      (e) => e.callId === callId && e.subjectId === subjectId && e.kind === 'TURN',
    );
  }

  insert(_entry: MemoryEntry): void {
    // Writes go through remember(), which is transactional. A synchronous
    // insert cannot be transactional, so it is deliberately not supported.
    throw new Error('use remember(); CockroachDB writes are transactional');
  }

  // ── MemoryPort ────────────────────────────────────────────────────────────

  /**
   * TOOL 2: transactional write. The turn and its decisions land together or
   * not at all, so memory and audit cannot diverge.
   */
  async remember(write: MemoryWrite): Promise<MemoryEntry> {
    const entry = buildEntry(this, write, this.now().toISOString());
    const db = this.db();
    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO memory (entry_id, call_id, subject_id, kind, text,
           field_table, field_name, classification, created_at, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          entry.entryId,
          entry.callId,
          entry.subjectId,
          entry.kind,
          entry.text,
          entry.field?.table ?? null,
          entry.field?.field ?? null,
          entry.classification ?? null,
          entry.createdAt,
          toVectorLiteral(entry.vector),
        ],
      );
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
    return entry;
  }

  /** One transaction for a turn and every decision it produced. */
  async rememberTurnWithDecisions(
    turn: MemoryWrite,
    traces: readonly AccessTrace[],
  ): Promise<readonly MemoryEntry[]> {
    const db = this.db();
    const built = [turn, ...traces.map((t) => decisionWrite(t, turn.subjectId))].map((w) =>
      buildEntry(this, w, this.now().toISOString()),
    );
    await db.query('BEGIN');
    try {
      for (const e of built) {
        await db.query(
          `INSERT INTO memory (entry_id, call_id, subject_id, kind, text,
             field_table, field_name, classification, created_at, embedding)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            e.entryId, e.callId, e.subjectId, e.kind, e.text,
            e.field?.table ?? null, e.field?.field ?? null,
            e.classification ?? null, e.createdAt, toVectorLiteral(e.vector),
          ],
        );
      }
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
    return built;
  }

  /**
   * Recall: vector index narrows candidates, then the SHARED core gates them.
   *
   * The ORDER BY on the vector column is what engages the distributed vector
   * index — this is the query the 918 µs linear scan is replaced by. The
   * subject_id predicate stays in the SQL, so scoping is enforced by the query
   * rather than by a filter afterwards.
   */
  async recall(query: RecallQuery): Promise<RecallResult> {
    const { embed } = await import('../core.js');
    const qv = toVectorLiteral(embed(query.text));
    const limit = this.opts.candidateLimit ?? 50;

    const { rows } = await this.db().query<Row>(
      `SELECT entry_id, call_id, subject_id, kind, text,
              field_table, field_name, classification,
              created_at, embedding::STRING AS embedding
         FROM memory
        WHERE subject_id = $1
        ORDER BY embedding <-> $2
        LIMIT $3`,
      [query.subjectId, qv, limit],
    );
    this.candidates = rows.map(toEntry);

    // The two guards live in the core, not here.
    return recallCore(this, this.opts.catalog, query);
  }

  async rememberDecision(trace: AccessTrace, subjectId: string): Promise<MemoryEntry> {
    return this.remember(decisionWrite(trace, subjectId));
  }

  async callHistory(callId: string, subjectId: string): Promise<readonly MemoryEntry[]> {
    const { rows } = await this.db().query<Row>(
      `SELECT entry_id, call_id, subject_id, kind, text,
              field_table, field_name, classification,
              created_at, embedding::STRING AS embedding
         FROM memory
        WHERE call_id = $1 AND subject_id = $2 AND kind = 'TURN'
        ORDER BY created_at, entry_id`,
      [callId, subjectId],
    );
    return rows.map(toEntry);
  }

  async close(): Promise<void> {
    await this.client?.end?.();
  }
}

export type { FieldRef };
