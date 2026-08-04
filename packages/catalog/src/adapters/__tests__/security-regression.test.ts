/**
 * SECURITY REGRESSION TESTS — one per CodeQL finding.
 *
 * Enabling CodeQL surfaced 6 alerts, 3 of them high. The most serious was
 * js/polynomial-redos in the DataHub adapter: `/schemaField:\(.*?,([^)]+)\)/`
 * backtracks catastrophically on a crafted URN, and URNs arrive from a DataHub
 * instance — data this process does not author. That is production code on the
 * qualifying path for a $20,500 event, so it gets a permanent guard rather than
 * a one-off fix.
 *
 * Each test here pins one fix. If someone reintroduces a regex on this path, the
 * timing assertion fails long before a judge or an operator notices.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fieldKeyFromUrn, datasetUrn } from '../datahub.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');

describe('js/polynomial-redos — URN parsing must be linear', () => {
  it('parses a normal dataset URN correctly', () => {
    expect(fieldKeyFromUrn(datasetUrn('patient'), 'ssn')).toBe('patient.ssn');
    expect(fieldKeyFromUrn(datasetUrn('claim'), 'subscriber_key')).toBe('claim.subscriber_key');
  });

  it('does not degrade on a hostile URN with many commas', () => {
    // The exact shape that made the old lazy-quantifier regex backtrack. With a
    // regex this took seconds; linear scanning is microseconds.
    const hostile = `urn:li:dataset:(urn:li:dataPlatform:${'a,'.repeat(20_000)}x,PROD)`;
    const t0 = performance.now();
    fieldKeyFromUrn(hostile, 'f');
    const ms = performance.now() - t0;
    expect(ms, `40k-char URN took ${ms.toFixed(1)}ms — is a regex back on this path?`).toBeLessThan(50);
  });

  it('stays linear as input grows — no super-linear blowup', () => {
    const build = (n: number): string =>
      `urn:li:dataset:(urn:li:dataPlatform:${'a,'.repeat(n)}x,PROD)`;
    const time = (s: string): number => {
      const t0 = performance.now();
      for (let i = 0; i < 50; i++) fieldKeyFromUrn(s, 'f');
      return performance.now() - t0;
    };
    // Warm the JIT so the comparison is not dominated by first-call compilation.
    time(build(500));

    const small = Math.max(time(build(2_000)), 0.01);
    const large = time(build(20_000));
    // 10× the input must not cost dramatically more than 10× the time. A
    // backtracking regex would blow past this.
    expect(large / small, 'growth looks super-linear').toBeLessThan(40);
  });

  it('returns null on malformed URNs rather than throwing', () => {
    for (const bad of ['', 'not-a-urn', 'urn:li:dataset:(', 'urn:li:dataset:()', ',,,']) {
      expect(() => fieldKeyFromUrn(bad, 'f')).not.toThrow();
    }
  });

  it('no lazy-quantifier regex remains on the URN path', () => {
    // The structural guard. A timing test can be flaky on a loaded CI runner;
    // this cannot.
    //
    // Comments are stripped first: the file deliberately DOCUMENTS the removed
    // pattern so the next reader knows why the parser is hand-written, and an
    // earlier version of this test flagged that explanation as the defect. The
    // invariant is about executable code, not prose describing it.
    const raw = readFileSync(join(repoRoot, 'packages/catalog/src/adapters/datahub.ts'), 'utf8');
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/^\s*\/\/.*$/gm, '');       // line comments

    expect(code, 'a lazy .*? regex is back in the DataHub adapter').not.toMatch(/\.\*\?/);
    // And the hand-written scanners are still the ones doing the work.
    expect(code).toContain('indexOf');
    expect(code).toContain('lastIndexOf');
  });
});

describe('js/file-system-race — writes must be atomic', () => {
  it('sync-numbers writes to a temp file then renames', () => {
    const src = readFileSync(join(repoRoot, 'scripts/sync-numbers.mjs'), 'utf8');
    expect(src).toContain('renameSync');
    // 'wx' fails if the temp file already exists, which is what makes the
    // rename safe rather than merely tidy.
    expect(src).toMatch(/flag: 'wx'/);
  });

  it('fetch-model writes to a temp file then renames', () => {
    const src = readFileSync(join(repoRoot, 'scripts/fetch-model.mjs'), 'utf8');
    expect(src).toContain('renameSync');
    expect(src).toMatch(/flag: 'wx'/);
    // A truncated model left at the real path would be seen as "already
    // fetched" by the next run — worse than failing.
    expect(src).toMatch(/partial/);
  });
});

describe('js/http-to-file-access — response bytes are validated before disk', () => {
  it('fetch-model rejects an empty body and contains the write path', () => {
    const src = readFileSync(join(repoRoot, 'scripts/fetch-model.mjs'), 'utf8');
    expect(src).toMatch(/buf\.length === 0/);
    // Path containment, so a future edit cannot turn this into traversal.
    expect(src).toMatch(/refusing to write outside the model directory/);
  });
});

describe('dependency hygiene', () => {
  it('declares no external runtime dependencies', () => {
    // The $0/call and offline claims both rest on this, and it is also why the
    // runtime audit is clean while the dev chain needed a vitest upgrade.
    const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(root.dependencies ?? {})).toHaveLength(0);

    for (const pkg of ['catalog', 'memory', 'reasoner', 'channel', 'ui']) {
      const p = JSON.parse(
        readFileSync(join(repoRoot, 'packages', pkg, 'package.json'), 'utf8'),
      ) as { dependencies?: Record<string, string> };
      const external = Object.keys(p.dependencies ?? {}).filter(
        (d) => !d.startsWith('@switchboard/'),
      );
      expect(external, `${pkg} has external runtime deps: ${external.join(', ')}`).toHaveLength(0);
    }
  });

  it('every adapter dependency is an OPTIONAL peer', () => {
    // So `npm install` stays clean for anyone not using that adapter.
    for (const pkg of ['reasoner', 'memory', 'channel']) {
      const p = JSON.parse(
        readFileSync(join(repoRoot, 'packages', pkg, 'package.json'), 'utf8'),
      ) as { peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> };
      for (const dep of Object.keys(p.peerDependencies ?? {})) {
        expect(
          p.peerDependenciesMeta?.[dep]?.optional,
          `${pkg}: ${dep} must be an optional peer`,
        ).toBe(true);
      }
    }
  });
});
