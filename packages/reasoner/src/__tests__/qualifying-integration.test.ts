/**
 * QUALIFYING-ADAPTER INTEGRATION — the blind spot that hid a real defect.
 *
 * Every previous test drove a reasoner against the LOCAL SQLite catalog, or the
 * DataHub adapter directly with no reasoner. Nothing ever ran a full turn over a
 * qualifying adapter. That gap is exactly why the DataHub adapter could ship
 * without readValue(): it allowed the read, then silently degraded every answer
 * to the fallback menu, and no test noticed.
 *
 * These tests close it. They run the same turn pipeline over the DataHub adapter
 * that the local suite runs over SQLite, and assert the two things that gap hid:
 *
 *   1. readValue() is honoured — an ALLOWED read renders its real value.
 *   2. readValue() is GATED — a DENIED trace yields nothing, and no adapter can
 *      opt out of the check, because readValue is on CatalogPort.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DataHubCatalog,
  SqliteCatalog,
  type AccessTrace,
  type CatalogPort,
  type GraphQLTransport,
} from '@switchboard/catalog';
import { DeterministicReasoner } from '../deterministic.js';

const here = dirname(fileURLToPath(import.meta.url));
const catalogPkg = join(here, '..', '..', '..', 'catalog');

/** Values the clinic's own operational store would hold. DataHub holds metadata. */
const VALUES = {
  'clinic_info.hours': { '*': 'Monday to Friday, 8am to 6pm' },
  'clinic_info.address': { '*': '4120 Larkspur Avenue, Suite 3' },
  'prescription.refill_status': { p_1001: 'ready for pickup' },
  'appointment.starts_at': { p_1001: 'Thursday August 6th at 2:15pm' },
  'appointment.provider_name': { p_1001: 'Dr. Amara Osei' },
  'patient.ssn': { p_1001: '539-88-4021' },
  'claim.subscriber_key': { p_1001: '4021-19540311' },
} as const;

const SECRETS = ['539-88-4021', '4021-19540311'];

/** A DataHub instance carrying the Rosewood classifications and lineage. */
function transport(): GraphQLTransport {
  const TIERS: Record<string, Record<string, string>> = {
    clinic_info: { hours: 'Public', address: 'Public' },
    patient: { ssn: 'SensitivePII', date_of_birth: 'PII' },
    appointment: { starts_at: 'Operational', provider_name: 'Operational' },
    prescription: { refill_status: 'Operational', drug_name: 'PHI' },
    billing_account: { ssn_last4: 'SensitivePII', balance_cents: 'Operational' },
    // Under-classified by the operator on purpose: only lineage restricts it.
    claim: { subscriber_key: 'Operational', diagnosis_code: 'PHI' },
  };
  const urnOf = (t: string): string =>
    `urn:li:dataset:(urn:li:dataPlatform:clinic,${t},PROD)`;

  return {
    async query<T>(q: string, v: Record<string, unknown>): Promise<T> {
      const table = /,([^,)]+),PROD\)/.exec(String(v['urn']))?.[1] ?? '';

      if (q.includes('schemaMetadata')) {
        return {
          dataset: {
            urn: String(v['urn']),
            name: table,
            schemaMetadata: {
              fields: Object.entries(TIERS[table] ?? {}).map(([fieldPath, term]) => ({
                fieldPath,
                glossaryTerms: { terms: [{ term: { properties: { name: term } } }] },
                tags: null,
              })),
            },
          },
        } as T;
      }

      if (q.includes('fineGrainedLineages')) {
        // patient.ssn -> billing_account.ssn_last4 -> claim.subscriber_key
        const edges: Record<string, { from: [string, string]; to: [string, string] }> = {
          billing_account: { from: ['patient', 'ssn'], to: ['billing_account', 'ssn_last4'] },
          claim: { from: ['billing_account', 'ssn_last4'], to: ['claim', 'subscriber_key'] },
        };
        const e = edges[table];
        return {
          dataset: {
            fineGrainedLineages: e
              ? [
                  {
                    transformOperation: 'derive',
                    upstreams: [{ urn: urnOf(e.from[0]), path: e.from[1] }],
                    downstreams: [{ urn: urnOf(e.to[0]), path: e.to[1] }],
                  },
                ]
              : [],
          },
        } as T;
      }
      return { addLink: true } as T;
    },
  };
}

const TABLES = ['clinic_info', 'patient', 'appointment', 'prescription', 'billing_account', 'claim'];

let datahub: DataHubCatalog;
let sqlite: SqliteCatalog;
let reasoner: DeterministicReasoner;

const verified = {
  callId: 'call_q',
  subjectVerified: true,
  callerSubjectId: 'p_1001',
  rowSubjectId: 'p_1001',
  turnCount: 1,
};

beforeEach(async () => {
  datahub = new DataHubCatalog({ transport: transport(), values: VALUES });
  await datahub.warm(TABLES);
  sqlite = new SqliteCatalog({
    schemaPath: join(catalogPkg, 'schema.sql'),
    fixturePath: join(catalogPkg, 'fixtures', 'rosewood.sql'),
    dataPath: join(catalogPkg, 'fixtures', 'rosewood-data.sql'),
  });
  reasoner = new DeterministicReasoner();
});

const ask = (catalog: CatalogPort, text: string) =>
  reasoner.respond({ callId: 'call_q', text, channel: 'PHONE' }, verified, catalog);

describe('a full turn over the DataHub adapter', () => {
  it('renders a real value for an ALLOWED read — the defect that was shipping', async () => {
    const turn = await ask(datahub, 'what are your hours?');
    expect(turn.traces.every((t) => t.decision === 'ALLOW')).toBe(true);
    // Before readValue was on CatalogPort this returned the fallback menu.
    expect(turn.reply).toContain('8am to 6pm');
    expect(turn.reply).not.toContain('I can help with hours, appointments');
  });

  it('fills multi-placeholder templates from the qualifying adapter', async () => {
    const turn = await ask(datahub, 'when is my appointment?');
    expect(turn.reply).toContain('Thursday August 6th at 2:15pm');
    expect(turn.reply).toContain('Dr. Amara Osei');
  });

  it('refuses the SSN and renders no value', async () => {
    const turn = await ask(datahub, 'and can you read me back the social on file?');
    expect(turn.traces.some((t) => t.rule === 'RULE_NEVER_BY_PHONE')).toBe(true);
    for (const s of SECRETS) expect(turn.reply).not.toContain(s);
  });

  it('the lineage flank holds end to end over DataHub metadata', async () => {
    const turn = await ask(datahub, "what's the subscriber key on my claim?");
    const deny = turn.traces.find((t) => t.decision === 'DENY');
    expect(deny?.resolvedClassification).toBe('OPERATIONAL');
    expect(deny?.effectiveClassification).toBe('SENSITIVE_PII');
    expect(deny?.lineage.length).toBeGreaterThanOrEqual(2);
    // The value exists in the store and still never reaches the reply.
    expect(turn.reply).not.toContain('4021-19540311');
  });
});

describe('readValue is gated, not merely present', () => {
  it('a DENY trace yields no value, even for a field the store holds', async () => {
    const trace = await datahub.decide({
      callId: 'c', utterance: 'ssn', intent: 'ASK_SSN',
      requested: { table: 'patient', field: 'ssn' },
      channel: 'PHONE', subjectVerified: true,
      callerSubjectId: 'p_1001', rowSubjectId: 'p_1001',
    });
    expect(trace.decision).toBe('DENY');
    expect(datahub.readValue(trace, 'p_1001')).toBeUndefined();
  });

  it('a forged ALLOW for a different field yields nothing for THIS field', async () => {
    // readValue keys off the trace's own requested field, so an ALLOW obtained
    // for hours cannot be reused to read the SSN.
    const allowed = await datahub.decide({
      callId: 'c', utterance: 'hours', intent: 'CLINIC_HOURS',
      requested: { table: 'clinic_info', field: 'hours' },
      channel: 'PHONE', subjectVerified: true,
    });
    expect(allowed.decision).toBe('ALLOW');
    const swapped = { ...allowed, requested: { table: 'patient', field: 'ssn' } } as AccessTrace;
    // readValue re-adjudicates instead of trusting its argument, so a forged
    // ALLOW for a SENSITIVE_PII field yields nothing. Defence in depth: the same
    // field is checked twice, by the gate and again at the point of use.
    expect(datahub.readValue(swapped, 'p_1001')).toBeUndefined();
  });

  it('an unknown subject gets nothing rather than another caller\'s value', async () => {
    const trace = await datahub.decide({
      callId: 'c', utterance: 'refill', intent: 'REFILL_STATUS',
      requested: { table: 'prescription', field: 'refill_status' },
      channel: 'PHONE', subjectVerified: true,
      callerSubjectId: 'p_9999', rowSubjectId: 'p_9999',
    });
    if (trace.decision === 'ALLOW') {
      expect(datahub.readValue(trace, 'p_9999')).toBeUndefined();
    }
  });
});

describe('the qualifying adapter agrees with the local one', () => {
  it('same decisions and same replies for the demo path', async () => {
    for (const text of [
      'what are your hours?',
      'when is my appointment?',
      'and can you read me back the social on file?',
      "what's the subscriber key on my claim?",
    ]) {
      const a = await ask(sqlite, text);
      const b = await ask(datahub, text);

      const fp = (t: typeof a): string =>
        t.traces
          .map((x) => `${x.requested.table}.${x.requested.field}=${x.decision}/${x.rule}`)
          .join('|');

      expect(fp(b), `decisions differ for "${text}"`).toBe(fp(a));
      expect(b.reply, `reply differs for "${text}"`).toBe(a.reply);
    }
  });
});
