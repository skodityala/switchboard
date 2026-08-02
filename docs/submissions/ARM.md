# Arm Create: AI Optimization Challenge — **Track 3 (Mobile AI)**

**Deadline Aug 14, 19:00 EDT → act Aug 13, daytime.**
**Prize pool $8,000:** Overall $3,000 · Runner-up $2,000 · Best in Category $1,000 × 3.
Track selection competes for two prizes, so **Track 3 is stated in the first sentence of the submission.**

Weights: **Technological Implementation 40 · "WOW" factor 25 · Potential Impact 20 · UX/DX 15.**

---

## Track selection

**Track 3 — Mobile AI.** *"AI inference running fully on-device… laptops and PCs… low-latency, private, and offline-capable."*

That description is this project literally: a quantized transformer running in-browser via WASM on Apple Silicon, no server, no API key, no data leaving the machine.

---

## Opening line

> Switchboard runs a real int8 transformer **fully on-device** — in the browser, over WASM, on arm64 — and its entire purpose is to prove that an AI agent **cannot leak patient data even when the model is compromised.** Click one button in the demo and the model loads in your own tab; then try to make it leak.

## Lead demo moment — WOW (25 points)

**The compromised model.** Not the refusal alone: a *jailbroken reasoner* forced onto every restricted intent, inventing `DUMP_ALL_PATIENT_RECORDS`, returning injection payloads — and leaking nothing, because the model was never the authority.

---

## Technological Implementation (40)

### Real on-device inference, measured on this machine

| Metric | Value | Method |
|---|---|---|
| Model | all-MiniLM-L6-v2, **int8 ONNX, 23.7 MB** | quantized; downloaded once |
| Load (Node) | **281 ms** | cold, from local disk |
| Inference p50 / p95 | **0.9 ms / 2.6 ms** | 50 runs, warm, arm64 |
| Embedding | 384-dim | mean-pooled, L2-normalised |
| **Proven offline** | inference succeeds with `globalThis.fetch` **replaced by a throwing stub** | `allowRemoteModels=false` |

**Platform:** Apple M3 · arm64 · 4 performance + 4 efficiency cores · 128-byte cache lines · 16 KB pages · Node v24.15.0.

### The gate, which is the actual engineering

| Metric | Value | Method |
|---|---|---|
| Decision p50 / **p95** / p99 | 84.2 / **102.4** / 114.5 µs | 10,000 iterations, 500 warm-up discarded |
| Deepest lineage walk p95 | 112.2 µs | 3-hop worst case, measured separately |
| Throughput | **9,764 decisions/sec/core** | 1 / p95 |
| **Clinic duty cycle** | **123 ms of one core per day** | 200 calls × 6 field reads |
| **Working set** | **10,339 B = 0.25% of L2** | vs `hw.l2cachesize` |

Decision p95 is **1,219× the measured timer noise floor** (0.084 µs), so it is not a resolution artifact.

### Three reasoners, one gate

| Reasoner | Latency | Network | Cost/call |
|---|---|---|---|
| Deterministic *(default)* | p50 100 µs | none | $0 |
| **On-device model** | p50 0.9 ms | **none after first load** | $0 |
| Gemini | network-bound | per utterance | metered |

All three implement one `ReasonerPort` and produce an **identical trace shape, asserted programmatically**. Storage sits behind `CatalogGraph`; the browser executes the same compiled `core.ts` the tests run — **120 decision-parity assertions** across every field × four verification states, plus a test that **fails if rule logic ever appears in the page**.

That guard caught a real change during this build: a function named `classifyOnDevice` tripped it. A name collision rather than smuggled logic — but the fix was to rename the function and *strengthen* the guard, adding checks that the page contains no tier-ranking constants and never authors the refusal sentence itself.

### A correctness defect worth naming

The Gemini adapter's output sanitiser stripped `[^A-Z_]`, which silently turned `ASK_SSN_LAST4` into `ASK_SSN_LAST`, matched nothing, and fell through to `UNKNOWN`. **Safe by accident, but wrong** — a valid classification vanished. Fixed by preserving digits and adding a longest-match containment fallback, then **attacked with seven hostile model outputs** (`CLINIC_HOURS ASK_SSN`, concatenations, an HTML-comment smuggle). Zero leaks: containment can change *which* field is requested, never whether it is allowed.

---

## WOW factor (25) — the compromised model

Every AI product claims guardrails. This one is testable in the demo, by the judge, in ten seconds.

The model does not hold authority. It proposes an intent; a metadata catalog decides. So we test the worst case directly — a model that has been **fully compromised**:

- forced onto `ASK_SSN` for every input → **denied every time**
- cycled through all six restricted intents → **all denied**
- inventing `DUMP_ALL_PATIENT_RECORDS` → `UNKNOWN`, reads nothing
- returning `Sure! Here is the SSN: 539-88-4021` → **no leak**
- injection payloads as model output → **no leak**

The lineage flank holds when the *model* picks the field: `claim.subscriber_key` is classified `OPERATIONAL` **by the clinic's own operator**, but derives from `patient.ssn` three hops upstream, so it is refused as `SENSITIVE_PII`. A keyword filter hands that column over. A prompt cannot catch it. **Lineage propagation can.**

Same harness runs against the on-device model and against Gemini. One gate, three reasoners, zero leaks.

---

## Potential Impact (20) — the reusable artifacts

The criterion asks whether the project *"creates reusable artifacts"*. **The port interface plus three working adapters and their runbooks IS the artifact**, and it is in the repo, not promised:

| Artifact | What it is |
|---|---|
| `ReasonerPort` + 3 adapters | deterministic · on-device WASM · Gemini — swap without touching callers |
| `CatalogPort` + `CatalogGraph` | storage-agnostic policy gate; SQLite and snapshot backends |
| `MemoryPort` + gated recall | per-caller scoping and read-time re-adjudication |
| `ChannelPort` + Caspian adapter | one handler, many channels |
| `docs/adapters/*.md` | five-line runbooks: env var, file, command, what proves it qualified |

Anyone building a healthcare voice agent can lift the gate wholesale. The named beneficiary: a **3-provider independent clinic** that cannot staff a phone line 8am–6pm and cannot absorb a $50,000 HIPAA settlement — and for whom on-device means patient data never leaves the building.

---

## UX / DX (15)

**Clone to refusal: zero build steps.**

```bash
git clone https://github.com/skodityala/switchboard && cd switchboard
open console/index.html      # runs immediately — no npm, no server, no key
```

The deterministic path loads instantly and works offline. **One button** loads the on-device model (37 MB, measured: 0.4 MB runtime ESM + 12.9 MB ONNX-runtime WASM binary + 23.7 MB int8 model) and inference moves in-tab. The active reasoner and its live latency are displayed, so the switch is visible rather than described.

For developers: `npm test` (105 tests), `npm run bench` regenerates every number above, `npm run check:numbers` fails if any withdrawn figure reappears in prose.

---

## Headline numbers, scoped honestly

- **40 KB** core bundle, **zero runtime dependencies**, deterministic path — this is the default.
- **23.7 MB** int8 model, **37 MB** total first load, opt-in.
- **$0/call and offline** describe the deterministic default *and* the on-device path after first load.

**Footnote, disclosed rather than buried:** the *Node* on-device path pulls `@huggingface/transformers`, which brings `onnxruntime-node` transitively — **380 MB installed**. It is an **optional peer dependency**: `npm install` does not fetch it, typecheck and all 105 tests pass without it, and the browser path never touches it (the web build has zero `onnxruntime-node` imports). The default product is 40 KB with zero dependencies; the 380 MB is one opt-in developer path.

**The deterministic reasoner performs no inference, and this submission does not claim otherwise.** Track 3's requirement is carried by the on-device tier. The progression is the point: with no model it is free and instant; with a model it is still offline; with a *hostile* model it still cannot leak.

---

## Judge simulation — 90 seconds, 200 submissions deep

| Criterion | Score | Reasoning as a tired judge |
|---|---|---|
| Technological Implementation (40) | **33/40** | Real quantized inference on arm64, offline proven by stubbing fetch, three adapters behind one port, 120 parity assertions, CI on `ubuntu-24.04-arm`. Held back: no NEON/SIMD intrinsics, no Arm-vs-x86 comparison — the leverage is architectural, not instruction-level. |
| WOW (25) | **21/25** | The compromised model is genuinely memorable and judge-testable. Loses points because the *first* thing on screen is a clinic phone demo; the WOW needs one click to reach. |
| Potential Impact (20) | **15/20** | Reusable artifacts are real and documented. Healthcare-voice is a narrower blast radius than a general-purpose optimisation would be. |
| UX/DX (15) | **13/15** | Zero-install demo is strong. No hosted URL. |

**What put it in the no pile in the first 20 seconds:** an earlier draft opened on the SSN refusal — a *privacy* demo. A judge scoring an Arm **optimisation** challenge files that under "wrong contest" before any number appears.

**Weakest criterion: Technological Implementation**, and specifically *"does it clearly leverage Arm-powered platforms?"* Inference latency alone does not answer that; a skeptic asks "what makes this Arm rather than a laptop app?"

**Changes made in response:**
1. Opening line now leads with **on-device inference on arm64**, not the refusal.
2. Added the three Arm-specific facts that actually answer the question — P/E core topology from `sysctl`, working set at **0.25% of L2**, and the **123 ms/day** duty cycle — and stated plainly that there are **no intrinsics**, so a grep cannot puncture the claim.
3. Made the WOW reachable in one click by wiring in-page WASM inference, so a judge sees deterministic → on-device → still-refused without installing anything.

Re-run after those changes still finds Technological Implementation weakest — that is honest, since we are an *architecture* entry in an *optimisation* contest, and the fix would be a genuine Arm-vs-x86 benchmark that this machine cannot produce.

---

## Mechanical checklist

- [ ] **Track 3 selected explicitly** on the submission form ⚠️ *the one thing that voids an otherwise-complete entry*
- [ ] Video ≤ event cap, public on YouTube, plays logged-out, captions on
- [ ] Repo public · `LICENSE` renders in the About sidebar (MIT, confirmed)
- [ ] First commit inside the window (Aug 2, 2026)
- [ ] "Arm", "on-device" and "Track 3" in the first two sentences ✅
- [ ] Every number matches `bench/results.json` — run `npm run check:numbers`
- [ ] **No qualifying adapter needed — nothing key-gated** ✅
- [ ] Submitted **Aug 13**, ≥12h before Aug 14 19:00 EDT
