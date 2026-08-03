/**
 * THE TURN PIPELINE — one implementation, shared by every reasoner.
 *
 * WHY THIS FILE EXISTS. An audit found the pipeline triplicated: the
 * deterministic, Gemini and on-device reasoners each contained their own copy of
 * the field loop, their own TEMPLATES table, and their own copy of the refusal
 * sentence — about 28% of each file. They were identical at the time, and
 * nothing enforced that. Three copies of a security-relevant sentence is three
 * chances for one to drift, and the drift would be invisible: a reasoner could
 * start answering something the others refuse.
 *
 * The project's claim is "one gate, three reasoners". That was true of the GATE
 * (core.ts) and false of the TURN. This closes it.
 *
 * A reasoner now supplies exactly one thing: which intent the caller expressed.
 * Everything after that — which fields the intent may touch, adjudication,
 * template filling, refusal wording, timing — happens here, once.
 */
import type { AccessTrace, CatalogPort, FieldRef } from '@switchboard/catalog';
import type { CallState, Intent, IntentFieldMap, Turn, Utterance } from './port.js';

/**
 * Intent → the fields that intent may touch. Static and exhaustive: a reasoner
 * cannot construct a FieldRef at runtime, so the complete set of reachable field
 * reads is auditable by reading this one table — regardless of whether the
 * intent came from a regex, a 384-dim embedding, or Gemini.
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
  // so ONLY lineage propagation from patient.ssn denies it. Mapping this to
  // patient.ssn instead would let a keyword match do the catalog's job and leave
  // the lineage guarantee untested.
  ASK_SUBSCRIBER_KEY: [{ table: 'claim', field: 'subscriber_key' }],
  ASK_SSN_LAST4: [{ table: 'billing_account', field: 'ssn_last4' }],
  ASK_INSURANCE_ID: [{ table: 'patient', field: 'insurance_member_id' }],
  ASK_HOME_ADDRESS: [{ table: 'patient', field: 'home_address' }],
  ASK_DIAGNOSIS: [{ table: 'claim', field: 'diagnosis_code' }],
  UNKNOWN: [],
};

/**
 * Response templates. Placeholders are filled ONLY from ALLOWED traces, after
 * adjudication — so no reasoner, model or otherwise, ever authors a sentence
 * containing patient data.
 */
export const TEMPLATES: Readonly<Record<Intent, string>> = {
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
  IDENTITY_CONFIRM: 'I can start verification. What is the date of birth on the account?',
  ASK_SSN: '',
  ASK_SUBSCRIBER_KEY: '',
  ASK_SSN_LAST4: '',
  ASK_INSURANCE_ID: '',
  ASK_HOME_ADDRESS: '',
  ASK_DIAGNOSIS: '',
  UNKNOWN: 'I can help with hours, appointments, refills and billing. Which would you like?',
};

/**
 * THE REFUSAL. One definition, in one place.
 *
 * It never names the value, never confirms the value exists, and offers the
 * legitimate path instead — a refusal that leaks "yes, we hold that" is still a
 * disclosure.
 */
export function refusalFor(trace: AccessTrace): string {
  const secure =
    trace.effectiveClassification === 'PHI' ||
    trace.requested.table === 'patient' ||
    trace.requested.table === 'claim';
  return (
    `I don't have access to that field.` +
    (secure
      ? ` If you need it, I can start a records request that goes out by secure mail or in person.`
      : ` I can help with hours, appointments, refills or billing instead.`)
  );
}

/** Microsecond clock available in Node and every browser. */
const nowMicros = (): number => globalThis.performance.now() * 1000;

/**
 * Run one turn for an already-classified intent.
 *
 * This is the ONLY path from an intent to a reply. Every reasoner delegates here,
 * which is what makes "the model proposes, the catalog decides" a structural
 * property rather than a convention each adapter is trusted to follow.
 */
export async function runTurn(
  utterance: Utterance,
  state: CallState,
  catalog: CatalogPort,
  intent: Intent,
  startedMicros?: number,
): Promise<Turn> {
  const started = startedMicros ?? nowMicros();

  const fields: readonly FieldRef[] = INTENT_FIELDS[intent];
  const traces: AccessTrace[] = [];
  let denied = false;

  // Every field this intent needs goes through the gate. No field value is read
  // from anywhere else, so a DENY cannot be bypassed by a later branch.
  for (const requested of fields) {
    const trace = await catalog.decide({
      callId: utterance.callId,
      utterance: utterance.text,
      intent,
      requested,
      channel: utterance.channel,
      subjectVerified: state.subjectVerified,
      ...(state.callerSubjectId !== undefined ? { callerSubjectId: state.callerSubjectId } : {}),
      ...(state.rowSubjectId !== undefined ? { rowSubjectId: state.rowSubjectId } : {}),
    });
    traces.push(trace);
    if (trace.decision === 'DENY') denied = true;
  }

  let reply: string;
  let escalated = false;

  if (denied) {
    reply = refusalFor(traces.find((t) => t.decision === 'DENY') as AccessTrace);
  } else {
    // Placeholders are substituted only from ALLOWED traces, via readValue(trace)
    // — which is on CatalogPort, so every adapter must provide it.
    let filled = TEMPLATES[intent] || TEMPLATES.UNKNOWN;
    for (const t of traces) {
      if (t.decision !== 'ALLOW') continue;
      const v = catalog.readValue(t, state.rowSubjectId ?? '*');
      if (v !== undefined) filled = filled.replaceAll(`{${t.requested.field}}`, v);
    }
    // An unsubstituted placeholder means no allowed source existed. Fall back to
    // the menu rather than emitting a half-filled sentence.
    reply = /\{[a-z_]+\}/.test(filled) ? TEMPLATES.UNKNOWN : filled;
    if (intent === 'RECORDS_REQUEST') escalated = true;
  }

  return {
    reply,
    intent,
    traces,
    resolvedUnassisted: !escalated,
    escalatedToHuman: escalated,
    latencyMicros: Math.round(nowMicros() - started),
  };
}
