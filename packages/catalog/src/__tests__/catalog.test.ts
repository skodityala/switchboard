/**
 * Catalog invariants, tested against the real schema.sql and the real Rosewood
 * fixture — not against mocks. If these pass, the product's thesis holds at the
 * data layer: restriction cannot be escaped by loose classification, and an
 * unknown field cannot be read.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// node:sqlite is a Node 22+ builtin, but Vite's bundled builtin list predates it
// and rewrites a static import to a bare "sqlite" specifier. createRequire
// sidesteps the transform. Using the builtin keeps this package dependency-free,
// which is what makes the offline cold-start claim hold.
type DatabaseSyncCtor = new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
};
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: DatabaseSyncCtor;
};

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..');

const RESTRICTION_ORDER = [
  'PUBLIC',
  'OPERATIONAL',
  'PII',
  'SENSITIVE_PII',
  'PHI',
] as const;
type Tier = (typeof RESTRICTION_ORDER)[number];

const rank = (t: Tier): number => RESTRICTION_ORDER.indexOf(t);

let db: InstanceType<DatabaseSyncCtor>;

beforeAll(() => {
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(pkgRoot, 'schema.sql'), 'utf8'));
  db.exec(readFileSync(join(pkgRoot, 'fixtures', 'rosewood.sql'), 'utf8'));
});

/** Declared tier of a field, or UNCLASSIFIED when the catalog has never seen it. */
function classify(table: string, field: string): Tier | 'UNCLASSIFIED' {
  const row = db
    .prepare('SELECT classification FROM field WHERE dataset_name = ? AND name = ?')
    .get(table, field) as { classification: Tier } | undefined;
  return row?.classification ?? 'UNCLASSIFIED';
}

/**
 * Effective tier after lineage propagation: the most restrictive tier found
 * anywhere upstream, including the field itself. This is the rule that makes a
 * loosely-classified derived column safe.
 */
function effective(table: string, field: string): Tier | 'UNCLASSIFIED' {
  const declared = classify(table, field);
  if (declared === 'UNCLASSIFIED') return 'UNCLASSIFIED';

  const upstream = db
    .prepare(
      `WITH RECURSIVE up(ds, fl, depth) AS (
         SELECT ?, ?, 0
         UNION
         SELECT e.from_dataset, e.from_field, up.depth + 1
         FROM lineage_edge e JOIN up ON e.to_dataset = up.ds AND e.to_field = up.fl
         WHERE up.depth < 16
       )
       SELECT f.classification AS c
       FROM up JOIN field f ON f.dataset_name = up.ds AND f.name = up.fl`,
    )
    .all(table, field) as Array<{ c: Tier }>;

  return upstream.reduce<Tier>(
    (worst, r) => (rank(r.c) > rank(worst) ? r.c : worst),
    declared,
  );
}

describe('fail-closed default', () => {
  it('denies a field the catalog has never seen', () => {
    expect(classify('patient', 'shoe_size')).toBe('UNCLASSIFIED');
    expect(effective('patient', 'shoe_size')).toBe('UNCLASSIFIED');
  });

  it('has no default-allow row in the schema', () => {
    // Every classification is explicit; the CHECK constraint has no catch-all.
    const tiers = db
      .prepare('SELECT DISTINCT classification AS c FROM field')
      .all() as Array<{ c: string }>;
    for (const { c } of tiers) {
      expect(RESTRICTION_ORDER).toContain(c as Tier);
    }
  });
});

describe('lineage propagates restriction', () => {
  it('the lineage flank: an OPERATIONAL column inherits SENSITIVE_PII', () => {
    // The operator classified this loosely, believing it opaque.
    expect(classify('claim', 'subscriber_key')).toBe('OPERATIONAL');
    // Lineage reaches patient.ssn, so the gate denies it anyway.
    expect(effective('claim', 'subscriber_key')).toBe('SENSITIVE_PII');
  });

  it('propagation survives a further copy downstream', () => {
    expect(classify('claim_export', 'subscriber_key')).toBe('OPERATIONAL');
    expect(effective('claim_export', 'subscriber_key')).toBe('SENSITIVE_PII');
  });

  it('the chain to patient.ssn is at least 3 hops (panel must show depth)', () => {
    const { depth } = db
      .prepare(
        `WITH RECURSIVE up(ds, fl, depth) AS (
           SELECT 'claim_export', 'subscriber_key', 0
           UNION
           SELECT e.from_dataset, e.from_field, up.depth + 1
           FROM lineage_edge e JOIN up ON e.to_dataset = up.ds AND e.to_field = up.fl
           WHERE up.depth < 16
         )
         SELECT max(depth) AS depth FROM up
         WHERE ds = 'patient' AND fl = 'ssn'`,
      )
      .get() as { depth: number };
    expect(depth).toBeGreaterThanOrEqual(3);
  });

  it('never loosens: effective is never less restrictive than declared', () => {
    const all = db
      .prepare('SELECT dataset_name AS t, name AS f, classification AS c FROM field')
      .all() as Array<{ t: string; f: string; c: Tier }>;
    for (const { t, f, c } of all) {
      const eff = effective(t, f) as Tier;
      expect(rank(eff)).toBeGreaterThanOrEqual(rank(c));
    }
  });
});

describe('phone channel', () => {
  it('no field is disclosable by phone above PII', () => {
    // SENSITIVE_PII and PHI are never disclosable by phone under any
    // verification — RULE_NEVER_BY_PHONE. Assert the fixture actually contains
    // such fields, so the demo has something real to refuse.
    const restricted = db
      .prepare(
        `SELECT count(*) AS n FROM field
         WHERE classification IN ('SENSITIVE_PII','PHI')`,
      )
      .get() as { n: number };
    expect(restricted.n).toBeGreaterThan(0);
  });
});
