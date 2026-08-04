# CockroachDB adapter — validated against a real cluster (local, v25.2.22)

**Date:** 2026-08-03. **Cluster:** CockroachDB CCL v25.2.22, single node via Docker
(`cockroachdb/cockroach:latest-v25.2 start-single-node`). Not the cloud cluster the
event submission will use — this validation exists so the cloud swap is a
connection-string change, not an integration debug. Everything below reproduces with:

```bash
docker run -d --name crdb-local -p 26257:26257 cockroachdb/cockroach:latest-v25.2 \
  start-single-node --insecure
npm install --no-save pg
CRDB_LIVE=1 CRDB_URL='postgresql://root@localhost:26257/switchboard?sslmode=disable' \
  npx vitest run packages/memory          # 45/45 pass
CRDB_URL='postgresql://root@localhost:26257/switchboard?sslmode=disable' \
  node scripts/bench-crdb-recall.mjs      # the numbers below
```

## Three defects only a real cluster could catch

1. **Vector indexes sit behind a feature gate** on self-hosted v25.2 —
   `CREATE VECTOR INDEX` fails with *"vector indexes are not enabled"* until
   `feature.vector_index.enabled` is set. `connect()` now sets it best-effort
   (wrapped: on managed clusters where the setting is preset or restricted,
   the failure is ignored and the schema statement itself decides).

2. **Per-process entry IDs collide against a persistent table.** The scaffolded
   `nextId()` was `crdb_000001…`, which works for in-memory stores and fails on
   the second run against a table that outlives the process (`duplicate key value
   violates unique constraint "memory_pkey"` — a judge's second demo run).
   IDs are now time-prefixed + process counter + entropy, so lexicographic order
   still follows insert order.

3. **A bare `(embedding)` vector index is never used for subject-scoped recall.**
   The planner answered `WHERE subject_id = $1 ORDER BY embedding <-> $2 LIMIT 50`
   with a FULL SCAN + exact top-k — the "distributed vector index" would have been
   decorative at demo time. The index now declares `subject_id` as a **prefix
   column** (`CREATE VECTOR INDEX … ON memory (subject_id, embedding)`), which both
   engages C-SPANN vector search and puts caller isolation inside the index
   structure: a vector search physically cannot range over another caller's rows.

## Before/after, honestly

Same corpus generator, same query, same 500 iterations as `bench/bench.ts`;
recall includes the gate (every field-bearing hit re-adjudicated). Local Docker,
Apple M-series, network round-trip included in the CockroachDB numbers.

| corpus | SqliteMemory (linear scan) | CockroachMemory (vector index) |
|---|---|---|
| 220 | p50 527 µs · p95 681 µs | p50 3,964 µs · p95 4,768 µs |
| 11,000 | p50 34,548 µs · p95 38,542 µs | **p50 8,530 µs · p95 10,938 µs** |

**At the published 220-entry corpus the linear scan wins** — the network
round-trip dominates, and we say so. The index is a scale claim, not a
small-corpus claim: the scan grows linearly with history (`scanned 11000`),
the index does not (`scanned 50`, its candidate limit), and the crossover is
already 4× at 11k entries.

## The plan, proving the index serves the query

```
• top-k
│ k: 50
└── • lookup join
    │ table: memory@memory_pkey
    └── • vector search
          table: memory@memory_subject_embedding_idx
          target count: 50
          prefix spans: [/'p_1001' - /'p_1001']
```

(Captured through the adapter's own parameterized query. On a freshly created
table the planner may briefly prefer a full scan until auto-stats collect;
`CREATE STATISTICS x FROM memory` forces it immediately.)

## Still open for the event (needs accounts)

- CockroachDB **Cloud** cluster + rerun of both commands above (URL swap).
- Second CockroachDB tool decision for the rules screen: MCP Server or `ccloud`
  CLI used in-flow (transactional writes + vector index are the load-bearing two,
  but the rules text asks for tools from their list).
- AWS Secrets Manager (`AWS_SECRET_ID`) on the connection path — wired, needs credentials.
