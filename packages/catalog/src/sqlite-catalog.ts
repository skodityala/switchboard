// PORT: CatalogPort — LOCAL ADAPTER (SQLite)
// LOCAL ADAPTER: node:sqlite (Node >=22 builtin, zero dependencies) over
//   schema.sql. Resolves classification, walks lineage, evaluates rules, emits
//   a full AccessTrace. No network, no external service.
// QUALIFYING ADAPTER: DataHub (MCP Server / Agent Context Kit) — REQUIRED before
//   submitting to DataHub. Must satisfy this same class contract.
// Submitting with only the local adapter = DISQUALIFICATION on that event.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type {
  AccessRequest,
  AccessTrace,
  CatalogPort,
  Classification,
  Decision,
  FieldRef,
  LineageHop,
  MetadataSink,
  RuleId,
} from './port.js';

// node:sqlite is a builtin, but bundlers' builtin lists can lag behind it and
// rewrite a static import to a bare specifier. createRequire sidesteps that.
// Using the builtin instead of a package is what keeps this adapter
// dependency-free, which is what makes the offline cold-start claim hold.
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

/**
 * Restriction order. Index is the comparison key: a higher index is strictly
 * more restrictive, which is what lets lineage propagation be a max().
 */
const RESTRICTION_ORDER = [
  'PUBLIC',
  'OPERATIONAL',
  'PII',
  'SENSITIVE_PII',
  'PHI',
] as const;

type DeclaredTier = (typeof RESTRICTION_ORDER)[number];

const rank = (t: DeclaredTier): number => RESTRICTION_ORDER.indexOf(t);

/** Tiers that no phone or chat channel may ever disclose, under any verification. */
const NEVER_DISCLOSABLE: ReadonlySet<Classification> = new Set<Classification>([
  'SENSITIVE_PII',
  'PHI',
]);

/** Sink that writes traces to the local audit log only. No external service. */
export class LocalMetadataSink implements MetadataSink {
  private readonly emitted: AccessTrace[] = [];
  async emit(trace: AccessTrace): Promise<void> {
    this.emitted.push(trace);
  }
  /** Contribute-back payload the DataHub adapter would push to the graph. */
  drain(): readonly AccessTrace[] {
    return this.emitted;
  }
}

export interface SqliteCatalogOptions {
  readonly schemaPath: string;
  readonly fixturePath?: string;
  /** Synthetic row values, so a leak test has something real to leak. */
  readonly dataPath?: string;
  readonly sink?: MetadataSink;
  /** Injected for determinism in tests. */
  readonly now?: () => Date;
}

export class SqliteCatalog implements CatalogPort {
  private readonly db: SqliteDb;
  private readonly now: () => Date;
  private seq = 0;
  readonly sink: MetadataSink;

  constructor(opts: SqliteCatalogOptions) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(readFileSync(opts.schemaPath, 'utf8'));
    if (opts.fixturePath) {
      this.db.exec(readFileSync(opts.fixturePath, 'utf8'));
    }
    if (opts.dataPath) {
      this.db.exec(readFileSync(opts.dataPath, 'utf8'));
    }
    this.sink = opts.sink ?? new LocalMetadataSink();
    this.now = opts.now ?? ((): Date => new Date());
  }

  /**
   * Declared tier, or UNCLASSIFIED when the catalog has never seen the field.
   * UNCLASSIFIED is the fail-closed default and is always denied — an operator
   * who adds a column and forgets to classify it gets a refusal, not a leak.
   */
  async classify(ref: FieldRef): Promise<Classification> {
    const row = this.db
      .prepare(
        'SELECT classification FROM field WHERE dataset_name = ? AND name = ?',
      )
      .get(ref.table, ref.field) as { classification: DeclaredTier } | undefined;
    return row?.classification ?? 'UNCLASSIFIED';
  }

  /**
   * Upstream lineage terminating at `ref`, with the tier each hop carries.
   * Ordered nearest-first so the panel renders the chain top-down.
   */
  async lineage(ref: FieldRef): Promise<readonly LineageHop[]> {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE up(ds, fl, depth) AS (
           SELECT ?, ?, 0
           UNION
           SELECT e.from_dataset, e.from_field, up.depth + 1
           FROM lineage_edge e
           JOIN up ON e.to_dataset = up.ds AND e.to_field = up.fl
           WHERE up.depth < 16
         )
         SELECT e.from_dataset, e.from_field, e.to_dataset, e.to_field,
                e.transform, up.depth,
                fsrc.classification AS src_tier
         FROM up
         JOIN lineage_edge e ON e.to_dataset = up.ds AND e.to_field = up.fl
         JOIN field fsrc ON fsrc.dataset_name = e.from_dataset
                        AND fsrc.name = e.from_field
         ORDER BY up.depth ASC`,
      )
      .all(ref.table, ref.field) as Array<{
      from_dataset: string;
      from_field: string;
      to_dataset: string;
      to_field: string;
      transform: string;
      src_tier: DeclaredTier;
    }>;

    return rows.map((r) => ({
      from: { table: r.from_dataset, field: r.from_field },
      to: { table: r.to_dataset, field: r.to_field },
      transform: r.transform,
      inheritedClassification: r.src_tier,
    }));
  }

  /**
   * Effective tier: the most restrictive tier anywhere upstream, including the
   * field itself. This is the rule a keyword filter cannot express — a derived
   * column classified loosely by the operator still inherits its source's tier.
   */
  private async effective(
    ref: FieldRef,
    declared: Classification,
  ): Promise<Classification> {
    if (declared === 'UNCLASSIFIED') return 'UNCLASSIFIED';
    const hops = await this.lineage(ref);
    return hops.reduce<Classification>((worst, hop) => {
      const t = hop.inheritedClassification;
      if (t === 'UNCLASSIFIED' || worst === 'UNCLASSIFIED') return worst;
      return rank(t as DeclaredTier) > rank(worst as DeclaredTier) ? t : worst;
    }, declared);
  }

  /**
   * THE GATE. The only path from a field to a response. Returns a trace for
   * every call — allow and deny share one shape, because a denial is a decision,
   * not an error.
   */
  async decide(request: AccessRequest): Promise<AccessTrace> {
    const started = performance.now();

    const declared = await this.classify(request.requested);
    const effective = await this.effective(request.requested, declared);
    const lineage = declared === 'UNCLASSIFIED' ? [] : await this.lineage(request.requested);

    const { decision, rule, rationale } = this.evaluate(request, declared, effective);

    const durationMicros = Math.round((performance.now() - started) * 1000);

    const trace: AccessTrace = {
      traceId: `tr_${String(++this.seq).padStart(6, '0')}`,
      callId: request.callId,
      utterance: request.utterance,
      intent: request.intent,
      requested: request.requested,
      resolvedClassification: declared,
      effectiveClassification: effective,
      decision,
      rule,
      rationale,
      lineage,
      channel: request.channel,
      subjectVerified: request.subjectVerified,
      decidedAt: this.now().toISOString(),
      durationMicros,
    };

    this.persist(trace);
    await this.sink.emit(trace);
    return trace;
  }

  /**
   * Rule evaluation, ordered most-restrictive-first. Exactly one rule fires and
   * it is named in the trace, so the panel can show *why* rather than just what.
   */
  private evaluate(
    request: AccessRequest,
    declared: Classification,
    effective: Classification,
  ): { decision: Decision; rule: RuleId; rationale: string } {
    // 1. Fail closed. Never seen this field ⇒ deny.
    if (effective === 'UNCLASSIFIED') {
      return {
        decision: 'DENY',
        rule: 'RULE_UNCLASSIFIED_DENY',
        rationale: `${request.requested.table}.${request.requested.field} is not in the catalog. Unclassified fields are denied by default.`,
      };
    }

    // 2. Never disclosable by phone or chat, at any verification level.
    if (NEVER_DISCLOSABLE.has(effective)) {
      const inherited = effective !== declared;
      return {
        decision: 'DENY',
        rule: 'RULE_NEVER_BY_PHONE',
        rationale: inherited
          ? `${request.requested.table}.${request.requested.field} is classified ${declared}, but inherits ${effective} through lineage. Never disclosable by phone.`
          : `${request.requested.table}.${request.requested.field} is ${effective}. Never disclosable by phone under any verification.`,
      };
    }

    // 3. PII requires a verified data subject.
    if (effective === 'PII') {
      if (!request.subjectVerified) {
        return {
          decision: 'DENY',
          rule: 'RULE_SUBJECT_UNVERIFIED',
          rationale: `${request.requested.field} is PII and the caller is not yet verified.`,
        };
      }
      if (
        request.callerSubjectId === undefined ||
        request.rowSubjectId === undefined ||
        request.callerSubjectId !== request.rowSubjectId
      ) {
        return {
          decision: 'DENY',
          rule: 'RULE_SUBJECT_MISMATCH',
          rationale: `Verified caller is not the data subject for this record.`,
        };
      }
      return {
        decision: 'ALLOW',
        rule: 'RULE_SUBJECT_SELF_ALLOW',
        rationale: `Verified data subject reading their own PII.`,
      };
    }

    // 4. Operational data requires verification, but not subject identity.
    if (effective === 'OPERATIONAL') {
      if (!request.subjectVerified) {
        return {
          decision: 'DENY',
          rule: 'RULE_SUBJECT_UNVERIFIED',
          rationale: `${request.requested.field} requires caller verification.`,
        };
      }
      return {
        decision: 'ALLOW',
        rule: 'RULE_OPERATIONAL_ALLOW',
        rationale: `Operational field released to a verified caller.`,
      };
    }

    // 5. Public.
    return {
      decision: 'ALLOW',
      rule: 'RULE_PUBLIC_ALLOW',
      rationale: `Public information.`,
    };
  }

  /** Append-only audit row. This table IS the observability artifact. */
  private persist(t: AccessTrace): void {
    this.db
      .prepare(
        `INSERT INTO access_trace (
           trace_id, call_id, utterance, intent, requested_dataset,
           requested_field, resolved_classification, effective_classification,
           decision, rule, rationale, lineage_json, channel, subject_verified,
           decided_at, duration_micros
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        t.traceId,
        t.callId,
        t.utterance,
        t.intent,
        t.requested.table,
        t.requested.field,
        t.resolvedClassification,
        t.effectiveClassification,
        t.decision,
        t.rule,
        t.rationale,
        JSON.stringify(t.lineage),
        t.channel,
        t.subjectVerified ? 1 : 0,
        t.decidedAt,
        t.durationMicros,
      );
  }

  /**
   * THE ONLY VALUE READ IN THE SYSTEM. It requires an AccessTrace and returns
   * undefined unless that trace is an ALLOW for the same field. There is no
   * overload that takes a bare FieldRef, so a caller cannot obtain a value
   * without first having passed the gate — the refusal is structural, not a
   * convention the reasoner is trusted to follow.
   */
  readValue(trace: AccessTrace, subjectId: string): string | undefined {
    if (trace.decision !== 'ALLOW') return undefined;
    const row = this.db
      .prepare(
        `SELECT value FROM row_store
         WHERE table_name = ? AND field_name = ?
           AND (subject_id = ? OR subject_id = '*')`,
      )
      .get(trace.requested.table, trace.requested.field, subjectId) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  /** Blocked-reads counter, queried from the log so it cannot drift. */
  blockedReadCount(): number {
    const row = this.db
      .prepare(`SELECT count(*) AS n FROM access_trace WHERE decision = 'DENY'`)
      .get() as { n: number };
    return row.n;
  }

  allTraces(): readonly AccessTrace[] {
    const rows = this.db
      .prepare(`SELECT * FROM access_trace ORDER BY trace_id`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      traceId: r['trace_id'] as string,
      callId: r['call_id'] as string,
      utterance: r['utterance'] as string,
      intent: r['intent'] as string,
      requested: {
        table: r['requested_dataset'] as string,
        field: r['requested_field'] as string,
      },
      resolvedClassification: r['resolved_classification'] as Classification,
      effectiveClassification: r['effective_classification'] as Classification,
      decision: r['decision'] as Decision,
      rule: r['rule'] as RuleId,
      rationale: r['rationale'] as string,
      lineage: JSON.parse(r['lineage_json'] as string) as LineageHop[],
      channel: r['channel'] as 'PHONE' | 'CHAT',
      subjectVerified: r['subject_verified'] === 1,
      decidedAt: r['decided_at'] as string,
      durationMicros: r['duration_micros'] as number,
    }));
  }

  close(): void {
    this.db.close();
  }
}
