# Galuxium Nexus V2 — Technical Keynote

**Deadline Aug 31, 07:30 EDT → this is an Aug 30 daytime action, not Aug 31.** $1,000 cash 1st.
Format: *"Technical Keynote (Product Demo Video), 2-to-5 minute."* Open to builders of all ages.

**Cheapest real cash left in the portfolio: a recut of an asset that already exists.**

---

## Form fields

### Project name
```
Switchboard — one policy gate, compiled once, proven identical across three reasoners
```

### Elevator pitch
```
A security boundary that exists exactly once in the codebase — and 120 assertions plus an invariant guard proving the demo cannot drift from the tests.
```

### Built with
```
typescript, node-sqlite, onnx, transformers.js, wasm, vitest, github-actions
```

### Try it out
```
https://skodityala.github.io/switchboard/console/index.html
https://github.com/skodityala/switchboard
```

---

## Description

A technical keynote on one engineering idea: **a policy gate that exists exactly once.**

Switchboard is an AI phone agent for independent clinics whose data access is gated at runtime by a metadata catalog rather than by a prompt. Ask it for a patient's SSN and it refuses; the trace shows the field-level lineage that produced the refusal.

The claim worth presenting to engineers is not the product. It is **single-implementation enforcement.**

### The problem this solves

A demo that reimplements its own rules is a demo that can lie. If the browser has one copy of the policy logic and the test suite has another, the two drift, and the version a judge sees is not the version the tests prove.

### The architecture

`core.ts` holds one implementation of restriction propagation, rule ordering, rationale wording and trace construction. Storage sits behind an interface — `CatalogGraph` for the gate, `MemoryStore` for recall, `SpeechSink` for the channel. `scripts/build-console.mjs` concatenates the **compiled** output into a 40 KB browser bundle with no bundler and no runtime dependency.

**Three reasoners** satisfy one `ReasonerPort`:

| Reasoner | Latency | Network |
|---|---|---|
| Deterministic *(default)* | p50 ~100 µs | none |
| On-device int8 transformer (WASM) | p50 0.9 ms | none after first load |
| Gemini | network-bound | per utterance |

All three produce an **identical trace shape, asserted programmatically**.

### How it is proven, not asserted

- **120 decision-parity assertions** — every catalog field × four verification states, comparing the SQLite backend against the snapshot backend the browser runs.
- **Lineage order is asserted, not just membership.** The two backends once disagreed on hop *order* — same hops, different sequence, because SQL ordered by depth while the in-memory walk used insertion order. The panel renders in trace order and the audit log stores that order, so the demo would have shown a different chain than the log recorded. An audit trail that disagrees with the operator is worse than none.
- **An invariant guard that fails if rule logic reappears in the page.** Not a snapshot of expected output — a structural check. It caught a real change during development: a function named `classifyOnDevice` tripped it. That was a name collision rather than smuggled logic, and the fix was to rename the function *and strengthen the guard*, adding checks that the page contains no tier-ranking constants and never authors the refusal sentence itself.
- **Cross-architecture CI.** The full suite and benchmark run on `ubuntu-24.04-arm` and `ubuntu-24.04` on every push. On comparable GitHub-hosted runners the arm64 target is 1.06×–1.38× faster across all seven measures; the arm64 runner also carries 2× the L2, which is disclosed as part of the platform difference rather than controlled away.

### The property that makes it interesting

Restriction propagates along field-level lineage. A column an operator classified `OPERATIONAL` is still refused when it derives from a social security number three hops upstream. An unclassified field is denied by default. **A value cannot be read without an allow decision, because the read function takes a *trace*, not a field reference** — there is no signature that bypasses the gate.

And it holds under a hostile reasoner: a model jailbroken onto every restricted intent, inventing `DUMP_ALL_PATIENT_RECORDS`, emitting injection payloads as its output — **zero leaks**, because the model was never the authority.

### Numbers, and the ones we withdrew

294 tests · 40 KB core · zero runtime dependencies · p95 decision ~117.8 µs · $0/call on the deterministic path · runs offline from a bare clone.

Four figures failed our own refutation pass and were corrected or dropped, including a memory-footprint number **withdrawn entirely** after it proved to be measurement noise. `npm run check:numbers` fails the build if a withdrawn figure reappears in prose.

---

## Judge simulation — technical keynote audience

| Criterion | Score | Reasoning |
|---|---|---|
| Technical depth | 9/10 | Single-core enforcement with parity proof is a real engineering claim, not a feature list. |
| Demo quality | 7/10 | The subject is architectural and hard to make visual. |
| Originality | 8/10 | "The demo cannot drift from the tests" is an unusual thing to prove. |
| Presentation | 7/10 | Dense; needs the keynote framing to land. |

**What would put it in the no pile:** opening on the clinic product. This audience is being asked for a *technical keynote*, and a product pitch reads as the wrong format.

**Weakest criterion: demo quality** — parity assertions do not film well.

**Change made:** chose the **parity suite as the demo beat** rather than the refusal, and led the description with the engineering claim instead of the product. The refusal appears as the thing being protected, not as the headline.

---

## Pre-flight

- [ ] Video **2–5 min** (extended cut), public, plays logged-out, captions on
- [ ] Repo public · LICENSE in About sidebar ✅
- [ ] First commit inside window ✅
- [ ] Hosted URL ✅ live
- [ ] No qualifying adapter needed ✅
- [ ] **Act Aug 30 daytime** — deadline is 07:30 EDT on Aug 31
