# Adapter guide — read this first

Three qualifying adapters are needed, each by a hard date. Each one is a **single new file** implementing a **single interface** that already exists in the repo. You do not need to read the rest of the codebase.

| Adapter | Event | Deadline (EDT) | **Adapter due** | Doc |
|---|---|---|---|---|
| DataHub → `CatalogPort` | DataHub | Aug 10, 17:00 | **Aug 7** | [DATAHUB.md](DATAHUB.md) |
| CockroachDB → `MemoryPort` | CockroachDB × AWS | Aug 18, 17:00 | **Aug 16** | [COCKROACHDB.md](COCKROACHDB.md) |
| CALL-E → `ChannelPort` | CALL-E | Sep 14, 11:45 | **Sep 11** | [CALLE.md](CALLE.md) |

If an adapter misses its date, that submission is dropped rather than submitted on the local adapter. Sponsor tech is scored at each of these events, and a local stub is a disqualification — so a late adapter is not a partial win, it is a scratch.

## The 60-second version

Every external dependency sits behind a port. Each port has a local adapter that runs offline, and a **qualifying adapter** that uses the sponsor's product at runtime. Swapping one for the other must not require touching any caller.

```
packages/catalog/src/port.ts     CatalogPort   → DataHub
packages/memory/src/port.ts      MemoryPort    → CockroachDB
packages/channel/src/port.ts     ChannelPort   → CALL-E
packages/reasoner/src/port.ts    ReasonerPort  → AWS Bedrock
```

Every port file starts with this header. Read it — it names what qualifying means for that event:

```ts
// PORT: <name>
// LOCAL ADAPTER: <what runs on this machine>
// QUALIFYING ADAPTER: <sponsor tech> — REQUIRED before submitting to <event>.
// Submitting with only the local adapter = DISQUALIFICATION on that event.
```

## Setup

```bash
git clone https://github.com/skodityala/switchboard && cd switchboard
npm install          # zero external runtime deps; devDeps are typescript + vitest
npm run typecheck
npm test             # 69 tests, all should pass before you start
open console/index.html   # the demo, no build step needed
```

Node ≥ 22 is required for the `node:sqlite` builtin.

## The rules your PR has to satisfy

1. **Do not modify a port interface.** If the sponsor's API genuinely cannot satisfy it, say so in the PR rather than widening the interface — a changed interface breaks the other two adapters and the console.
2. **Do not touch `core.ts` in any package.** Those files hold the single implementation of the gate, of gated recall, and of the call state machine. Storage and I/O go in your adapter; decisions do not.
3. **Your adapter must pass the existing tests.** Each doc shows the exact command. The suites are written against the interface, not against SQLite.
4. **Keep the local adapter working.** The offline demo has to keep running from a bare clone with the network unplugged — that is a scored property at Arm and a hard constraint everywhere. Your adapter is additive.
5. **Do not add a runtime dependency to a package that the browser bundle uses.** The sponsor SDK is fine in your adapter file; it must not end up in `console/app.js`. `scripts/build-console.mjs` controls what does.
6. **Runtime use, not name-dropping.** Every one of these events verifies the sponsor product is imported and *called*. A wrapper that logs and delegates to SQLite fails the screen.
7. **Credentials come from the environment.** No keys in the repo, ever. Document the variables you need in your PR description.

## Where to put things

```
packages/<pkg>/src/adapters/<sponsor>.ts     ← your file
packages/<pkg>/src/adapters/<sponsor>.test.ts ← optional, skipped without creds
```

Export it from the package `index.ts`. Nothing else in the repo should need editing.

## Questions

Open a draft PR with the question in the description. That is faster than waiting, and a draft PR with a failing test is a more useful question than prose.
