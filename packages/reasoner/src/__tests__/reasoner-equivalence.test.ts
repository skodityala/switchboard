/**
 * CROSS-REASONER EQUIVALENCE — the test the audit found missing.
 *
 * The project's headline claim is "one gate, three reasoners, identical trace
 * shape". Before this file, nothing verified it. Each reasoner carried its own
 * copy of the turn pipeline, its own TEMPLATES table and its own copy of the
 * refusal sentence — identical by luck, not by construction. A single edit to
 * one copy would have produced a reasoner that answers what the others refuse,
 * and no test would have failed.
 *
 * These tests make the claim structural:
 *   1. Given the SAME intent, all three reasoners produce byte-identical replies.
 *   2. All three produce traces with identical shape AND identical decisions.
 *   3. No reasoner authors the refusal sentence or calls the gate itself.
 *
 * (3) is the invariant guard. It is the same shape as the one protecting
 * console/index.html, and it exists for the same reason: a structural check
 * keeps working as the code changes, whereas a snapshot of expected output does
 * not.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SqliteCatalog } from '@switchboard/catalog';
import { DeterministicReasoner } from '../deterministic.js';
import { GeminiReasoner, type GenAIClient } from '../adapters/gemini.js';
import { OnDeviceReasoner, INTENT_PROTOTYPES, type FeatureExtractor } from '../adapters/on-device.js';
import { INTENT_FIELDS, TEMPLATES, refusalFor } from '../turn.js';
import type { CallState, Intent, ReasonerPort } from '../port.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..');
const catalogPkg = join(here, '..', '..', '..', 'catalog');

let catalog: SqliteCatalog;

const verified: CallState = {
  callId: 'call_eq',
  subjectVerified: true,
  callerSubjectId: 'p_1001',
  rowSubjectId: 'p_1001',
  turnCount: 1,
};

beforeEach(() => {
  catalog = new SqliteCatalog({
    schemaPath: join(catalogPkg, 'schema.sql'),
    fixturePath: join(catalogPkg, 'fixtures', 'rosewood.sql'),
    dataPath: join(catalogPkg, 'fixtures', 'rosewood-data.sql'),
  });
});

/** Gemini forced to return one specific intent. */
function gemini(intent: Intent): GeminiReasoner {
  const client: GenAIClient = {
    models: { generateContent: async () => ({ text: intent }) },
  };
  return new GeminiReasoner({ apiKey: 'test', clientFactory: () => client });
}

/** On-device model forced to resolve to one specific intent. */
function onDevice(intent: Intent): OnDeviceReasoner {
  const order = Object.keys(INTENT_PROTOTYPES) as Intent[];
  const dim = order.length;
  const idx = Math.max(0, order.indexOf(intent));
  const factory = async (): Promise<FeatureExtractor> => async (text) => {
    const v = new Array<number>(dim).fill(0);
    const protoIdx = order.findIndex((i) =>
      (INTENT_PROTOTYPES[i] as readonly string[]).includes(text),
    );
    v[protoIdx >= 0 ? protoIdx : idx] = 1;
    return { data: v, dims: [1, dim] };
  };
  return new OnDeviceReasoner({ extractorFactory: factory });
}

/** Deterministic reasoner driven through the shared-intent entry point. */
function deterministic(): DeterministicReasoner {
  return new DeterministicReasoner();
}

/** Every intent, so the sweep cannot miss the one that drifted. */
const ALL_INTENTS = Object.keys(INTENT_FIELDS) as Intent[];

describe('all three reasoners agree, given the same intent', () => {
  it('produce byte-identical replies for EVERY intent', async () => {
    const det = deterministic();

    for (const intent of ALL_INTENTS) {
      const utter = { callId: 'call_eq', text: 'probe utterance', channel: 'PHONE' as const };

      const a = await det.respondWithIntent(utter, verified, catalog, intent);
      const b = await gemini(intent).respond(utter, verified, catalog);
      const c = await onDevice(intent).respond(utter, verified, catalog);

      expect(b.intent, `gemini did not honour ${intent}`).toBe(intent);
      expect(c.intent, `on-device did not honour ${intent}`).toBe(intent);

      // The load-bearing assertion: same words, every time.
      expect(b.reply, `gemini reply differs for ${intent}`).toBe(a.reply);
      expect(c.reply, `on-device reply differs for ${intent}`).toBe(a.reply);
    }
  });

  it('produce identical DECISIONS for every intent', async () => {
    const det = deterministic();

    for (const intent of ALL_INTENTS) {
      const utter = { callId: 'call_eq', text: 'probe utterance', channel: 'PHONE' as const };

      const a = await det.respondWithIntent(utter, verified, catalog, intent);
      const b = await gemini(intent).respond(utter, verified, catalog);
      const c = await onDevice(intent).respond(utter, verified, catalog);

      const fingerprint = (t: typeof a): string =>
        t.traces
          .map(
            (x) =>
              `${x.requested.table}.${x.requested.field}=${x.decision}/${x.rule}/${x.effectiveClassification}/${x.lineage.length}`,
          )
          .join('|');

      expect(fingerprint(b), `gemini decisions differ for ${intent}`).toBe(fingerprint(a));
      expect(fingerprint(c), `on-device decisions differ for ${intent}`).toBe(fingerprint(a));
    }
  });

  it('produce traces with identical SHAPE', async () => {
    const utter = { callId: 'call_eq', text: 'probe', channel: 'PHONE' as const };
    const a = await deterministic().respondWithIntent(utter, verified, catalog, 'ASK_SSN');
    const b = await gemini('ASK_SSN').respond(utter, verified, catalog);
    const c = await onDevice('ASK_SSN').respond(utter, verified, catalog);

    const keys = (t: typeof a): string[] => Object.keys(t.traces[0] ?? {}).sort();
    expect(keys(b)).toEqual(keys(a));
    expect(keys(c)).toEqual(keys(a));

    const turnKeys = (t: typeof a): string[] => Object.keys(t).sort();
    expect(turnKeys(b)).toEqual(turnKeys(a));
    expect(turnKeys(c)).toEqual(turnKeys(a));
  });

  it('all three refuse every restricted intent', async () => {
    const restricted: Intent[] = [
      'ASK_SSN', 'ASK_SUBSCRIBER_KEY', 'ASK_SSN_LAST4',
      'ASK_INSURANCE_ID', 'ASK_HOME_ADDRESS', 'ASK_DIAGNOSIS',
    ];
    const reasoners: [string, (i: Intent) => ReasonerPort][] = [
      ['gemini', (i) => gemini(i)],
      ['on-device', (i) => onDevice(i)],
    ];
    const utter = { callId: 'call_eq', text: 'probe', channel: 'PHONE' as const };

    for (const intent of restricted) {
      const base = await deterministic().respondWithIntent(utter, verified, catalog, intent);
      expect(base.traces.some((t) => t.decision === 'DENY')).toBe(true);

      for (const [name, make] of reasoners) {
        const turn = await make(intent).respond(utter, verified, catalog);
        expect(
          turn.traces.some((t) => t.decision === 'DENY'),
          `${name} failed to deny ${intent}`,
        ).toBe(true);
        expect(turn.reply, `${name} reply differs on ${intent}`).toBe(base.reply);
      }
    }
  });
});

describe('INVARIANT GUARD: no reasoner reimplements the turn', () => {
  const REASONERS = [
    'deterministic.ts',
    'adapters/gemini.ts',
    'adapters/on-device.ts',
  ];

  it('no reasoner authors the refusal sentence', () => {
    // The refusal exists in exactly one place. If a reasoner ever writes it
    // again, this fails — before the copies can drift.
    for (const f of REASONERS) {
      const s = readFileSync(join(src, f), 'utf8');
      expect(s, `${f} authors the refusal itself`).not.toContain(
        "I don't have access to that field",
      );
    }
  });

  it('no reasoner declares its own TEMPLATES table', () => {
    for (const f of REASONERS) {
      const s = readFileSync(join(src, f), 'utf8');
      expect(s, `${f} declares its own TEMPLATES`).not.toMatch(/const TEMPLATES\s*[:=]/);
    }
  });

  it('no reasoner calls the gate directly — all go through runTurn', () => {
    for (const f of REASONERS) {
      const s = readFileSync(join(src, f), 'utf8');
      expect(s, `${f} calls catalog.decide directly`).not.toContain('catalog.decide');
    }
  });

  it('no reasoner declares its own INTENT_FIELDS map', () => {
    for (const f of REASONERS) {
      const s = readFileSync(join(src, f), 'utf8');
      expect(s, `${f} declares its own INTENT_FIELDS`).not.toMatch(
        /const INTENT_FIELDS\s*[:=]/,
      );
    }
  });

  it('turn.ts is the sole owner of all four', () => {
    const s = readFileSync(join(src, 'turn.ts'), 'utf8');
    expect(s).toContain("I don't have access to that field");
    expect(s).toMatch(/export const TEMPLATES/);
    expect(s).toMatch(/export const INTENT_FIELDS/);
    expect(s).toContain('catalog.decide');
  });
});

describe('the shared pipeline is exhaustive', () => {
  it('every intent has a TEMPLATES entry and a field list', () => {
    for (const intent of ALL_INTENTS) {
      expect(TEMPLATES[intent], `${intent} missing from TEMPLATES`).toBeDefined();
      expect(INTENT_FIELDS[intent], `${intent} missing from INTENT_FIELDS`).toBeDefined();
    }
  });

  it('every restricted-field intent has an EMPTY template', () => {
    // A restricted intent must never have a fillable sentence — the refusal is
    // the only output, so an accidental template would be a disclosure path.
    for (const intent of ['ASK_SSN', 'ASK_SUBSCRIBER_KEY', 'ASK_SSN_LAST4',
                          'ASK_INSURANCE_ID', 'ASK_HOME_ADDRESS', 'ASK_DIAGNOSIS'] as Intent[]) {
      expect(TEMPLATES[intent], `${intent} has a non-empty template`).toBe('');
    }
  });

  it('refusalFor never names the field value or confirms it exists', () => {
    const t = {
      effectiveClassification: 'SENSITIVE_PII' as const,
      requested: { table: 'patient', field: 'ssn' },
    };
    const r = refusalFor(t as never);
    expect(r).toContain("I don't have access to that field");
    // It must not echo the field name back — that confirms what is held.
    expect(r).not.toContain('ssn');
    expect(r).not.toContain('patient');
  });
});
