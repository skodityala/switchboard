/**
 * MemoryPort — isolation first.
 *
 * The interesting test is not "does recall work". It is "can a caller reach
 * another caller's memory". A memory layer that recalls across subjects turns the
 * catalog into decoration: the agent would refuse to read patient.ssn from the
 * database and then happily recite it from a remembered turn.
 *
 * Run against the real SQLite catalog and the real fixture — no mocks.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SqliteCatalog } from '@switchboard/catalog';
import { SqliteMemory } from '../sqlite-memory.js';
import { cosine, embed, EMBED_DIM, tokenize } from '../core.js';

const here = dirname(fileURLToPath(import.meta.url));
const catalogPkg = join(here, '..', '..', '..', 'catalog');

let catalog: SqliteCatalog;
let memory: SqliteMemory;

const DOLORES = 'p_1001';
const MARCUS = 'p_2002';

beforeEach(() => {
  catalog = new SqliteCatalog({
    schemaPath: join(catalogPkg, 'schema.sql'),
    fixturePath: join(catalogPkg, 'fixtures', 'rosewood.sql'),
    dataPath: join(catalogPkg, 'fixtures', 'rosewood-data.sql'),
  });
  memory = new SqliteMemory({ catalog });
});

const q = (subjectId: string, text: string, extra: Partial<Parameters<SqliteMemory['recall']>[0]> = {}) => ({
  subjectId,
  text,
  callId: 'call_test',
  channel: 'PHONE' as const,
  subjectVerified: true,
  ...extra,
});

// ─────────────────────────────────────────────────────────────────────────────
describe('CROSS-CALLER ISOLATION — the test that matters', () => {
  beforeEach(async () => {
    // Marcus's call. Distinctive, memorable content.
    await memory.remember({
      callId: 'call_marcus',
      subjectId: MARCUS,
      kind: 'TURN',
      text: 'Marcus Adeyemi confirmed his appointment for Tuesday with Dr Reyes about his knee',
    });
    await memory.remember({
      callId: 'call_marcus',
      subjectId: MARCUS,
      kind: 'ENTITY',
      text: 'appointment Tuesday 9:30am Dr Reyes knee follow-up',
      field: { table: 'appointment', field: 'starts_at' },
      classification: 'OPERATIONAL',
    });
    // Dolores's call.
    await memory.remember({
      callId: 'call_dolores',
      subjectId: DOLORES,
      kind: 'TURN',
      text: 'Dolores Whitfield asked whether her refill was ready',
    });
  });

  it('a caller cannot recall another caller by asking for their exact words', async () => {
    // Dolores asks, using Marcus's own phrasing — best possible vector match.
    const r = await memory.recall(
      q(DOLORES, 'Marcus Adeyemi appointment Tuesday Dr Reyes knee'),
    );
    for (const hit of r.hits) {
      expect(hit.entry.subjectId, 'recalled another caller').toBe(DOLORES);
      expect(hit.entry.text).not.toContain('Marcus');
      expect(hit.entry.text).not.toContain('Reyes');
    }
    // And it was never even a candidate — scope, not scoring.
    expect(r.scanned).toBe(1);
  });

  it('withheld results never carry another caller — they are not candidates at all', async () => {
    const r = await memory.recall(q(DOLORES, 'Marcus knee Dr Reyes Tuesday'));
    for (const w of r.withheld) {
      // Withheld entries come from the scanned set, which is subject-scoped.
      expect(w.entryId).not.toBe('');
    }
    const allIds = [...r.hits.map((h) => h.entry.entryId), ...r.withheld.map((w) => w.entryId)];
    for (const id of allIds) {
      const owned = memory.snapshot(DOLORES).some((e) => e.entryId === id);
      expect(owned, `entry ${id} is not Dolores's`).toBe(true);
    }
  });

  it('each caller recalls only their own history', async () => {
    const forMarcus = await memory.recall(q(MARCUS, 'appointment'));
    const forDolores = await memory.recall(q(DOLORES, 'appointment'));
    expect(forMarcus.hits.every((h) => h.entry.subjectId === MARCUS)).toBe(true);
    expect(forDolores.hits.every((h) => h.entry.subjectId === DOLORES)).toBe(true);
    expect(forMarcus.scanned).toBe(2);
    expect(forDolores.scanned).toBe(1);
  });

  it('callHistory is scoped by subject as well as call', async () => {
    // Right call id, wrong subject ⇒ nothing.
    const wrong = await memory.callHistory('call_marcus', DOLORES);
    expect(wrong).toHaveLength(0);
    const right = await memory.callHistory('call_marcus', MARCUS);
    expect(right).toHaveLength(1);
  });

  it('an unknown subject recalls nothing rather than everything', async () => {
    const r = await memory.recall(q('p_9999', 'appointment Tuesday refill'));
    expect(r.hits).toHaveLength(0);
    expect(r.scanned).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('memory is re-adjudicated at READ time, not trusted from write time', () => {
  it('a remembered restricted field is withheld, with a trace and no text', async () => {
    // A memory that names patient.ssn. Even for the right caller, recall must
    // refuse it — memory is not a side channel around the catalog.
    await memory.remember({
      callId: 'call_dolores',
      subjectId: DOLORES,
      kind: 'ENTITY',
      text: 'social security number on file',
      field: { table: 'patient', field: 'ssn' },
      classification: 'SENSITIVE_PII',
    });

    const r = await memory.recall(q(DOLORES, 'social security number'));

    expect(r.hits.some((h) => h.entry.field?.field === 'ssn')).toBe(false);
    const w = r.withheld.find((x) => x.field.field === 'ssn');
    expect(w).toBeDefined();
    expect(w?.trace.decision).toBe('DENY');
    expect(w?.trace.rule).toBe('RULE_NEVER_BY_PHONE');
    // A withheld memory carries no text — the refusal must not leak its content.
    expect(Object.keys(w ?? {})).not.toContain('text');
  });

  it('the lineage flank applies to memory too', async () => {
    await memory.remember({
      callId: 'call_dolores',
      subjectId: DOLORES,
      kind: 'ENTITY',
      text: 'subscriber key on the claim',
      // Classified OPERATIONAL at write time — permissive.
      field: { table: 'claim', field: 'subscriber_key' },
      classification: 'OPERATIONAL',
    });

    const r = await memory.recall(q(DOLORES, 'subscriber key claim'));
    const w = r.withheld.find((x) => x.field.field === 'subscriber_key');
    expect(w, 'lineage-restricted memory was not withheld').toBeDefined();
    // Written as OPERATIONAL, refused as SENSITIVE_PII: read-time adjudication.
    expect(w?.trace.resolvedClassification).toBe('OPERATIONAL');
    expect(w?.trace.effectiveClassification).toBe('SENSITIVE_PII');
    expect(w?.trace.lineage.length).toBeGreaterThanOrEqual(3);
  });

  it('operational memory is withheld from an unverified caller', async () => {
    await memory.remember({
      callId: 'call_dolores',
      subjectId: DOLORES,
      kind: 'ENTITY',
      text: 'appointment Thursday 2:15pm Dr Osei',
      field: { table: 'appointment', field: 'starts_at' },
      classification: 'OPERATIONAL',
    });

    const unverified = await memory.recall(
      q(DOLORES, 'when is my appointment', { subjectVerified: false }),
    );
    expect(unverified.hits.some((h) => h.entry.field?.field === 'starts_at')).toBe(false);
    expect(unverified.withheld.some((w) => w.trace.rule === 'RULE_SUBJECT_UNVERIFIED')).toBe(true);

    const verified = await memory.recall(q(DOLORES, 'when is my appointment'));
    expect(verified.hits.some((h) => h.entry.field?.field === 'starts_at')).toBe(true);
  });

  it('memory that names no field needs no adjudication', async () => {
    await memory.remember({
      callId: 'call_dolores',
      subjectId: DOLORES,
      kind: 'TURN',
      text: 'caller asked about parking near the clinic',
    });
    const r = await memory.recall(q(DOLORES, 'parking'));
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]?.trace).toBeUndefined();
    expect(r.traces).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('recall actually recalls — continuity across calls', () => {
  it('recalls the previous conversation for the same caller', async () => {
    await memory.remember({
      callId: 'call_001',
      subjectId: DOLORES,
      kind: 'TURN',
      text: 'caller asked whether the metformin refill was ready for pickup',
    });
    await memory.remember({
      callId: 'call_001',
      subjectId: DOLORES,
      kind: 'ENTITY',
      text: 'refill status ready for pickup',
      field: { table: 'prescription', field: 'refill_status' },
      classification: 'OPERATIONAL',
    });

    // A NEW call. The caller refers back without repeating details.
    const r = await memory.recall(q(DOLORES, 'is that refill ready yet', { callId: 'call_002' }));
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.some((h) => h.entry.text.includes('refill'))).toBe(true);
    expect(r.hits.some((h) => h.entry.callId === 'call_001')).toBe(true);
  });

  it('ranks the more relevant memory higher', async () => {
    await memory.remember({
      callId: 'c1', subjectId: DOLORES, kind: 'TURN',
      text: 'caller asked about billing balance and payment plans',
    });
    await memory.remember({
      callId: 'c1', subjectId: DOLORES, kind: 'TURN',
      text: 'caller asked when the next appointment with Dr Osei is scheduled',
    });
    const r = await memory.recall(q(DOLORES, 'my appointment with Dr Osei'));
    expect(r.hits[0]?.entry.text).toContain('appointment');
  });

  it('callHistory returns turns oldest first', async () => {
    await memory.remember({ callId: 'c9', subjectId: DOLORES, kind: 'TURN', text: 'first thing said' });
    await memory.remember({ callId: 'c9', subjectId: DOLORES, kind: 'TURN', text: 'second thing said' });
    const h = await memory.callHistory('c9', DOLORES);
    expect(h.map((e) => e.text)).toEqual(['first thing said', 'second thing said']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('memory and audit are one substrate', () => {
  it('an access decision is stored as a recallable DECISION memory', async () => {
    const trace = await catalog.decide({
      callId: 'call_dolores',
      utterance: 'read me the social',
      intent: 'ASK_SSN',
      requested: { table: 'patient', field: 'ssn' },
      channel: 'PHONE',
      subjectVerified: true,
      callerSubjectId: DOLORES,
      rowSubjectId: DOLORES,
    });
    expect(trace.decision).toBe('DENY');

    const entry = await memory.rememberDecision(trace, DOLORES);
    expect(entry.kind).toBe('DECISION');
    // The decision memory records the RATIONALE, never a value.
    expect(entry.text).toContain('RULE_NEVER_BY_PHONE');
    expect(entry.text).not.toContain('539');

    // It is itself gated on recall, because it names the field.
    const r = await memory.recall(q(DOLORES, 'why were you not able to give me the social'));
    expect(r.withheld.some((w) => w.field.field === 'ssn')).toBe(true);
  });

  it('DECISION memories can be filtered by kind', async () => {
    await memory.remember({ callId: 'c', subjectId: DOLORES, kind: 'TURN', text: 'hello there' });
    const trace = await catalog.decide({
      callId: 'c', utterance: 'hours', intent: 'CLINIC_HOURS',
      requested: { table: 'clinic_info', field: 'hours' },
      channel: 'PHONE', subjectVerified: false,
    });
    await memory.rememberDecision(trace, DOLORES);

    const onlyDecisions = await memory.recall(
      q(DOLORES, 'hours clinic_info ALLOW', { kinds: ['DECISION'] }),
    );
    expect(onlyDecisions.hits.every((h) => h.entry.kind === 'DECISION')).toBe(true);
    expect(onlyDecisions.hits.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('vector mechanics are deterministic and dependency-free', () => {
  it('embeddings are stable, normalised, and fixed-width', () => {
    const a = embed('is my refill ready for pickup');
    const b = embed('is my refill ready for pickup');
    expect(a).toEqual(b);
    expect(a).toHaveLength(EMBED_DIM);
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('cosine is 1 for identical text and lower for unrelated text', () => {
    const q1 = embed('when is my appointment with Dr Osei');
    expect(cosine(q1, q1)).toBeCloseTo(1, 6);
    const unrelated = embed('billing balance payment plan invoice');
    expect(cosine(q1, unrelated)).toBeLessThan(cosine(q1, q1));
  });

  it('empty and stopword-only text embeds to a zero vector, not a crash', () => {
    const z = embed('the a is it my');
    expect(z).toHaveLength(EMBED_DIM);
    expect(z.every((x) => x === 0)).toBe(true);
    expect(cosine(z, embed('appointment'))).toBe(0);
  });

  it('tokenizer drops stopwords and punctuation', () => {
    expect(tokenize('Is my REFILL ready?!')).toEqual(['refill', 'ready']);
  });

  it('no locale-dependent comparison in ordering', async () => {
    // Ties break on entryId with plain comparison, so ordering is identical in
    // any locale — the same bug class fixed in the catalog's hop ordering.
    await memory.remember({ callId: 'c', subjectId: DOLORES, kind: 'TURN', text: 'refill ready' });
    await memory.remember({ callId: 'c', subjectId: DOLORES, kind: 'TURN', text: 'refill ready' });
    const r1 = await memory.recall(q(DOLORES, 'refill ready'));
    const r2 = await memory.recall(q(DOLORES, 'refill ready'));
    expect(r1.hits.map((h) => h.entry.entryId)).toEqual(r2.hits.map((h) => h.entry.entryId));
  });
});
