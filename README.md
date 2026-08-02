# Switchboard

**An AI phone agent for independent clinics that structurally cannot leak patient data.**

Its data access is gated at runtime by a metadata catalog, not by a prompt.

Ask it for a patient's SSN and it says *"I don't have access to that field"* — then the policy trace shows **why**, with field-level lineage. Not because a system prompt asked it not to. Because there is no code path from a restricted field to a spoken response.

---

## The problem, named

A 3-provider independent clinic cannot absorb a $50,000 HIPAA settlement. It also cannot staff a phone line from 8am to 6pm. Every AI answering service on the market solves the second problem by creating the first: the model is given database access and a paragraph of instructions telling it to be careful.

Instructions are not a security boundary.

## What is different here

The catalog is the enforcement point, and it fails closed.

- **A field absent from the catalog is `UNCLASSIFIED`, and `UNCLASSIFIED` is denied.** An operator who adds a column and forgets to classify it gets a refusal, not a leak. There is no default-allow row in the schema.
- **Restriction propagates along lineage.** In the bundled fixture, `claim.subscriber_key` is classified `OPERATIONAL` by the clinic's own operator — but it derives from `billing_account.ssn_last4`, which derives from `patient.ssn`. The catalog walks that chain and denies at depth 3. A keyword filter on "SSN" hands this column over.
- **Every field read routes through one gate.** `CatalogPort.decide()` is the only way data enters a response — no cache, no debug helper, no test shortcut. The set of reachable reads is auditable by inspection of a static intent→field map.
- **One trace shape for allow and deny.** A denial is a decision, not an error.

## The trace record does three jobs

`AccessTrace` has three consumers and one shape:

| Consumer | Use |
|---|---|
| `render()` | the live policy-trace panel — what a judge sees first |
| `log()` | append-only audit stream over `access_trace` — the observability artifact |
| `emit()` | `MetadataSink` → contributes access decisions back to the metadata graph as usage + lineage |

The third one matters: this build does not rebuild a catalog. It is the **runtime enforcement layer a catalog doesn't ship**, and it feeds what it learns back. `emit()` sits behind the port, so the local adapter stays free of external services.

## Architecture — ports and adapters

Every external dependency sits behind a port with a local adapter. The local adapter runs fully offline; a qualifying adapter swaps in without touching callers.

| Port | Local adapter | Qualifying adapter |
|---|---|---|
| `CatalogPort` | SQLite catalog: fields → classification → lineage, emits full trace | DataHub (MCP Server / Agent Context Kit) |
| `ReasonerPort` | Deterministic scripted agent — intent match, templated responses, zero network | AWS Bedrock |
| `MemoryPort` | SQLite state + local vector index | CockroachDB (distributed vector index, MCP Server) |
| `ChannelPort` | Web chat + simulated call via browser `speechSynthesis` | CALL-E SDK |

## Runs offline

```bash
git clone https://github.com/skodityala/switchboard && cd switchboard
npm install
npm run typecheck
npm test
```

No API keys. No cloud accounts. No network calls at runtime — unplug the cable and the full demo path still completes. Built and benchmarked on Apple Silicon (arm64).

## Measured

Every on-screen number is defined in [`docs/METRICS.md`](docs/METRICS.md) before it is emitted — computation, denominator, sample size, and what would falsify it. Notably: a refusal counts as a *resolution*, not a failure, and `cost/call $0` is stated as a property with a mechanism rather than a measurement.

## Layout

```
packages/catalog/    schema.sql · CatalogPort · Rosewood clinic fixture
packages/reasoner/   ReasonerPort · intent map · red-team contract
packages/ui/         design tokens (committed before components)
docs/METRICS.md      how each number is computed
docs/TRACE-PANEL.md  hero UI layout spec
```

## License

MIT — see [`LICENSE`](LICENSE).
