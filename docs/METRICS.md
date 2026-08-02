# METRICS — definitions before emission

Every number that appears on screen is defined here first, with its exact computation, its denominator, its sample, and what would falsify it. A number a judge can puncture is worse than no number.

Reproduction path for all four: `npm run bench` from a clean clone, network unplugged. It writes `bench/results.json` and prints the table used in the video.

---

## 1. PII reads blocked

**Claim shape:** "N restricted field reads blocked across M simulated calls."

**Counted:** one increment per `AccessTrace` with `decision = 'DENY'`. The trace log is the source — the counter is a query over `access_trace`, not a separate tally that could drift:

```sql
SELECT count(*) FROM access_trace WHERE decision = 'DENY';
```

**Repeated attempts count separately.** A caller who asks for an SSN four different ways produced four denials, and the operational question the number answers is "how many disclosure attempts did the gate stop." Deduplicating by field would understate it. Stated on screen as "blocked reads," not "unique fields blocked."

**Excluded:** `UNKNOWN` intents that never reach a field read. No decision, no trace, no increment.

**What would make it wrong:** counting denials the reasoner never actually attempted — e.g. seeding the suite with fields no intent maps to, to inflate the count. The suite is the 10 red-team cases in `packages/reasoner/src/port.ts` plus the intent map; both are in the repo and countable by hand.

---

## 2. % resolved unassisted

**Claim shape:** "X% of calls resolved without a human."

The denominator is the trap, so it is fixed here: **every call in the fixture suite that reaches a terminal state.** Not "calls the agent understood" — that would let the agent exclude its own failures and inflate the rate.

```
resolved_unassisted = calls where Turn.resolvedUnassisted && !escalatedToHuman
                      ─────────────────────────────────────────────────────────
                                    all calls reaching a terminal state
```

**A refusal is a resolution.** When the agent declines an SSN and offers the in-person records path, the call resolved correctly — that is the product working. Refusals are *not* counted as failures. This is stated out loud in the video, because a judge will otherwise assume the denominator was gamed.

**Escalation counts against us:** any turn setting `escalatedToHuman` makes the whole call assisted.

**What would make it wrong:** a fixture suite weighted toward easy hours-and-address calls. The suite composition is published in `bench/suite.json` with the intent mix visible.

---

## 3. Latency p95

**Claim shape:** "p95 decision latency Xµs on-device, Apple Silicon arm64."

**Measured:** `CatalogPort.decide()` entry → `AccessTrace` returned, via `performance.now()` at microsecond resolution. This spans classification lookup, full lineage walk, rule evaluation, and trace construction.

**Excluded, and said so on screen:** UI rendering and speech synthesis. The claim is about the *gate*, not the browser. Conflating them would be the dishonest version.

**Sample:** 10,000 decisions across the full intent map, after 500 warm-up iterations. Cold-start is reported separately as a single number; averaging cold into warm hides both.

**Hardware named:** Apple Silicon, arm64, Node v24.14.1. Arm Create's Technological Implementation is 40 of 100 points and asks for exactly this — the number is worthless without the platform attached.

**What would make it wrong:** measuring against a catalog with no lineage edges, where the walk is trivial. The Rosewood fixture has a 3-hop chain and the benchmark uses it; depth is reported alongside p95.

---

## 4. Cost per call = $0

**Claim shape:** "$0 per call. No inference bill, no data egress."

This is **not a measurement, it is a property**, and it is presented that way. A bare "$0" looks like a missing number; a "$0" with a mechanism is unpuncturable.

**Why zero:**
- The local reasoner performs no model inference — deterministic intent match and templated responses. No tokens, no provider.
- No network call leaves the machine at runtime. Verified by the offline cold-start test: network unplugged, full demo path completes.
- The catalog is local SQLite. No hosted database, no per-query cost.

**Stated bound, not a bare zero:** marginal cost per call is zero; the amortized cost is the device itself, which the clinic already owns. Any qualifying adapter (Bedrock, CockroachDB Cloud, CALL-E) introduces real per-call cost — so this claim is scoped to the local adapter **in the Arm cut only**, and is not repeated in the CockroachDB or CALL-E cuts where it would be false.

**What would make it wrong:** claiming $0 in a cut where a sponsor adapter is live. Guarded by per-event video review, and this paragraph is the reason.

---

## Not going on screen

- **"HIPAA settlements average $X."** Third-party figure we cannot reproduce from the repo. The named-cost framing stays qualitative: "a 3-provider clinic that cannot absorb a $50k settlement" is positioning, delivered as such, not as a measured claim.
- **Accuracy of intent classification.** Measurable, but on a fixture suite we authored, which makes a high number meaningless. Omitted rather than caveated.
