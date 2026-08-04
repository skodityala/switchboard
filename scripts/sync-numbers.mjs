/**
 * Sync every quoted benchmark figure in prose to bench/results.json.
 *
 * WHY THIS EXISTS. check-numbers.mjs detects drift; it cannot repair it. The
 * benchmark re-runs on every machine and every CI push, so any figure typed by
 * hand into the README or a submission doc goes stale silently — and a stale
 * number in a submission is the kind a judge punctures in Q&A. It has already
 * caught six hand-edits.
 *
 * The fix is to stop retyping. This rewrites the numeric spans in place from the
 * one source of truth, so the workflow becomes:
 *
 *     npm run bench && npm run sync:numbers && npm run check:numbers
 *
 * Prose, framing and caveats are never touched — only the figures.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const r = JSON.parse(readFileSync('bench/results.json', 'utf8'));
const d = r.catalogDecision;
const dl = r.deepestLineageWalk;
const ft = r.fullTurn;
const mr = r.memoryRecall;
const ae = r.armEfficiency;
const noise = r.timerNoiseFloorMicros?.p95 ?? 0.0001;

const TARGETS = [
  'README.md',
  'docs/submissions/ARM.md',
  'docs/submissions/AI-BUILDERS.md',
  'docs/submissions/GALUXIUM.md',
  'docs/submissions/DEVNETWORK.md',
  'docs/submissions/REMAINING-SIX.md',
];

/** [description, pattern, replacement] — each rewrites one figure, nothing else. */
const RULES = [
  ['p50/p95/p99 triple',
    /(\| Decision p50 \/ \*\*p95\*\* \/ p99 \| )[\d.]+( \/ \*\*)[\d.]+(\*\* \/ )[\d.]+( µs \|)/g,
    (_m, a, b, c, e) => `${a}${d.p50Micros}${b}${d.p95Micros}${c}${d.p99Micros}${e}`],

  ['p50 row', /(\| Decision p50 \| )[\d.]+( µs \|)/g, (_m, a, b) => `${a}${d.p50Micros}${b}`],
  ['p95 row', /(\| \*\*Decision p95\*\* \| \*\*)[\d.]+(\*\* µs \|)/g, (_m, a, b) => `${a}${d.p95Micros}${b}`],
  ['p99 row', /(\| Decision p99 \| )[\d.]+( µs \|)/g, (_m, a, b) => `${a}${d.p99Micros}${b}`],

  ['deepest walk', /(\| Deepest lineage walk p95 \| )[\d.]+( µs \|)/g, (_m, a, b) => `${a}${dl.p95Micros}${b}`],
  ['full turn', /(\| Full turn p95 \| )[\d.]+( µs \|)/g, (_m, a, b) => `${a}${ft.p95Micros}${b}`],
  ['recall', /(\| Memory recall p95 \| )[\d.]+( µs \|)/g, (_m, a, b) => `${a}${mr.p95Micros}${b}`],
  ['cold start', /(\| Cold start \| )[\d.]+( ms \|)/g, (_m, a, b) => `${a}${r.coldStart.millis}${b}`],

  ['throughput bold', /\*\*[\d,]+ decisions\/sec\/core\*\*/g,
    () => `**${ae.decisionsPerSecPerCore.toLocaleString('en-US')} decisions/sec/core**`],
  ['throughput row', /(\| Throughput \| \*\*)[\d,]+( decisions\/sec\/core\*\* \|)/g,
    (_m, a, b) => `${a}${ae.decisionsPerSecPerCore.toLocaleString('en-US')}${b}`],

  ['duty cycle bold', /\*\*[\d.]+ ms of one (?:CPU )?core per day\*\*/g,
    () => `**${ae.cpuMillisPerDay.toFixed(0)} ms of one core per day**`],
  ['duty cycle prose', /~[\d.]+ ms of one (?:CPU )?core per day/g,
    () => `~${ae.cpuMillisPerDay.toFixed(0)} ms of one core per day`],
  ['duty cycle ms/day', /(\| \*\*Clinic duty cycle\*\* \| \*\*)[\d.]+( ms)/g,
    (_m, a, b) => `${a}${ae.cpuMillisPerDay.toFixed(0)}${b}`],
  ['duty cycle sentence', /costs \*\*~?[\d.]+ milliseconds of one Arm core per day\*\*/g,
    () => `costs **~${ae.cpuMillisPerDay.toFixed(0)} milliseconds of one Arm core per day**`],

  ['working set bytes', /\*\*[\d,]+ B = [\d.]+% of L2\*\*/g,
    () => `**${ae.workingSetBytes.toLocaleString('en-US')} B = ${ae.workingSetPctOfL2}% of L2**`],
  ['working set prose', /(\| Working set \| \*\*)[\d,]+( B = )[\d.]+(% of L2\*\* \|)/g,
    (_m, a, b, c) => `${a}${ae.workingSetBytes.toLocaleString('en-US')}${b}${ae.workingSetPctOfL2}${c}`],

  ['noise ratio', /\*\*[\d,]+× the measured timer noise floor\*\*/g,
    () => `**${Math.round(d.p95Micros / noise).toLocaleString('en-US')}× the measured timer noise floor**`],
  ['noise value', /\(([\d.]+) µs\), so it is not a resolution artifact/g,
    () => `(${noise} µs), so it is not a resolution artifact`],
  ['noise inline', /timer noise floor p95: [\d.]+ µs {2}→ {2}p95 is [\d,]+× above it/g,
    () => `timer noise floor p95: ${noise} µs  →  p95 is ${Math.round(d.p95Micros / noise).toLocaleString('en-US')}× above it`],

  ['p95 prose µs', /p95 policy decision \*\*~?[\d.]+ µs\*\*/g, () => `p95 policy decision **~${d.p95Micros} µs**`],
  ['p95 prose plain', /p95 decision ~[\d.]+ µs/g, () => `p95 decision ~${d.p95Micros} µs`],

  ['resolved %', /(\| Resolved unassisted \| \*\*)[\d]+(%\*\* \|)/g,
    (_m, a, b) => `${a}${r.governance.resolvedUnassistedPct}${b}`],
  ['withheld', /(\| Recall gate \| )[\d]+( withheld)/g,
    (_m, a, b) => `${a}${mr.restrictedQuery.withheld}${b}`],
];

let touched = 0;
for (const f of TARGETS) {
  if (!existsSync(f)) continue;
  const before = readFileSync(f, 'utf8');
  let after = before;
  const applied = [];
  for (const [name, pattern, repl] of RULES) {
    const next = after.replace(pattern, repl);
    if (next !== after) applied.push(name);
    after = next;
  }
  if (after !== before) {
    writeFileSync(f, after);
    touched++;
    console.log(`  ${f}\n    synced: ${applied.join(', ')}`);
  }
}

console.log(
  touched === 0
    ? '  all prose figures already match bench/results.json'
    : `  ${touched} file(s) synced from bench/results.json`,
);
