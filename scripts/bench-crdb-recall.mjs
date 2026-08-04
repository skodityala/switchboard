#!/usr/bin/env node
/**
 * Before/after for the CockroachDB adapter's headline claim.
 *
 * The local adapter's recall is a linear scan we published as a CEILING
 * (918 µs p50 over a 220-entry history on the reference machine). This script
 * runs the IDENTICAL workload from bench/bench.ts — same corpus shape, same
 * query, same iteration count — through BOTH adapters in one process:
 *
 *   1. SqliteMemory  (linear scan, the published baseline)
 *   2. CockroachMemory (distributed vector index narrows candidates)
 *
 * and prints both, plus the EXPLAIN plan proving the vector index actually
 * serves the recall query. Numbers include the gate (re-adjudication of every
 * field-bearing hit), because that is what the product does on every recall.
 *
 * Usage:
 *   CRDB_URL='postgresql://…' node scripts/bench-crdb-recall.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const { SqliteCatalog } = await import(join(root, 'packages/catalog/dist/index.js'));
const { SqliteMemory, CockroachMemory } = await import(join(root, 'packages/memory/dist/index.js'));

const CRDB_URL = process.env.CRDB_URL;
if (!CRDB_URL) {
  console.error('set CRDB_URL to run (see docs/adapters/COCKROACHDB.md)');
  process.exit(1);
}

const catalog = new SqliteCatalog({
  schemaPath: join(root, 'packages/catalog/schema.sql'),
  fixturePath: join(root, 'packages/catalog/fixtures/rosewood.sql'),
  dataPath: join(root, 'packages/catalog/fixtures/rosewood-data.sql'),
});

/** The corpus generator from bench/bench.ts, parameterised by size. */
function corpusEntry(i) {
  return {
    callId: `call_${i % 20}`,
    subjectId: 'p_1001',
    kind: i % 3 === 0 ? 'ENTITY' : 'TURN',
    text: `caller asked about ${['refill', 'appointment', 'balance', 'hours', 'records'][i % 5]} on visit ${i}`,
    ...(i % 3 === 0
      ? { field: { table: 'appointment', field: 'starts_at' }, classification: 'OPERATIONAL' }
      : {}),
  };
}

function restrictedEntry(i) {
  return {
    callId: 'call_old', subjectId: 'p_1001', kind: 'ENTITY',
    text: `social security number reference ${i}`,
    field: { table: 'patient', field: 'ssn' }, classification: 'SENSITIVE_PII',
  };
}

/** bench.ts shape: n mixed + n/10 restricted. n=200 reproduces the 220 corpus. */
async function seed(mem, n) {
  for (let i = 0; i < n; i++) await mem.remember(corpusEntry(i));
  for (let i = 0; i < n / 10; i++) await mem.remember(restrictedEntry(i));
}

/** Bulk seed for CockroachDB: same rows, batched — seeding is not the metric. */
async function seedCrdbBulk(raw, embed, toVectorLiteral, n) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(corpusEntry(i));
  for (let i = 0; i < n / 10; i++) rows.push(restrictedEntry(i));
  const now = new Date().toISOString();
  const B = 200;
  for (let off = 0; off < rows.length; off += B) {
    const chunk = rows.slice(off, off + B);
    const values = [];
    const params = [];
    chunk.forEach((w, j) => {
      const base = j * 10;
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`);
      params.push(
        `bulk_${String(off + j).padStart(8, '0')}`, w.callId, w.subjectId, w.kind, w.text,
        w.field?.table ?? null, w.field?.field ?? null, w.classification ?? null,
        now, toVectorLiteral(embed(w.text)),
      );
    });
    await raw.query(
      `INSERT INTO memory (entry_id, call_id, subject_id, kind, text,
         field_table, field_name, classification, created_at, embedding)
       VALUES ${values.join(',')}`,
      params,
    );
  }
}

const QUERY = {
  subjectId: 'p_1001', text: 'what did I ask about my refill',
  callId: 'call_bench', channel: 'PHONE', subjectVerified: true, limit: 5,
};

async function measure(mem, iterations = 500) {
  const micros = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await mem.recall(QUERY);
    micros.push((performance.now() - t0) * 1000);
  }
  micros.sort((a, b) => a - b);
  const at = (p) => Math.round(micros[Math.floor((p / 100) * micros.length)]);
  return { p50: at(50), p95: at(95), iterations };
}

const memoryDist = await import(join(root, 'packages/memory/dist/index.js'));
const coreDist = await import(join(root, 'packages/memory/dist/core.js'));

const { Client } = await import('pg');
const raw = new Client({ connectionString: CRDB_URL });
await raw.connect();

const SIZES = [200, 10_000]; // 200 → the published 220-entry corpus shape

console.log('\n=== RECALL, 500 iterations per point, gate included on every hit ===');
console.log('  corpus | SqliteMemory (linear scan) | CockroachMemory (vector index)');

let lastSanity = null;
for (const n of SIZES) {
  const sqlite = new SqliteMemory({ catalog });
  await seed(sqlite, n);
  const before = await measure(sqlite);
  const sanityA = await sqlite.recall(QUERY);
  sqlite.close();

  const crdb = new CockroachMemory({ catalog, connectionString: CRDB_URL });
  await crdb.connect();
  await raw.query('DELETE FROM memory');
  await seedCrdbBulk(raw, coreDist.embed, memoryDist.toVectorLiteral, n);
  const after = await measure(crdb);
  const sanityB = await crdb.recall(QUERY);
  await crdb.close();
  lastSanity = { sanityA, sanityB };

  console.log(
    `  ${String(n + n / 10).padStart(6)} | p50 ${String(before.p50).padStart(6)} µs · p95 ${String(before.p95).padStart(6)} µs | ` +
    `p50 ${String(after.p50).padStart(6)} µs · p95 ${String(after.p95).padStart(6)} µs`,
  );
}

const { sanityA, sanityB } = lastSanity;
console.log(
  `  sanity @10k: sqlite hits ${sanityA.hits.length} withheld ${sanityA.withheld.length} scanned ${sanityA.scanned} | ` +
  `crdb hits ${sanityB.hits.length} withheld ${sanityB.withheld.length} scanned ${sanityB.scanned}`,
);

// The proof the index serves the query, not just that it exists.
const { rows: plan } = await raw.query(
  `EXPLAIN SELECT entry_id FROM memory
    WHERE subject_id = $1
    ORDER BY embedding <-> $2 LIMIT 50`,
  ['p_1001', `[${Array.from({ length: 128 }, () => '0.01').join(',')}]`],
);
await raw.end();

console.log('\n=== EXPLAIN: the plan serving the recall query at 11,000 rows ===');
for (const r of plan) console.log(`  ${Object.values(r)[0]}`);
