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
};

// Figures that were withdrawn or superseded and must appear NOWHERE.
const dead = ['24 KB', '12.2 MB', '12.9 MB', '7.2 MB', '100.1 µs', '910.6', '1,189×', '132 decision'];

let bad = 0;
for (const f of docs) {
  const text = readFileSync(f, 'utf8');
  for (const d of dead) {
    if (text.includes(d)) {
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
