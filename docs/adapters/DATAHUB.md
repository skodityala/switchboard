# DataHub → `CatalogPort`

**Adapter due Aug 7.** Event deadline **Aug 10, 17:00 EDT**. If it is not merged on Aug 7, DataHub is dropped that day.

## What qualifying means here

Meaningful DataHub integration is scored; a local stub does not qualify. Two things to know before you design it:

**1. Don't rebuild what DataHub ships.** The rules penalise re-implementing DataHub's own features. This project is not a catalog — it is the **runtime enforcement layer** on top of one. Your adapter should *read* classification and lineage from the DataHub graph rather than mirroring them.

**2. Contribute back.** The strongest submissions *"go beyond reading metadata and contribute back to the graph where appropriate."* The `MetadataSink` on this port exists for exactly that: every access decision can be written to DataHub as usage metadata and access-decision lineage. That is the differentiator — do not skip it.

## The interface

`packages/catalog/src/port.ts` — read the whole file. The port:

```ts
export interface CatalogPort {
  decide(request: AccessRequest): Promise<AccessTrace>;
  classify(ref: FieldRef): Promise<Classification>;
  lineage(ref: FieldRef): Promise<readonly LineageHop[]>;
  readonly sink: MetadataSink;
}

export interface MetadataSink {
  emit(trace: AccessTrace): Promise<void>;   // ← contribute-back goes here
}
```

## The part that matters most

**Do not write your own `decide()`.** Implement `CatalogGraph` and delegate:

```ts
// packages/catalog/src/core.ts
export interface CatalogGraph {
  classifySync(ref: FieldRef): Classification;
  lineageSync(ref: FieldRef): readonly LineageHop[];
}
```

`adjudicate(graph, request, meta)` in `core.ts` is the single implementation of restriction propagation, rule ordering, rationale wording, and trace construction. It is what the 69 tests exercise and what the browser console runs. If you reimplement the rules against DataHub, the parity suite fails — and a page that shows different decisions than the tests prove is worse than no demo.

Your adapter supplies **storage only**: classification and lineage in, `adjudicate` decides.

### Two shape details

**Lineage direction and order.** `lineageSync(ref)` returns hops **upstream** of `ref`, nearest-first, ordered by `(depth, source key)` using plain codepoint comparison. That ordering is not cosmetic: the trace panel renders hops in trace order and the audit log stores that order, so a mismatch means the demo and the log disagree about the chain. Do not use `localeCompare` — it is locale-dependent and was a real bug here.

**Synchronous store.** `CatalogGraph` is synchronous. DataHub is a network call, so prefetch the relevant subgraph when the adapter is constructed (or per call) and serve `classifySync` / `lineageSync` from that. `SnapshotGraph` in `core.ts` is a worked example of exactly this pattern — it serves a serialised graph and is what the browser uses.

### Fail closed

A field absent from the graph must resolve to `UNCLASSIFIED`, which `adjudicate` denies. If a DataHub lookup **fails** — timeout, auth error, missing dataset — return `UNCLASSIFIED`, never a permissive default. An outage must not open the gate.

## File to create

```
packages/catalog/src/adapters/datahub.ts
```

Sketch:

```ts
// PORT: CatalogPort — QUALIFYING ADAPTER (DataHub)
// Reads classification + lineage from the DataHub graph.
// Contributes access decisions BACK as usage + lineage metadata via emit().

import { adjudicate, type CatalogGraph } from '../core.js';
import type { CatalogPort, MetadataSink, /* … */ } from '../port.js';

export class DataHubSink implements MetadataSink {
  async emit(trace: AccessTrace): Promise<void> {
    // Write to the graph: which field, which decision, which rule, when.
    // This is the contribute-back the rubric rewards. Include the lineage the
    // decision walked — that is metadata DataHub did not previously hold.
  }
}

export class DataHubCatalog implements CatalogPort, CatalogGraph {
  readonly sink: MetadataSink = new DataHubSink(/* … */);

  classifySync(ref: FieldRef): Classification {
    // From the prefetched graph. UNCLASSIFIED on absence OR on failure.
  }

  lineageSync(ref: FieldRef): readonly LineageHop[] {
    // Upstream, nearest-first, (depth, source key) order.
  }

  async decide(request: AccessRequest): Promise<AccessTrace> {
    const trace = adjudicate(this, request, {
      traceId: /* … */, decidedAt: new Date().toISOString(),
    });
    await this.sink.emit(trace);     // contribute back
    return trace;
  }
  // classify / lineage just await the sync forms
}
```

`packages/catalog/src/sqlite-catalog.ts` is the working reference.

### Mapping DataHub's model onto ours

`packages/catalog/schema.sql` deliberately mirrors a subset of a DataHub graph:

| Ours | DataHub |
|---|---|
| `dataset.urn` | dataset URN — already in DataHub URN form |
| `field.classification` | glossary term / tag on the schema field |
| `lineage_edge` | field-level (column-level) lineage |
| `access_trace` | what `emit()` contributes back |

The five tiers are `PUBLIC · OPERATIONAL · PII · SENSITIVE_PII · PHI`, plus `UNCLASSIFIED` for absence. Map DataHub's terms onto these; if the instance uses different names, put the mapping in one exported constant so it is reviewable in the PR.

## Running the tests against your adapter

```bash
npm test                     # local suite must still pass, unchanged
DATAHUB_GMS='http://…' DATAHUB_TOKEN='…' npx vitest run packages/catalog
```

The assertions your adapter must satisfy, from `packages/catalog/src/__tests__/`:

- `fail-closed default` — an unseen field is `UNCLASSIFIED`; no permissive default anywhere.
- `lineage propagates restriction` — `claim.subscriber_key` is declared `OPERATIONAL` but must resolve `SENSITIVE_PII` through `patient.ssn`, and survive a further copy into `claim_export`. **This is the demo's central case.**
- `never loosens` — effective is never less restrictive than declared, across every field.
- `core-parity.test.ts` — decisions identical to the local adapter for every field × four verification states.

The fixture that defines the expected graph is `packages/catalog/fixtures/rosewood.sql`. Load its equivalent into your DataHub instance so the same assertions apply — an ingestion recipe in the PR is welcome.

## In your PR description

- Which DataHub surface you used (MCP Server / Agent Context Kit / GMS REST) and where it is called at runtime.
- What `emit()` writes back, and a screenshot of it landing in the DataHub UI. **This is the highest-value artifact in the PR** — it is the evidence for the contribute-back criterion, and a judge who cannot see it will assume it is absent.
- Environment variables needed.
- The tier mapping, if the instance's terms differ.
- Confirmation that a DataHub outage yields `UNCLASSIFIED` and therefore a denial.
