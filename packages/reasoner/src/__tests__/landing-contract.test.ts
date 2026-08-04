/**
 * LANDING PAGE CONTRACT — the buyer-facing claims are scored, so they are tested.
 *
 * Research finding that produced this file: Arm's UX/DX is already 15/15, so more
 * console polish scores zero. AI Builders' Design sat at 7/10 for one recorded
 * reason — "Console is polished; no pricing page or buyer-facing artifact" — and
 * DevNetwork's rubric is one-third "Could this become a startup or company?".
 * So the frontend work that actually scores is a buyer-facing page, not more
 * chrome on the demo.
 *
 * A marketing page is the easiest place in a repo for an inflated claim to hide,
 * because nothing executes it. These tests make the honest framing load-bearing:
 * the STT concession, the "75% not all" wording and the pre-revenue risks cannot
 * be quietly dropped to make the pitch cleaner.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const page = (): string => readFileSync(join(root, 'index.html'), 'utf8');

describe('the buyer is named, with a named cost', () => {
  it('names the practice size and the settlement it cannot absorb', () => {
    const s = page();
    expect(s).toMatch(/3-provider/);
    expect(s).toMatch(/\$50,000 HIPAA settlement/);
  });

  it('names what they pay, flat', () => {
    const s = page();
    expect(s).toContain('$299');
    expect(s).toMatch(/Not per-minute, not per-call, not per-token/);
  });

  it('names the incumbent options and their real prices', () => {
    // A judge scoring "does this solve a real problem" needs the alternatives.
    expect(page()).toMatch(/\$600–1,200\/month/);
  });
});

describe('the honest concessions survive — this is the point of the test', () => {
  it('keeps the STT cost visible in the economics table', () => {
    // The margin is 77.9%, not 100%, because real telephony still needs speech
    // recognition. Dropping this row would make the pitch cleaner and wrong.
    const s = page();
    expect(s).toContain('$66.00');
    expect(s).toMatch(/this one remains/);
  });

  it('says 75% of variable cost removed, not all of it', () => {
    expect(page()).toMatch(/75% of a comparable stack's variable cost, not all of it/);
  });

  it('states the margin as 77.9% against the competitor 10.8%', () => {
    const s = page();
    expect(s).toContain('77.9%');
    expect(s).toContain('10.8%');
  });

  it('publishes the assumptions behind the arithmetic', () => {
    const s = page();
    expect(s).toMatch(/1,200 input \+ 300 output tokens/);
    expect(s).toMatch(/\$0\.006\/min/);
    expect(s).toMatch(/2\.5 min average call/);
  });

  it('states the pre-revenue risks rather than omitting them', () => {
    const s = page();
    expect(s).toMatch(/No signed pilot/);
    expect(s).toMatch(/STT remains a variable cost/);
    expect(s).toMatch(/onboarding cost/);
  });
});

describe('the technical claim is not overstated', () => {
  it('says "cannot", and immediately distinguishes it from "will not"', () => {
    const s = page();
    expect(s).toMatch(/Not "won't" — <strong>cannot<\/strong>/);
  });

  it('explains WHY the subscriber_key case is commercially meaningful', () => {
    // Without this the trace is just a screenshot; with it, it is a mistake a
    // real practice makes.
    expect(page()).toMatch(/OPERATIONAL by the clinic's own staff/);
    expect(page()).toMatch(/caught by architecture rather than\s+vigilance/);
  });

  it('points at how every number is measured', () => {
    const s = page();
    expect(s).toMatch(/METRICS\.md/);
    expect(s).toMatch(/npm run bench/);
  });
});

describe('it does not break the demo URL every submission references', () => {
  it('links to the console with a relative path', () => {
    expect(page()).toContain('href="./console/index.html"');
  });

  it('does not claim to BE the console', () => {
    // The console is the artifact judges are told to open; the landing page must
    // route to it, not replace it.
    expect(page()).toMatch(/Attack the live demo/);
  });
});

describe('same constraints as the rest of the project', () => {
  it('has zero external dependencies', () => {
    const s = page();
    expect(s).not.toMatch(/<script\s+src=/);
    expect(s).not.toMatch(/href="https?:[^"]*\.css/);
  });

  it('is responsive, reduced-motion aware, printable and keyboard accessible', () => {
    const s = page();
    expect(s).toMatch(/@media \(max-width:720px\)/);
    expect(s).toMatch(/@media \(prefers-reduced-motion:reduce\)/);
    expect(s).toMatch(/@media print/);
    expect(s).toMatch(/class="sr-only"/);
    expect(s).toMatch(/focus-visible/);
  });

  it('declares a language and a description for shared links', () => {
    const s = page();
    expect(s).toMatch(/<html lang="en">/);
    expect(s).toMatch(/<meta name="description"/);
  });

  it('shares the console design tokens rather than inventing a second look', () => {
    // Agentic Cinema asks for "a complete, coherent product experience"; two
    // pages that look unrelated fail that sentence.
    const s = page();
    for (const token of ['--surface:#0F1419', '--deny:#E5484D', '--allow:#3DD68C']) {
      expect(s, `token ${token} differs from the console`).toContain(token);
    }
  });
});
