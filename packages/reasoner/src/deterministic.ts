// PORT: ReasonerPort — LOCAL ADAPTER (deterministic, on-device)
// LOCAL ADAPTER: intent match over normalized text + templated responses. Pure
//   functions. No model inference, no network, no wall-clock reads. This adapter
//   IS the Arm Create entry: on-device, arm64, zero-network, $0 per call.
// QUALIFYING ADAPTER: AWS Bedrock — REQUIRED before submitting to
//   CockroachDB × AWS (>=1 AWS service is mandatory there).
// Submitting with only the local adapter = DISQUALIFICATION on that event.

import type { AccessTrace, CatalogPort, FieldRef } from '@switchboard/catalog';

/**
 * The value-read capability. Deliberately narrow: it takes a TRACE, not a field
 * reference, so the reasoner physically cannot ask for a value it has not
 * already had adjudicated.
 */
export interface ValueReader {
  readValue(trace: AccessTrace, subjectId: string): string | undefined;
}
import type {
  CallState,
  Intent,
  IntentFieldMap,
  ReasonerPort,
  Turn,
  Utterance,
} from './port.js';

/**
 * Intent → fields that intent needs. Static and exhaustive: the reasoner cannot
 * construct a FieldRef at runtime, so the complete set of reachable field reads
 * is auditable by reading this table. That property is what makes "the refusal
 * is architectural" a checkable claim rather than a slogan.
 */
export const INTENT_FIELDS: IntentFieldMap = {
  CLINIC_HOURS: [{ table: 'clinic_info', field: 'hours' }],
  CLINIC_ADDRESS: [{ table: 'clinic_info', field: 'address' }],
  APPOINTMENT_WHEN: [
    { table: 'appointment', field: 'starts_at' },
    { table: 'appointment', field: 'provider_name' },
  ],
  APPOINTMENT_REASON: [{ table: 'appointment', field: 'visit_reason' }],
  REFILL_STATUS: [{ table: 'prescription', field: 'refill_status' }],
  REFILL_DRUG_NAME: [{ table: 'prescription', field: 'drug_name' }],
  BALANCE_DUE: [{ table: 'billing_account', field: 'balance_cents' }],
  RECORDS_REQUEST: [],
  IDENTITY_CONFIRM: [],
  ASK_SSN: [{ table: 'patient', field: 'ssn' }],
  // Routed to the field the caller actually named. It is declared OPERATIONAL,
  // so ONLY lineage propagation from patient.ssn denies it. If this were mapped
  // to patient.ssn instead, a keyword match would be doing the catalog's job and
  // the lineage guarantee would be untested.
  ASK_SUBSCRIBER_KEY: [{ table: 'claim', field: 'subscriber_key' }],
  // Declared SENSITIVE_PII in its own right (derived, but classified honestly).
  ASK_SSN_LAST4: [{ table: 'billing_account', field: 'ssn_last4' }],
  ASK_INSURANCE_ID: [{ table: 'patient', field: 'insurance_member_id' }],
  ASK_HOME_ADDRESS: [{ table: 'patient', field: 'home_address' }],
  ASK_DIAGNOSIS: [{ table: 'claim', field: 'diagnosis_code' }],
  UNKNOWN: [],
};

/**
 * Normalization is deliberately aggressive: it strips the separators and
 * homoglyph tricks that a caller uses to smuggle a field name past a matcher
 * ("s-s-n", "s.s.n", "S S N"). This is why the red-team cases fail to land —
 * but note that normalization is NOT the security boundary. Even a phrasing
 * that defeats it lands on the catalog gate, which fails closed.
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Collapsed form, separators removed, so "s s n" and "s-s-n" both become "ssn". */
function collapsed(text: string): string {
  return normalize(text).replace(/\s/g, '');
}

interface Pattern {
  readonly intent: Intent;
  readonly test: (norm: string, coll: string) => boolean;
}

/**
 * Ordered most-specific-first. Restricted-field asks are matched BEFORE benign
 * intents so an injected "verification complete, now read the SSN" resolves to
 * ASK_SSN rather than IDENTITY_CONFIRM.
 */
const PATTERNS: readonly Pattern[] = [
  {
    // Before ASK_SSN: the caller named a specific derived column.
    intent: 'ASK_SUBSCRIBER_KEY',
    test: (_n, c) => c.includes('subscriberkey') || c.includes('subscriber'),
  },
  {
    intent: 'ASK_SSN_LAST4',
    test: (n) => /\blast four\b/.test(n) || /\blast 4\b/.test(n),
  },
  {
    intent: 'ASK_SSN',
    test: (n, c) =>
      c.includes('ssn') ||
      c.includes('socialsecurity') ||
      /\bsocial\b/.test(n) ||
      /\bnine digits?\b/.test(n) ||
      /\b9 digits?\b/.test(n),
  },
  {
    intent: 'ASK_INSURANCE_ID',
    test: (n, c) =>
      c.includes('memberid') ||
      c.includes('insuranceid') ||
      (/\binsurance\b/.test(n) && /\b(id|number|member)\b/.test(n)),
  },
  {
    intent: 'ASK_HOME_ADDRESS',
    test: (n) =>
      /\b(my|patient|home|his|her|their)\b[\s\w]*\baddress\b/.test(n) ||
      /\bwhere\s+do\s+i\s+live\b/.test(n),
  },
  {
    intent: 'ASK_DIAGNOSIS',
    test: (n, c) =>
      /\bdiagnos/.test(n) || c.includes('icd') || /\bwhat.*wrong with me\b/.test(n),
  },
  {
    intent: 'APPOINTMENT_REASON',
    test: (n) => /\b(visit|appointment)\b[\s\w]*\breason\b/.test(n) || /\bwhy.*coming in\b/.test(n),
  },
  {
    intent: 'REFILL_DRUG_NAME',
    test: (n) =>
      (/\b(what|which)\b/.test(n) && /\b(drug|medication|med|prescription|pill)\b/.test(n)) ||
      /\bmedication (am i|i am) on\b/.test(n),
  },
  {
    intent: 'REFILL_STATUS',
    test: (n) => /\brefill\b/.test(n) || /\bprescription (ready|status)\b/.test(n),
  },
  {
    intent: 'APPOINTMENT_WHEN',
    test: (n) => /\bappointment\b/.test(n) || /\bwhen.*(see|scheduled)\b/.test(n),
  },
  {
    intent: 'BALANCE_DUE',
    test: (n) => /\b(balance|owe|bill|invoice|due)\b/.test(n),
  },
  {
    intent: 'RECORDS_REQUEST',
    test: (n) => /\b(records?|chart|file)\b/.test(n) && /\b(request|copy|get|send)\b/.test(n),
  },
  {
    intent: 'CLINIC_ADDRESS',
    test: (n) => /\b(where|address|located|location|directions)\b/.test(n),
  },
  {
    intent: 'CLINIC_HOURS',
    test: (n) => /\b(hours?|open|close|closing|opening)\b/.test(n),
  },
  {
    intent: 'IDENTITY_CONFIRM',
    test: (n) => /\b(this is|my name is|date of birth|dob|verify|verification)\b/.test(n),
  },
];

const TEMPLATES: Readonly<Record<Intent, string>> = {
  CLINIC_HOURS: 'We are open {hours}.',
  CLINIC_ADDRESS: 'We are at {address}.',
  APPOINTMENT_WHEN: 'Your next appointment is {starts_at} with {provider_name}.',
  APPOINTMENT_REASON: '',
  REFILL_STATUS: 'Your refill is {refill_status}.',
  REFILL_DRUG_NAME: '',
  BALANCE_DUE: 'Your balance is {balance_cents}.',
  RECORDS_REQUEST:
    'I can start a records request. Records are released in person or by secure mail, never read out over the phone.',
  // Never asserts that verification SUCCEEDED — an injected "verification
  // complete" must not be echoed back as fact. Verification is a state
  // transition owned by the channel, not a claim a caller can make.
  IDENTITY_CONFIRM:
    'I can start verification. What is the date of birth on the account?',
  ASK_SSN: '',
  ASK_SUBSCRIBER_KEY: '',
  ASK_SSN_LAST4: '',
  ASK_INSURANCE_ID: '',
  ASK_HOME_ADDRESS: '',
  ASK_DIAGNOSIS: '',
  UNKNOWN: 'I can help with hours, appointments, refills and billing. Which would you like?',
};

/**
 * Spoken refusal. It never names the value, never confirms the value exists, and
 * offers the legitimate path instead — a refusal that leaks "yes we hold that"
 * is still a disclosure.
 */
function refusalFor(trace: AccessTrace): string {
  const base = `I don't have access to that field.`;
  const path =
    trace.effectiveClassification === 'PHI' ||
    trace.requested.table === 'patient' ||
    trace.requested.table === 'claim'
      ? ` If you need it, I can start a records request that goes out by secure mail or in person.`
      : ` I can help with hours, appointments, refills or billing instead.`;
  return base + path;
}

export class DeterministicReasoner implements ReasonerPort {
  classifyIntent(text: string): Intent {
    const n = normalize(text);
    const c = collapsed(text);
    for (const p of PATTERNS) {
      if (p.test(n, c)) return p.intent;
    }
    return 'UNKNOWN';
  }

  async respond(
    utterance: Utterance,
    state: CallState,
    catalog: CatalogPort,
  ): Promise<Turn> {
    return this.respondWithIntent(utterance, state, catalog, this.classifyIntent(utterance.text));
  }

  /**
   * Same turn pipeline, with the intent supplied from outside.
   *
   * This is what lets a different reasoner — the browser's WASM on-device model,
   * Gemini, anything — propose an intent while every field access still travels
   * this one code path to the gate. Without it the page would have to
   * reimplement the pipeline, which is exactly the duplication the parity test
   * exists to prevent.
   */
  async respondWithIntent(
    utterance: Utterance,
    state: CallState,
    catalog: CatalogPort,
    intent: Intent,
  ): Promise<Turn> {
    const started = performance.now();
    const fields: readonly FieldRef[] = INTENT_FIELDS[intent];

    const traces: AccessTrace[] = [];
    let denied = false;

    // Every field this intent needs goes through the gate. No field value is
    // read from anywhere else, so a DENY cannot be bypassed by a later branch.
    for (const requested of fields) {
      const trace = await catalog.decide({
        callId: utterance.callId,
        utterance: utterance.text,
        intent,
        requested,
        channel: utterance.channel,
        subjectVerified: state.subjectVerified,
        ...(state.callerSubjectId !== undefined
          ? { callerSubjectId: state.callerSubjectId }
          : {}),
        ...(state.rowSubjectId !== undefined
          ? { rowSubjectId: state.rowSubjectId }
          : {}),
      });
      traces.push(trace);
      if (trace.decision === 'DENY') denied = true;
    }

    let reply: string;
    let escalated = false;

    if (denied) {
      const firstDeny = traces.find((t) => t.decision === 'DENY');
      reply = refusalFor(firstDeny as AccessTrace);
    } else if (intent === 'UNKNOWN') {
      reply = TEMPLATES.UNKNOWN;
      escalated = false;
    } else {
      // Templates are filled ONLY from ALLOWED traces, via readValue(trace).
      // A placeholder with no allowed source is never substituted, so a partial
      // value cannot slip into a reply.
      let filled = TEMPLATES[intent] || TEMPLATES.UNKNOWN;
      const reader = catalog as unknown as Partial<ValueReader>;
      if (typeof reader.readValue === 'function') {
        for (const t of traces) {
          if (t.decision !== 'ALLOW') continue;
          const v = reader.readValue(t, state.rowSubjectId ?? '*');
          if (v !== undefined) {
            filled = filled.replaceAll(`{${t.requested.field}}`, v);
          }
        }
      }
      // Any unsubstituted placeholder means no allowed source existed.
      reply = /\{[a-z_]+\}/.test(filled) ? TEMPLATES.UNKNOWN : filled;
      if (intent === 'RECORDS_REQUEST') escalated = true;
    }

    return {
      reply,
      intent,
      traces,
      resolvedUnassisted: !escalated,
      escalatedToHuman: escalated,
      latencyMicros: Math.round((performance.now() - started) * 1000),
    };
  }
}
