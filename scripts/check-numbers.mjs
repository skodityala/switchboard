/**
 * Fails if any prose figure has drifted from bench/results.json.
 *
 * Every number in the README and the submission docs is quoted to a judge, and
 * the benchmark re-runs on every machine — so hand-edited prose goes stale
 * silently. This is the guard: run it before any submission.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const r = JSON.parse(readFileSync('bench/results.json', 'utf8'));
const docs = ['README.md', ...readdirSync('docs/submissions').map((f) => join('docs/submissions', f))]
  .filter((f) => f.endsWith('.md'));

// Figures that must appear verbatim wherever they appear at all.
const live = {
  'decision p95': String(r.catalogDecision.p95Micros),
  'decision p50': String(r.catalogDecision.p50Micros),
  'decisions/sec/core': r.armEfficiency.decisionsPerSecPerCore.toLocaleString('en-US'),
  'resolved unassisted': String(r.governance.resolvedUnassistedPct),
  'recall withheld': String(r.memoryRecall.restrictedQuery.withheld),
  'duty cycle ms/day': r.armEfficiency.cpuMillisPerDay.toFixed(0),
  'working set bytes': r.armEfficiency.workingSetBytes.toLocaleString('en-US'),
  'L2 percentage': String(r.armEfficiency.workingSetPctOfL2),
  'deepest walk p95': String(r.deepestLineageWalk.p95Micros),
  'decision p99': String(r.catalogDecision.p99Micros),
};

// Figures quoted in ARM.md must match results.json exactly — that file is the
// $8,000 submission, so a stale number there is the expensive kind.
const armDoc = 'docs/submissions/ARM.md';
if (docs.includes(armDoc)) {
  const t = readFileSync(armDoc, 'utf8');
  for (const [name, v] of Object.entries({
    'p50': String(r.catalogDecision.p50Micros),
    'p95': String(r.catalogDecision.p95Micros),
    'p99': String(r.catalogDecision.p99Micros),
    'duty cycle': r.armEfficiency.cpuMillisPerDay.toFixed(0),
    'throughput': r.armEfficiency.decisionsPerSecPerCore.toLocaleString('en-US'),
  })) {
    if (!t.includes(v)) {
      console.error(`DRIFT  ${armDoc}: ${name} should be ${v} (from bench/results.json)`);
      bad++;
    }
  }
}

// Figures that were withdrawn or superseded and must appear NOWHERE.
let bad = 0;
const dead = ['24 KB', '12.2 MB', '12.9 MB', '7.2 MB', '100.1 µs', '910.6', '1,189×', '132 decision'];

for (const f of docs) {
  const text = readFileSync(f, 'utf8');
  for (const d of dead) {
    // '12.9 MB' is also the legitimate ONNX-runtime WASM size. Only flag it
    // when it appears WITHOUT that qualifier — the withdrawn figure was a heap
    // measurement, and the two must never be confusable in prose.
    const legitimate = d === '12.9 MB' && /12\.9\u202fMB ONNX-runtime WASM/.test(text);
    if (text.includes(d) && !legitimate) {
      console.error(`STALE  ${f}: contains withdrawn figure "${d}"`);
      bad++;
    }
  }
}
for (const [name, v] of Object.entries(live)) {
  const seen = docs.some((f) => readFileSync(f, 'utf8').includes(v));
  if (!seen) console.warn(`note   ${name} (${v}) is not quoted in any doc`);
}
console.log(bad === 0 ? 'numbers OK — no withdrawn figures in prose' : `${bad} stale figures`);
process.exit(bad === 0 ? 0 : 1);
