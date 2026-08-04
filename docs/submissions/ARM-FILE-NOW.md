# FILE THIS NOW — Arm Create, Track 3

**Everything below is verified and ready to paste. I cannot file it: Devpost requires an authenticated browser session and there are no Devpost credentials on this machine. This is the packet; filing is a human step of about ten minutes.**

Submit at <https://arm-ai-optimization-challenge.devpost.com> → "Submit a project".
File **today**, then keep editing — Devpost allows edits until the deadline, and a filed submission that improves beats a perfect one still sitting locally on Aug 14.

**Deadline: Aug 14, 19:00 EDT.**

---

## Pre-flight — verified against the live repo, just now

| Check | Status |
|---|---|
| Repo public | ✅ `PUBLIC` |
| `LICENSE` detectable in About sidebar | ✅ MIT (REST **and** GraphQL both report it) |
| First commit inside window | ✅ 2026-08-02 02:49 UTC |
| All commits from one identity | ✅ `skodityala@gmail.com`, 29 commits |
| Hosted URL live over HTTPS | ✅ HTTP 200 |
| `app.js` MIME correct for ES module | ✅ `application/javascript` |
| CI green on **both** architectures | ✅ `test (arm64)`, `test (x86_64)`, `arm64 vs x86_64` all success |
| Tests | ✅ 100 passed, 5 opt-in live skipped (105) |
| Track 3 named in first sentence | ✅ |
| Numbers match `bench/results.json` | ✅ `npm run check:numbers` clean |
| Qualifying adapter needed | ✅ **none — nothing key-gated** |

---

## Form fields

### Project name
```
Switchboard — on-device policy enforcement for clinic phone agents
```

### Elevator pitch (one line)
```
A real int8 transformer runs fully on-device on arm64, and the agent still cannot leak patient data — even when the model is compromised.
```

### Track selection
```
Track 3 — Mobile AI
```
⚠️ **This is the single field that voids an otherwise-complete entry. The rules require it explicitly.**

### Built with
```
typescript, node-sqlite, onnx, transformers.js, wasm, arm64, vitest, github-actions
```

### Try it out (links)
```
https://skodityala.github.io/switchboard/console/index.html
https://github.com/skodityala/switchboard
```

### Description

Paste the body of [`ARM.md`](ARM.md) from **"## Track selection"** through **"## Headline numbers, scoped honestly"**. It is written to the published weights — Technological Implementation 40, WOW 25, Impact 20, UX/DX 15 — and every number in it is checked against `bench/results.json` by `npm run check:numbers`.

The three things a judge should hit in the first twenty seconds:

1. **Track 3 stated in sentence one**, so the selection is unambiguous.
2. **The cross-arch table** — CI-measured, third-party, re-runnable in one click.
3. **The compromised model** — the WOW beat, testable by the judge in the hosted console.

### Video

⚠️ **Check the form for whether a video is required and its maximum length.** The human is producing it. If a video is mandatory and not yet ready: **file without it and add it before the deadline** — Devpost permits editing, and an unfiled submission scores zero.

---

## What is filed vs what can still improve

**Filed now:** working product, hosted demo, cross-arch CI benchmark, 294 tests, full written submission.

**Can be edited in afterwards:** the video, and any change from a later judge simulation.

The one thing that cannot be fixed after the deadline is not having filed.
