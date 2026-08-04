/**
 * Sync the test count into every place that quotes it.
 *
 * WHY THIS IS A SCRIPT. Three ad-hoc shell attempts blanked the README badge to
 * "tests-%20passing" because vitest writes its summary to stderr, exits non-zero
 * when tests are skipped, and prints "294 passed | 16 skipped" rather than
 * "294 passed". Each attempt substituted an empty string and failed OPEN.
 *
 * Two rules make that impossible here:
 *   1. Read the JSON reporter, not console text.
 *   2. REFUSE to write if the count cannot be parsed. Failing closed on a badge
 *      is the same discipline the product applies to a field.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const OUT = '/tmp/switchboard-vitest.json';
execFileSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${OUT}`], {
  stdio: 'ignore',
});

const report = JSON.parse(readFileSync(OUT, 'utf8'));
const passed = report.numPassedTests;
const files = new Set((report.testResults ?? []).map((t) => t.name)).size;

if (!Number.isInteger(passed) || passed <= 0 || files <= 0) {
  console.error('refusing to write: could not parse a test count from the JSON reporter');
  process.exit(1);
}

const TARGETS = ['README.md', 'console/index.html', 'index.html'];
let touched = 0;

for (const f of TARGETS) {
  if (!existsSync(f)) continue;
  const before = readFileSync(f, 'utf8');
  const after = before
    // Tolerates an already-blanked value, so a previous corruption self-heals.
    .replace(/\/badge\/tests-\d*%20passing-/g, `/badge/tests-${passed}%20passing-`)
    .replace(/## Test coverage — \d* tests, \d* files/g, `## Test coverage — ${passed} tests, ${files} files`)
    .replace(/all \d* tests pass with none present/g, `all ${passed} tests pass with none present`)
    .replace(/the same compiled gate the \d* tests run/g, `the same compiled gate the ${passed} tests run`)
    .replace(/the same code path the \d* tests use/g, `the same code path the ${passed} tests use`)
    .replace(/asserted by \d* tests/g, `asserted by ${passed} tests`)
    .replace(/(npm test\s+# )\d* tests/g, `$1${passed} tests`);

  if (after !== before) {
    // Atomic replace, same reason as sync-numbers: never leave a half-written doc.
    const tmp = `${f}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, after, { flag: 'wx' });
      renameSync(tmp, f);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* nothing to clean */ }
      throw err;
    }
    touched++;
    console.log(`  synced ${f}`);
  }
}

console.log(`  ${passed} tests across ${files} files${touched ? '' : ' — already in sync'}`);
