# Adapter runbooks — five lines each

Every gated event, from key-in-hand to qualifying submission. **Package identity was verified for each before any code was written** — see the note at the bottom, which is the most expensive mistake avoided here.

Nothing below is installed by default. Every adapter dependency is an **optional peer**: `npm install` pulls zero external runtime packages, and all 139 tests pass with none of them present.

---

## DataHub — `CatalogPort`

**Gate Aug 7 · event Aug 10, 17:00 EDT · minutes-to-qualify: ~35**

```bash
export DATAHUB_GMS=https://<your-instance>/api/graphql
export DATAHUB_TOKEN=<personal access token>
DATAHUB_LIVE=1 npx vitest run packages/catalog      # verifies read + write-back
```

- **File:** `packages/catalog/src/adapters/datahub.ts` — zero dependencies, GraphQL over global `fetch`.
- **Proves it qualified:** a decision appears in the DataHub UI as institutional memory on the dataset, labelled `DENY claim.subscriber_key — RULE_NEVER_BY_PHONE (inherited SENSITIVE_PII via 3-hop lineage)`. **Screenshot that** — it is the contribute-back evidence, and the criterion most entries skip.
- **Before submitting:** load `packages/catalog/fixtures/rosewood.sql`'s equivalent into the instance so classifications and column-level lineage exist to read.

---

## CockroachDB + AWS — `MemoryPort`

**Adapter due Aug 16 · event Aug 18, 17:00 EDT · minutes-to-qualify: ~50**

```bash
npm install --no-save pg @aws-sdk/client-secrets-manager
export CRDB_URL='postgresql://<user>:<pw>@<host>:26257/switchboard?sslmode=verify-full'
export AWS_SECRET_ID=switchboard/crdb   # optional: satisfies the >=1 AWS service rule
CRDB_LIVE=1 npx vitest run packages/memory && npm run bench
```

- **File:** `packages/memory/src/adapters/cockroachdb.ts`.
- **Two CockroachDB tools, both load-bearing:** the **distributed vector index** (`CREATE VECTOR INDEX` on a real `VECTOR(128)` column) and **transactional writes** (a turn and its decisions commit together).
- **AWS service:** Secrets Manager resolves the connection string at runtime.
- **Proves it qualified:** `npm run bench` after the swap. The local adapter's recall is **918 µs p50 on a 220-entry linear scan** — published as a ceiling precisely because an index replaces it. Report both numbers. A before/after on a weakness we admitted is the strongest evidence available for criterion 1.

---

## CALL-E — `ChannelPort`

**Adapter due Sep 11 · event Sep 14, 11:45 EDT · minutes-to-qualify: ~40**

```bash
export CALLE_API_KEY=<key>              # a CALL-E account includes 20 free calls
export CALLE_DEMO_NUMBER=+1<e164>
CALLE_LIVE=1 npx vitest run packages/channel
```

- **File:** `packages/channel/src/adapters/calle.ts` — REST behind `CallETransport`; the official SDK drops in behind that interface once its package name is verifiable.
- **Proves it qualified:** a recording or transcript of a **real call refusing a restricted field**. That artifact is the submission's centre of gravity — it shows the gate operating on a live line, not just in a browser.
- **Lead with the refusal, not the dialling.** The rubric explicitly excludes "a generic 'AI that makes phone calls' concept". The reusable contribution, in the criterion's own words, is `SpeechSink`: **two methods**, and any telephony provider gets catalog-gated disclosure.

---

## Caspian — `ChannelPort` (built earlier)

**Event Aug 12, 14:30 EDT · minutes-to-qualify: ~30**

```bash
export CASPIAN_API_KEY=<key>
export TELEGRAM_BOT_TOKEN=<from @BotFather>
CASPIAN_LIVE=1 npx vitest run packages/channel
```

- **≥2 channels through ONE handler** is architectural, not configuration. The adapter throws at construction if fewer than two are requested.
- Free channels: email, Slack, Discord, Telegram, SMS. Slack/Discord return an `authorize_url` a human clicks once.

---

## Gemini — `ReasonerPort` (built earlier)

**XPRIZE Aug 17, 16:00 EDT · minutes-to-qualify: ~20**

```bash
export GEMINI_API_KEY=<key>
GEMINI_LIVE=1 npx vitest run packages/reasoner
```

---

## Package identity — verified before writing a line

Two npm name collisions were caught here. Either would have installed cleanly, typechecked, passed tests, and **failed the sponsor-tech screen on inspection** — the one failure mode with no recovery.

| Looks right | Actually is | Verified how |
|---|---|---|
| `datahub-client` | **DataHub.io** — data packages, not the metadata platform | `homepage` field pointed at datahub.io, not datahubproject.io |
| `calle` | **A 2021 joke package** — description `"a"`, readme *"Help me, im bored"* | version 1.0.0, no repository, maintainer unrelated to the sponsor |

Both avoided. DataHub is integrated via its GraphQL API; CALL-E via REST behind an interface. `pg` was verified as node-postgres, which Cockroach Labs documents.

**Standing rule: confirm a package's `homepage`/`repository` points at the sponsor's actual product before building against it.**

