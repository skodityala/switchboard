# Arm Create: AI Optimization Challenge

**Deadline Aug 14, 19:00 EDT → act Aug 13, daytime. $3,000 cash.**

Rubric, verbatim: *"Technological Implementation – 40 points. Does the submission demonstrate quality software development? Does it clearly leverage Arm-powered platforms (on-device, Arm64, efficiency-minded design)? Is the technical approach sound and well executed?"* · *"User Experience / Developer Experience – 15 points."*

**Lead with the architecture, not the refusal.** This is the one event where the security story is secondary.

---

## Opening line

> Switchboard is an on-device policy engine for clinic phone agents: 39 KB of compiled code, zero runtime dependencies, zero network calls, and the entire enforcement layer for a three-provider clinic costs about **123 milliseconds of one Arm core per day**.

## Demo moment to lead

**The benchmark table, on screen, with methods.** Not the SSN refusal — that leads five other events. Here the first thing a judge should see is `npm run bench` producing the numbers live from a clean clone, followed by the working-set figure against L2.

The refusal appears at ~0:50 as *what the 123 ms buys*, not as the headline.

---

## The submission

### Measured on this machine

| Metric | Value | Method |
|---|---|---|
| Decision p50 | 84.2 µs | `decide()` entry → trace returned |
| **Decision p95** | **102.4 µs** | 10,000 iterations, 500 warm-up discarded |
| Decision p99 | 114.5 µs | same run |
| Deepest lineage walk p95 | 112.2 µs | 3-hop worst case, measured separately from the average |
| Full turn p95 | 107.7 µs | intent routing + gate + template fill |
| Cold start | 2.3 ms | schema + fixtures loaded, first decision served |
| **Throughput** | **9,764 decisions/sec/core** | 1 / p95 |
| **Clinic duty cycle** | **123 ms of one core per day** | 200 calls × 6 field reads = 1,200 decisions |
| **Working set** | **10,339 B = 0.25% of L2** | schema + fixtures vs `hw.l2cachesize` |
| Cost per call | **$0** | no model, no egress, no hosted database |

**Platform, read from the machine:** Apple M3 · arm64 · **4 performance + 4 efficiency cores** · 128-byte cache lines · 16 KB pages · 4 MB L2 · Node v24.15.0 · no network.

### Why this is Arm-appropriate, stated precisely

The honest claim is not hand-vectorised code — **there are no Arm intrinsics in this repo, and pretending otherwise would fail the first grep.** The claim is that the workload was designed to fit an Arm efficiency core:

- **The working set is 0.25% of one L2 cache.** After warm-up a decision touches no disk and no DRAM. That is why p95 holds at ~102 µs with a p99 only 12% above it — there is no memory hierarchy to fall down.
- **123 ms of CPU per day** means the enforcement layer can live on an E-core alongside everything else the device is doing. big.LITTLE is an Arm platform property; a workload with this duty cycle is what it exists for.
- **No model, so no accelerator contention.** Intent matching is deterministic and responses are templated. Nothing competes for the NPU or GPU, and there is no quantisation/accuracy tradeoff to defend.
- **`node:sqlite` is a platform builtin, not a package.** Zero runtime dependencies means nothing in the dependency tree needs an arm64 build, and there is no native module to compile per architecture. The 39 KB browser bundle is the same compiled code the tests run.

**Efficiency-minded design here is architectural, not an optimisation pass.** No profiling round produced these numbers; the absence of a model, a network hop, and a hosted database did. That is a design decision made at the start, and it is why the same binary runs offline on a clinic's own hardware.

### Quality of software development (the other half of the 40)

- 69 tests, CI on an `ubuntu-24.04-arm` runner — arm64 in CI as well as on the bench.
- **One implementation per behaviour.** The gate, gated recall, and the call state machine each exist once; storage sits behind an interface. The browser demo imports the same compiled core the tests run, verified by **120 decision-parity assertions** plus a test that fails if rule logic ever reappears in the page.
- Strict TypeScript: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- Every benchmark regenerates from a clean clone with `npm run bench`.

### Numbers we withdrew

Four figures failed our own refutation pass before shipping. Two are worth stating here because they bear on this rubric:

| Claim | Outcome | Why |
|---|---|---|
| Memory footprint | **no figure quoted** | Twice wrong — first process RSS (V8 baseline included), then a heap delta measured across the timing loop, which drifted MB-scale figures that changed on every run across runs. Measured properly it is ~1 KB median with a 1,001 KB spread: noise, not a small number. So we quote none. |
| 92% resolved unassisted | **83%** | The numerator counted an `UNKNOWN` menu fallback as resolved. |

p95 is **1,219× the measured timer noise floor** on this machine (0.084 µs for an empty `performance.now()` interval), so it is not a resolution artifact.

### Developer experience (15 points)

```bash
git clone https://github.com/skodityala/switchboard && cd switchboard
open console/index.html      # the demo. no build, no server, no network, no key
```

Then optionally: `npm install && npm test && npm run bench`. The demo works before any of that, because the bundle is committed.

---

## Judge simulation — 90 seconds, tired judge

| Criterion | Score | Reasoning |
|---|---|---|
| Technological Implementation (40) | **31/40** | Numbers are real, methods stated, platform named, CI on arm64. Held back because there is no Arm-vs-x86 comparison and no intrinsics — the leverage is architectural rather than instruction-level. |
| UX / DX (15) | 13/15 | Zero-step demo is strong. No hosted URL. |
| Remainder | — | Originality and impact carry from the product itself. |

**What put it in the no pile in the first 20 seconds:** an earlier draft opened on the SSN refusal. A judge scoring *Arm* saw a healthcare privacy demo and mentally filed it under "not an optimisation entry" before any number appeared.

**Weakest criterion:** Technological Implementation — specifically *"clearly leverage Arm-powered platforms."* Latency alone does not answer it. A skeptical judge asks "what makes this Arm rather than just a laptop app?" and an earlier draft had no answer.

**Change made:** measured and added the three Arm-specific facts that *do* answer it — P/E core topology read from `sysctl`, the working set as a percentage of L2, and the 123 ms/day clinic duty cycle. Then stated plainly that there are no intrinsics, so the claim cannot be punctured by a grep. Reframed the opening line from the refusal to the duty-cycle figure.

---

## Pre-flight

- [ ] Video ≤ event cap, public on YouTube, plays logged-out, captions on
- [ ] Repo public · `LICENSE` in the About sidebar (MIT, confirmed)
- [ ] First commit inside the window (Aug 2, 2026)
- [ ] **"Arm" and "on-device" in the first two sentences** ✅
- [ ] Benchmark table in the README matches `bench/results.json` exactly
- [ ] No qualifying adapter needed — Tier 1 only, nothing gated ✅
- [ ] Submitted **Aug 13**, ≥12h before Aug 14 19:00 EDT
