// PORT: ReasonerPort — QUALIFYING ADAPTER (Google Gemini)
//
// The thesis was never "no AI". It is: the agent cannot leak REGARDLESS of what
// is reasoning. A deterministic script proving that is weak evidence — a judge
// can fairly say a state machine does not leak because it cannot think. A live
// model proving it is the strongest evidence available, and it is the same
// architecture, unchanged.
//
// What Gemini does here: natural-language understanding — intent, entities,
// paraphrase, multilingual input. What Gemini CANNOT do here: read a field
// value. The model never receives patient data and never sees the row store.
// It names a field it would like; CatalogPort decides; only an ALLOW trace can
// unlock a value, and the value is substituted into a template AFTER the model
// has finished. There is no code path from a model token to a restricted field.
//
// CREDENTIAL: GEMINI_API_KEY (or GOOGLE_API_KEY).
// See docs/adapters/GEMINI.md for the runbook.

import type { AccessTrace, CatalogPort, FieldRef } from '@switchboard/catalog';
import { INTENT_FIELDS } from '../deterministic.js';
import type { CallState, Intent, ReasonerPort, Turn, Utterance } from '../port.js';

/**
 * The subset of @google/genai this adapter uses, declared structurally so the
 * file compiles and is reviewable whether or not the package is installed.
 */
export interface GenAIResponse {
  readonly text?: string | undefined;
}
export interface GenAIModels {
  generateContent(req: {
    model: string;
    contents: string;
    config?: Record<string, unknown>;
  }): Promise<GenAIResponse>;
}
export interface GenAIClient {
  readonly models: GenAIModels;
}

export class MissingCredentialError extends Error {
  constructor() {
    super('set GEMINI_API_KEY to run the Gemini reasoner (see docs/adapters/GEMINI.md)');
    this.name = 'MissingCredentialError';
  }
}

/** Every intent the model is allowed to choose. Nothing outside this list. */
const INTENT_NAMES = Object.keys(INTENT_FIELDS) as Intent[];

/**
 * The model is asked for a classification, not for prose.
 *
 * Note what is absent: no patient data, no field values, no row store, no
 * instruction to "be careful with sensitive fields". Asking a model to be
 * careful is precisely the pattern this product exists to replace. The model
 * cannot leak what it was never given.
 */
function classifyPrompt(text: string): string {
  return [
    'You route messages for a medical clinic phone line.',
    'Classify the caller message into exactly one intent from this list:',
    INTENT_NAMES.join(', '),
    '',
    'Reply with ONLY the intent name, nothing else.',
    'If nothing fits, reply UNKNOWN.',
    '',
    `Caller message: ${JSON.stringify(text)}`,
  ].join('\n');
}

export interface GeminiReasonerOptions {
  readonly apiKey?: string;
  readonly model?: string;
  /** Injected in tests; real runs load @google/genai. */
  readonly clientFactory?: (apiKey: string) => GenAIClient;
  /** Falls back to the deterministic reasoner if the model errors or is slow. */
  readonly fallback?: ReasonerPort;
  readonly timeoutMs?: number;
}

/**
 * Gemini for understanding; the catalog for authority.
 *
 * The demo sentence: "we gave Gemini a governor."
 */
export class GeminiReasoner implements ReasonerPort {
  private client: GenAIClient | undefined;
  private readonly opts: GeminiReasonerOptions;
  /** Populated per turn so the trace can record what the model asked for. */
  private lastModelIntent: Intent = 'UNKNOWN';

  constructor(opts: GeminiReasonerOptions = {}) {
    this.opts = opts;
  }

  private apiKey(): string {
    const k = this.opts.apiKey ?? process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
    if (k === undefined || k === '') throw new MissingCredentialError();
    return k;
  }

  private async ensureClient(): Promise<GenAIClient> {
    if (this.client) return this.client;
    const key = this.apiKey();
    if (this.opts.clientFactory) {
      this.client = this.opts.clientFactory(key);
    } else {
      // Runtime-built specifier: @google/genai is an OPTIONAL peer, so the
      // compiler must not require it for anyone who does not use this adapter.
      const pkg = '@google/genai';
      const mod = (await import(/* @vite-ignore */ pkg)) as unknown as {
        GoogleGenAI: new (o: { apiKey: string }) => GenAIClient;
      };
      this.client = new mod.GoogleGenAI({ apiKey: key });
    }
    return this.client;
  }

  /**
   * Synchronous interface member. The model call is async, so this returns the
   * intent resolved by the most recent respond(); it exists to satisfy
   * ReasonerPort and is not the primary path.
   */
  classifyIntent(_text: string): Intent {
    return this.lastModelIntent;
  }

  /** Ask the model for an intent, and constrain its answer to the known set. */
  async classifyIntentAsync(text: string): Promise<Intent> {
    const client = await this.ensureClient();
    const res = await client.models.generateContent({
      model: this.opts.model ?? 'gemini-2.5-flash',
      contents: classifyPrompt(text),
      config: { temperature: 0, maxOutputTokens: 16 },
    });

    // Digits are significant: ASK_SSN_LAST4 is a real intent, and an earlier
    // sanitiser that stripped [^A-Z_] silently turned it into ASK_SSN_LAST,
    // matched nothing, and fell through to UNKNOWN. Safe, but wrong — a valid
    // classification vanished. Keep 0-9.
    const raw = (res.text ?? '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');

    // Exact match against the enum first.
    const exact = INTENT_NAMES.find((i) => i === raw);
    if (exact) return exact;

    // A chatty model may wrap the answer ("Intent: ASK_SSN_LAST4."). Accept a
    // contained enum member, longest first so ASK_SSN_LAST4 wins over ASK_SSN.
    const contained = [...INTENT_NAMES]
      .sort((a, b) => b.length - a.length)
      .find((i) => raw.includes(i));

    // Anything else is UNKNOWN, which reads no fields. The model cannot widen
    // its own authority by inventing an intent.
    return contained ?? 'UNKNOWN';
  }

  async respond(utterance: Utterance, state: CallState, catalog: CatalogPort): Promise<Turn> {
    const started = performance.now();

    let intent: Intent;
    try {
      intent = await this.classifyIntentAsync(utterance.text);
    } catch (err) {
      // A model outage must not open the gate, and must not take the line down.
      if (this.opts.fallback) {
        return this.opts.fallback.respond(utterance, state, catalog);
      }
      throw err;
    }
    this.lastModelIntent = intent;

    // From here the flow is IDENTICAL to the deterministic reasoner. The model
    // chose an intent; it does not get to choose a field, and it never sees a
    // value. INTENT_FIELDS is static, so the reachable field set is auditable by
    // reading one table regardless of what the model said.
    const fields: readonly FieldRef[] = INTENT_FIELDS[intent];
    const traces: AccessTrace[] = [];
    let denied = false;

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
      const first = traces.find((t) => t.decision === 'DENY') as AccessTrace;
      const secure =
        first.effectiveClassification === 'PHI' ||
        first.requested.table === 'patient' ||
        first.requested.table === 'claim';
      reply =
        `I don't have access to that field.` +
        (secure
          ? ` If you need it, I can start a records request that goes out by secure mail or in person.`
          : ` I can help with hours, appointments, refills or billing instead.`);
    } else {
      const reader = catalog as unknown as {
        readValue?: (t: AccessTrace, subjectId: string) => string | undefined;
      };
      let filled = TEMPLATES[intent] ?? TEMPLATES.UNKNOWN;
      if (typeof reader.readValue === 'function') {
        for (const t of traces) {
          if (t.decision !== 'ALLOW') continue;
          const v = reader.readValue(t, state.rowSubjectId ?? '*');
          if (v !== undefined) filled = filled.replaceAll(`{${t.requested.field}}`, v);
        }
      }
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

/**
 * Response templates. Values are substituted from ALLOWED traces only, after
 * the model has finished — the model never authors a sentence containing
 * patient data, because it never receives any.
 */
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
  IDENTITY_CONFIRM: 'I can start verification. What is the date of birth on the account?',
  ASK_SSN: '',
  ASK_SUBSCRIBER_KEY: '',
  ASK_SSN_LAST4: '',
  ASK_INSURANCE_ID: '',
  ASK_HOME_ADDRESS: '',
  ASK_DIAGNOSIS: '',
  UNKNOWN: 'I can help with hours, appointments, refills and billing. Which would you like?',
};
