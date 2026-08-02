// PORT: MemoryPort — LOCAL ADAPTER (SQLite + in-table vector index)
// LOCAL ADAPTER: node:sqlite (Node >=22 builtin, zero dependencies). Structured
//   state per caller plus L2-normalised vectors stored as JSON, scanned with
//   plain cosine. No network, no external service.
// QUALIFYING ADAPTER: CockroachDB — REQUIRED before submitting to
//   CockroachDB × AWS. See docs/adapters/COCKROACHDB.md.
// Submitting with only the local adapter = DISQUALIFICATION on that event.

import { createRequire } from 'node:module';
import type { AccessTrace, CatalogPort, Classification } from '@switchboard/catalog';
import {
  buildEntry,
  decisionWrite,
  recallCore,
  type MemoryStore,
} from './core.js';
import type {
  MemoryEntry,
  MemoryKind,
  MemoryPort,
  MemoryWrite,
  RecallQuery,
  RecallResult,
} from './port.js';

interface SqliteStatement {
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
  run(...args: unknown[]): unknown;
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type DatabaseSyncCtor = new (path: string) => SqliteDb;
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: DatabaseSyncCtor;
};

export const MEMORY_SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memory (
  entry_id       TEXT PRIMARY KEY,
  call_id        TEXT NOT NULL,
  -- Every read is scoped by this column. Indexed because it is in every query.
  subject_id     TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('TURN','ENTITY','DECISION')),
  text           TEXT NOT NULL,
  field_table    TEXT,
  field_name     TEXT,
  classification TEXT,
  created_at     TEXT NOT NULL,
  -- L2-normalised vector as a JSON array. A real vector index (CockroachDB's
  -- distributed vector index) replaces this scan in the qualifying adapter.
  vector         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_subject ON memory (subject_id, kind);
CREATE INDEX IF NOT EXISTS idx_memory_call    ON memory (call_id, subject_id, created_at);
`;

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
  vector: string;
}

function toEntry(r: Row): MemoryEntry {
  const field =
    r.field_table !== null && r.field_name !== null
      ? { table: r.field_table, field: r.field_name }
      : undefined;
  return {
    entryId: r.entry_id,
    callId: r.call_id,
    subjectId: r.subject_id,
    kind: r.kind,
    text: r.text,
    ...(field !== undefined ? { field } : {}),
    ...(r.classification !== null
      ? { classification: r.classification as Classification }
      : {}),
    createdAt: r.created_at,
    vector: JSON.parse(r.vector) as number[],
  };
}

export interface SqliteMemoryOptions {
  readonly catalog: CatalogPort;
  readonly now?: () => Date;
}

export class SqliteMemory implements MemoryPort, MemoryStore {
  private readonly db: SqliteDb;
  private readonly catalog: CatalogPort;
  private readonly now: () => Date;
  private seq = 0;

  constructor(opts: SqliteMemoryOptions) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(MEMORY_SCHEMA);
    this.catalog = opts.catalog;
    this.now = opts.now ?? ((): Date => new Date());
  }

  // ── MemoryStore ───────────────────────────────────────────────────────────
  nextId(): string {
    return `mem_${String(++this.seq).padStart(6, '0')}`;
  }

  insert(e: MemoryEntry): void {
    this.db
      .prepare(
        `INSERT INTO memory (entry_id, call_id, subject_id, kind, text,
           field_table, field_name, classification, created_at, vector)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        e.entryId,
        e.callId,
        e.subjectId,
        e.kind,
        e.text,
        e.field?.table ?? null,
        e.field?.field ?? null,
        e.classification ?? null,
        e.createdAt,
        JSON.stringify(e.vector),
      );
  }

  /**
   * The only read primitive. subjectId is a required parameter of the SQL, not a
   * filter applied afterwards — there is no code path that scans across callers.
   */
  scanSubject(subjectId: string, kinds?: readonly MemoryKind[]): readonly MemoryEntry[] {
    if (kinds && kinds.length > 0) {
      const marks = kinds.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT * FROM memory WHERE subject_id = ? AND kind IN (${marks})
           ORDER BY created_at, entry_id`,
        )
        .all(subjectId, ...kinds) as Row[];
      return rows.map(toEntry);
    }
    const rows = this.db
      .prepare(`SELECT * FROM memory WHERE subject_id = ? ORDER BY created_at, entry_id`)
      .all(subjectId) as Row[];
    return rows.map(toEntry);
  }

  callTurns(callId: string, subjectId: string): readonly MemoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory
         WHERE call_id = ? AND subject_id = ? AND kind = 'TURN'
         ORDER BY created_at, entry_id`,
      )
      .all(callId, subjectId) as Row[];
    return rows.map(toEntry);
  }

  // ── MemoryPort ────────────────────────────────────────────────────────────
  async remember(write: MemoryWrite): Promise<MemoryEntry> {
    const entry = buildEntry(this, write, this.now().toISOString());
    this.insert(entry);
    return entry;
  }

  /** Recall delegates wholly to core.ts — scope and re-adjudication live there. */
  async recall(query: RecallQuery): Promise<RecallResult> {
    return recallCore(this, this.catalog, query);
  }

  async rememberDecision(trace: AccessTrace, subjectId: string): Promise<MemoryEntry> {
    return this.remember(decisionWrite(trace, subjectId));
  }

  async callHistory(callId: string, subjectId: string): Promise<readonly MemoryEntry[]> {
    return this.callTurns(callId, subjectId);
  }

  /** Serialise for the browser console, scoped to one subject. */
  snapshot(subjectId: string): readonly MemoryEntry[] {
    return this.scanSubject(subjectId);
  }

  count(): number {
    const r = this.db.prepare(`SELECT count(*) AS n FROM memory`).get() as { n: number };
    return r.n;
  }

  close(): void {
    this.db.close();
  }
}
