/**
 * Arm Create benchmark. These numbers ARE the submission: Technological
 * Implementation is 40 of the points and asks for on-device, Arm64,
 * efficiency-minded evidence.
 *
 * Methods are fixed in docs/METRICS.md before emission. Notably:
 *   - p95 covers CatalogPort.decide() only — classification, full lineage walk,
 *     rule evaluation, trace construction. NOT rendering, NOT speech synthesis.
 *     Conflating those would be the dishonest version.
 *   - 500 warm-up iterations discarded, then 10,000 measured.
 *   - Cold-start reported separately; averaging cold into warm hides both.
 *
 * Run: npm run bench
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { arch, platform, cpus, totalmem } from 'node:os';
import { SqliteCatalog } from '@switchboard/catalog';
import { DeterministicReasoner, INTENT_FIELDS } from '@switchboard/reasoner';
import type { Intent } from '@switchboard/reasoner';

const here = dirname(fileURLToPath(import.meta.url));
// compiled to bench/dist/, so the repo root is two levels up
const root = join(here, '..', '..');
const catalogPkg = join(root, 'packages', 'catalog');

const WARMUP = 500;
const ITERATIONS = 10_000;

function quantile(sorted: readonly number[], q: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1);
  return sorted[idx] ?? 0;
}

function newCatalog(): SqliteCatalog {
  return new SqliteCatalog({
    schemaPath: join(catalogPkg, 'schema.sql'),
    fixturePath: join(catalogPkg, 'fixtures', 'rosewood.sql'),
    dataPath: join(catalogPkg, 'fixtures', 'rosewood-data.sql'),
  });
}

async function main(): Promise<void> {
  // ── cold start: process already up, catalog constructed from scratch ──────
  const coldT0 = performance.now();
  const coldCatalog = newCatalog();
  await coldCatalog.decide({
    callId: 'cold',
    utterance: 'cold start',
    intent: 'ASK_SSN',
    requested: { table: 'patient', field: 'ssn' },
    channel: 'PHONE',
    subjectVerified: false,
  });
  const coldStartMs = performance.now() - coldT0;
  coldCatalog.close();

  // ── the measured set: every field reachable through the intent map ────────
  const catalog = newCatalog();
  const reasoner = new DeterministicReasoner();
  const targets = Object.values(INTENT_FIELDS).flat();

  // Measured with an explicit GC when exposed (npm run bench:mem), so the delta
  // is retained heap rather than allocation noise.
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const memBefore = process.memoryUsage().heapUsed;

  for (let i = 0; i < WARMUP; i++) {
    const t = targets[i % targets.length]!;
    await catalog.decide({
      callId: 'warmup',
      utterance: 'warmup',
      intent: 'UNKNOWN',
      requested: t,
      channel: 'PHONE',
      subjectVerified: true,
      callerSubjectId: 'p_1001',
      rowSubjectId: 'p_1001',
    });
  }

  const decisionMicros: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t = targets[i % targets.length]!;
    const t0 = performance.now();
    await catalog.decide({
      callId: 'bench',
      utterance: 'benchmark',
      intent: 'UNKNOWN',
      requested: t,
      channel: 'PHONE',
      subjectVerified: true,
      callerSubjectId: 'p_1001',
      rowSubjectId: 'p_1001',
    });
    decisionMicros.push((performance.now() - t0) * 1000);
  }

  const memAfter = process.memoryUsage().heapUsed;
  const rss = process.memoryUsage().rss;

  // ── deepest lineage walk, measured separately: worst case, not average ────
  const deepMicros: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const t0 = performance.now();
    await catalog.decide({
      callId: 'deep',
      utterance: 'deep chain',
      intent: 'ASK_SUBSCRIBER_KEY',
      requested: { table: 'claim_export', field: 'subscriber_key' },
      channel: 'PHONE',
      subjectVerified: true,
    });
    deepMicros.push((performance.now() - t0) * 1000);
  }

  // ── full turn latency, reasoner + gate, for the record ───────────────────
  const turnMicros: number[] = [];
  const state = {
    callId: 'turn',
    subjectVerified: true,
    callerSubjectId: 'p_1001',
    rowSubjectId: 'p_1001',
    turnCount: 1,
  };
  const utterances = [
    'and can you read me back the social on file?',
    "what's the subscriber key on my claim?",
    'is my refill ready?',
    'what are your hours?',
  ];
  for (let i = 0; i < 2000; i++) {
    const text = utterances[i % utterances.length]!;
    const t0 = performance.now();
    await reasoner.respond({ callId: 'turn', text, channel: 'PHONE' }, state, catalog);
    turnMicros.push((performance.now() - t0) * 1000);
  }

  // ── resolved-unassisted over the fixture suite ───────────────────────────
  const suite: ReadonlyArray<{ text: string }> = [
    { text: 'what are your hours?' },
    { text: 'where are you located?' },
    { text: 'is my refill ready?' },
    { text: 'when is my appointment?' },
    { text: 'what do i owe?' },
    { text: "what's my social security number?" },
    { text: 'just the last four' },
    { text: "what's the subscriber key on my claim?" },
    { text: 'what is my insurance member id' },
    { text: 'what is my diagnosis' },
    { text: 'i need a copy of my records sent' },
    { text: 'what is my shoe size on file' },
  ];
  let escalated = 0;
  let fellBackToMenu = 0;
  const suiteCatalog = newCatalog();
  for (const s of suite) {
    const turn = await reasoner.respond(
      { callId: 'suite', text: s.text, channel: 'PHONE' },
      state,
      suiteCatalog,
    );
    if (turn.escalatedToHuman) escalated++;
    // An UNKNOWN reply ("I can help with hours, appointments...") did NOT
    // resolve what the caller asked for. Counting it as resolved inflates the
    // rate, so it is excluded from the numerator. A refusal, by contrast, IS a
    // resolution: declining an SSN and offering the records path is the product
    // working correctly.
    else if (turn.intent === 'UNKNOWN') fellBackToMenu++;
  }
  const resolved = suite.length - escalated - fellBackToMenu;
  const blockedReads = suiteCatalog.blockedReadCount();

  const sorted = [...decisionMicros].sort((a, b) => a - b);
  const deepSorted = [...deepMicros].sort((a, b) => a - b);
  const turnSorted = [...turnMicros].sort((a, b) => a - b);

  const results = {
    platform: {
      arch: arch(),
      platform: platform(),
      cpuModel: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length,
      totalMemGB: +(totalmem() / 1024 ** 3).toFixed(1),
      node: process.version,
    },
    catalogDecision: {
      iterations: ITERATIONS,
      warmupDiscarded: WARMUP,
      p50Micros: +quantile(sorted, 0.5).toFixed(1),
      p95Micros: +quantile(sorted, 0.95).toFixed(1),
      p99Micros: +quantile(sorted, 0.99).toFixed(1),
      meanMicros: +(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1),
      note: 'decide() only: classification + full lineage walk + rules + trace. Excludes rendering and speech.',
    },
    deepestLineageWalk: {
      target: 'claim_export.subscriber_key',
      hops: 3,
      iterations: deepMicros.length,
      p95Micros: +quantile(deepSorted, 0.95).toFixed(1),
      note: 'Worst-case chain in the fixture, measured separately from the average.',
    },
    fullTurn: {
      iterations: turnMicros.length,
      p95Micros: +quantile(turnSorted, 0.95).toFixed(1),
      note: 'Intent routing + gate + template fill. Still no network, no model call.',
    },
    coldStart: {
      millis: +coldStartMs.toFixed(2),
      note: 'Schema + fixtures loaded and first decision served, from a cold catalog.',
    },
    memory: {
      catalogHeapKB: Math.round((memAfter - memBefore) / 1024),
      processRssMB: +(rss / 1024 ** 2).toFixed(1),
      gcForced: typeof gc === 'function',
      note: 'catalogHeapKB is the retained heap attributable to the catalog and its decisions. processRssMB is the whole Node process including the V8 baseline — it is NOT a footprint claim for this software and is recorded only for completeness.',
    },
    costPerCall: {
      usd: 0,
      why: 'No model inference: deterministic intent match and templated responses, so no tokens and no provider. No network egress at runtime. Local SQLite, so no hosted database. Marginal cost is zero; amortized cost is the device the clinic already owns.',
      scope: 'Local adapter only. Any qualifying adapter (Bedrock, CockroachDB Cloud, CALL-E) introduces real per-call cost, so this figure is not repeated in those cuts.',
    },
    governance: {
      suiteSize: suite.length,
      blockedReads,
      escalatedToHuman: escalated,
      fellBackToMenu,
      resolvedUnassistedPct: Math.round((100 * resolved) / suite.length),
      note: 'Numerator excludes both human escalations AND UNKNOWN menu fallbacks — an unrecognised ask was not resolved, and counting it as such would inflate the rate. Refusals DO count as resolutions: declining an SSN and offering the records path is the product working. Denominator is every call reaching a terminal state.',
    },
    generatedAt: new Date().toISOString(),
  };

  catalog.close();
  suiteCatalog.close();

  writeFileSync(join(root, 'bench', 'results.json'), JSON.stringify(results, null, 2) + '\n');

  const p = results.platform;
  const d = results.catalogDecision;
  console.log(`\nSwitchboard — on-device benchmark`);
  console.log(`${p.cpuModel} · ${p.arch} · ${p.cpuCount} cores · ${p.totalMemGB} GB · Node ${p.node}\n`);
  console.log(`  decision p50           ${d.p50Micros} µs`);
  console.log(`  decision p95           ${d.p95Micros} µs   <- headline`);
  console.log(`  decision p99           ${d.p99Micros} µs`);
  console.log(`  deepest walk p95       ${results.deepestLineageWalk.p95Micros} µs  (3 hops)`);
  console.log(`  full turn p95          ${results.fullTurn.p95Micros} µs`);
  console.log(`  cold start             ${results.coldStart.millis} ms`);
  console.log(`  catalog heap           ${results.memory.catalogHeapKB} KB`);
  console.log(`  process RSS            ${results.memory.processRssMB} MB  (V8 baseline, not a footprint claim)`);
  console.log(`  cost per call          $0`);
  console.log(`  blocked reads          ${results.governance.blockedReads} / ${results.governance.suiteSize} calls`);
  console.log(`  resolved unassisted    ${results.governance.resolvedUnassistedPct}%  (excl. ${results.governance.fellBackToMenu} menu fallback, ${results.governance.escalatedToHuman} escalation)`);
  console.log(`\nwrote bench/results.json`);
}

await main();
