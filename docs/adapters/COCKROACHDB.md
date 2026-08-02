# CockroachDB → `MemoryPort`

**Adapter due Aug 16.** Event deadline **Aug 18, 17:00 EDT**. Team cap ≤ 5.

## What qualifying means here

The rules require **≥ 2 CockroachDB tools** plus **≥ 1 AWS service**, used at runtime. The five judging criteria are verbatim in the repo README; criterion 1 is the one this adapter answers:

> *"Agentic Memory Design — Does CockroachDB play a meaningful, production-grade role as the agent's memory layer? Is it used for more than toy queries — state, embeddings, context, or transactional data at real scale?"*

"More than toy queries" is the bar to clear. Three things in this design help, and it is worth building the PR so they are visible:

- **Vector search** — the distributed vector index replacing a local cosine scan is the headline. This is tool #1.
- **Transactional writes** — a turn, its resolved entities and its access decisions are one logical unit. Write them in a single transaction and the "transactional data" phrase in the criterion is literally satisfied.
- **One substrate for memory and audit** — `DECISION` entries mean the audit trail is the same table as the memory. That is also the answer to criterion 4 ("secure, observable"), so do not split it into two tables.

Pick your second tool from: **MCP Server**, **ccloud CLI**. Whichever it is, it has to run — a CLI invoked during setup only is weaker evidence than one used in the flow. Say in the PR which two you used and where they are called.

## The interface

`packages/memory/src/port.ts` — read the whole file, it is ~120 lines. Four methods:

```ts
export interface MemoryPort {
  remember(write: MemoryWrite): Promise<MemoryEntry>;
  recall(query: RecallQuery): Promise<RecallResult>;
  rememberDecision(trace: AccessTrace, subjectId: string): Promise<MemoryEntry>;
  callHistory(callId: string, subjectId: string): Promise<readonly MemoryEntry[]>;
}
```

## The part that matters most

**Do not write your own `recall()` logic.** Implement `MemoryStore` and delegate:

```ts
// packages/memory/src/core.ts
export interface MemoryStore {
  insert(entry: MemoryEntry): void;
  scanSubject(subjectId: string, kinds?: readonly MemoryKind[]): readonly MemoryEntry[];
  callTurns(callId: string, subjectId: string): readonly MemoryEntry[];
  nextId(): string;
}
```

`recallCore(store, catalog, query)` in `core.ts` enforces two guards that the product's entire thesis rests on:

1. **Scope.** Candidates come only from `scanSubject(query.subjectId)`. A caller cannot reach another caller's memory, because the read primitive has no cross-subject form.
2. **Re-adjudication.** A memory that names a catalog field goes back through `CatalogPort.decide()` at read time, so a memory written while a field was permissive is withheld once it is reclassified.

If you reimplement recall against CockroachDB directly, you will lose one of these and the isolation tests will fail. **The vector index belongs inside `scanSubject`**, narrowing the candidate set — not inside a new recall path.

### The one shape change you may need

`MemoryStore` is synchronous because SQLite is. A network round-trip is not. Two options, in order of preference:

**(a) Prefetch.** `scanSubject` returns a candidate set you fetched into memory for the current call. For a single caller's history this is small, and it keeps `recallCore` untouched.

**(b) Async store.** If you need `await` inside the store, add `MemoryStoreAsync` alongside the existing interface and an `recallCoreAsync` that mirrors `recallCore` exactly — same two guards, same order, same `WithheldMemory` shape with no text. Do not delete or alter the sync path; the browser console uses it. Flag this in the PR so the duplication gets reviewed rather than becoming a second implementation by accident.

## File to create

```
packages/memory/src/adapters/cockroachdb.ts
```

Sketch:

```ts
// PORT: MemoryPort — QUALIFYING ADAPTER (CockroachDB)
// Tools used at runtime: <distributed vector index> + <MCP Server | ccloud CLI>
// AWS service used at runtime: <e.g. Bedrock via ReasonerPort, or S3/Secrets Manager>

import { recallCore, buildEntry, decisionWrite, type MemoryStore } from '../core.js';
import type { MemoryPort, /* … */ } from '../port.js';

export class CockroachMemory implements MemoryPort, MemoryStore {
  // connection from env: CRDB_URL / CRDB_CLUSTER / etc.

  nextId(): string { /* … */ }
  insert(entry: MemoryEntry): void { /* … */ }

  // The vector index goes HERE — narrow candidates, still subject-scoped.
  scanSubject(subjectId: string, kinds?: readonly MemoryKind[]): readonly MemoryEntry[] { /* … */ }

  callTurns(callId: string, subjectId: string): readonly MemoryEntry[] { /* … */ }

  async recall(query: RecallQuery) { return recallCore(this, this.catalog, query); }
  // remember / rememberDecision / callHistory mirror SqliteMemory
}
```

`packages/memory/src/sqlite-memory.ts` is the working reference. Same structure, different storage.

### Schema

`MEMORY_SCHEMA` in `sqlite-memory.ts` is the column set. For CockroachDB, change:

- `vector TEXT` (JSON) → a real `VECTOR(128)` column with a distributed vector index. `EMBED_DIM` is 128, exported from `core.ts`.
- Keep `subject_id` indexed and in every query.
- Keep the `kind` check constraint: `TURN | ENTITY | DECISION`.

Vectors come from `embed(text)` in `core.ts` — hashed lexical, deterministic, no model. **Keep using it.** If you substitute a hosted embedding model, the offline demo and the $0-per-call claim both break, and both are load-bearing at other events in this portfolio.

## Running the tests against your adapter

The suite is written against the interface. Point it at your adapter:

```bash
# 1. the local suite must still pass, unchanged
npm test

# 2. your adapter against the same assertions
CRDB_URL='postgresql://…' npx vitest run packages/memory
```

To reuse the existing assertions, export a factory from your test file and swap the constructor in a copy of `packages/memory/src/__tests__/memory.test.ts`. The tests that must pass:

- `CROSS-CALLER ISOLATION` — all five. **These are the ones that matter.** A caller asking with another caller's exact words must not reach their rows, and `scanned` must count only their own.
- `memory is re-adjudicated at READ time` — including the lineage flank: a memory of `claim.subscriber_key` written as `OPERATIONAL` must be withheld as `SENSITIVE_PII` with ≥3 lineage hops.
- `recall actually recalls` — continuity across calls.
- `memory and audit are one substrate` — a `DECISION` entry is recallable and itself gated.

## In your PR description

- Which **two** CockroachDB tools, and the file and line where each is called at runtime.
- Which **AWS service**, same detail.
- Environment variables needed.
- Whether you used prefetch (a) or an async store (b).
- A short trace or screenshot showing the vector index serving a query — criterion 2 asks whether the tools are used *correctly*, and a judge who cannot see it will assume it is not there.
