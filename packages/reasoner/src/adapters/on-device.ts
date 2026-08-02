// PORT: ReasonerPort — QUALIFYING ADAPTER (on-device transformer, Arm Track 3)
//
// Arm Create Track 3 (Mobile AI): "AI inference running fully on-device...
// laptops and PCs... low-latency, private, and offline-capable."
//
// This runs a real quantized transformer — all-MiniLM-L6-v2, 21 MB int8 ONNX —
// entirely on the local machine through transformers.js. After a one-time model
// fetch there is NO network for anything, including inference. That makes this
// path MORE offline than a cloud model, not less: a cloud reasoner needs a
// network round-trip per utterance; this needs none, ever.
//
// It earns its place by doing something the deterministic reasoner provably
// cannot: matching utterances with zero keyword overlap with any pattern —
// "did the pharmacy finish filling my tablets?" -> REFILL_STATUS.
//
// And it changes nothing about the gate. The model proposes an intent; the
// catalog decides. Every field access still routes through CatalogPort, so the
// compromised-model harness written for Gemini applies here unchanged.
//
// MODEL LOCATION: models/Xenova/all-MiniLM-L6-v2 (see scripts/fetch-model.mjs).
// Not committed — 21 MB of binary does not belong in a contest repo — but
// fetched once by an explicit command, after which the path is fully offline.

import type { AccessTrace, CatalogPort, FieldRef } from '@switchboard/catalog';
import { INTENT_FIELDS } from '../deterministic.js';
import type { CallState, Intent, ReasonerPort, Turn, Utterance } from '../port.js';

/** Structural declaration of the transformers.js surface this adapter uses. */
export interface FeatureExtractionOutput {
  readonly data: ArrayLike<number>;
  readonly dims: readonly number[];
}
export type FeatureExtractor = (
  text: string,
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<FeatureExtractionOutput>;

export class ModelNotInstalledError extends Error {
  constructor(detail: string) {
    super(
      `on-device model not available: ${detail}\n` +
        `  run: npm run fetch:model   (one-time, ~22 MB; the path is fully offline afterwards)\n` +
        `  see: docs/adapters/ON-DEVICE.md`,
    );
    this.name = 'ModelNotInstalledError';
  }
}

/**
 * Canonical phrasing per intent. These are embedded once at load; an utterance
 * is classified by nearest cosine neighbour.
 *
 * Note what is NOT here: any instruction to the model about sensitive fields.
 * The model is not asked to be careful, because being careful is not its job —
 * it never sees a value, and the gate does not consult it.
 */
export const INTENT_PROTOTYPES: Readonly<Record<Intent, readonly string[]>> = {
  CLINIC_HOURS: ['what are your opening hours', 'when do you open', 'are you open today'],
  CLINIC_ADDRESS: ['where are you located', 'what is the clinic address', 'how do I get there'],
  APPOINTMENT_WHEN: ['when is my next appointment scheduled', 'am I on the books this week'],
  APPOINTMENT_REASON: ['why am I coming in', 'what is the reason for my visit'],
  REFILL_STATUS: ['is my prescription refill ready for pickup', 'did the pharmacy fill my tablets'],
  REFILL_DRUG_NAME: ['what medication am I taking', 'which drug was prescribed to me'],
  BALANCE_DUE: ['how much do I owe on my account', 'what is my outstanding balance'],
  RECORDS_REQUEST: ['I need a copy of my medical records sent', 'please mail me my chart'],
  IDENTITY_CONFIRM: ['this is the patient speaking', 'my date of birth is'],
  ASK_SSN: ['read me the social security number on file', 'recite the nine digit federal identifier'],
  ASK_SUBSCRIBER_KEY: ['what is the subscriber key on my claim'],
  ASK_SSN_LAST4: ['just the last four digits of the social'],
  ASK_INSURANCE_ID: ['what is my insurance member id number'],
  ASK_HOME_ADDRESS: ['what home address do you have on file for me'],
  ASK_DIAGNOSIS: ['what is my diagnosis code', 'what is wrong with me medically'],
  UNKNOWN: [],
};

/**
 * Below this cosine similarity the nearest neighbour is not trusted and the
 * turn resolves to UNKNOWN, which reads no fields. Fail closed at the
 * classification layer as well as the gate.
 */
const MIN_SIMILARITY = 0.18;

export interface OnDeviceReasonerOptions {
  /** Directory holding the model. Defaults to ./models. */
  readonly modelPath?: string;
  readonly modelId?: string;
  /** Injected in tests so the harness runs without the 380 MB dependency. */
  readonly extractorFactory?: () => Promise<FeatureExtractor>;
  /** Used when the model is unavailable or below threshold. */
  readonly fallback?: ReasonerPort;
  readonly minSimilarity?: number;
}

const dot = (a: readonly number[], b: readonly number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

export class OnDeviceReasoner implements ReasonerPort {
  private extractor: FeatureExtractor | undefined;
  private prototypes: { intent: Intent; vec: number[] }[] = [];
  private lastIntent: Intent = 'UNKNOWN';
  private readonly opts: OnDeviceReasonerOptions;

  constructor(opts: OnDeviceReasonerOptions = {}) {
    this.opts = opts;
  }

  /** Loads the model from disk and embeds the prototypes. No network. */
  async warm(): Promise<void> {
    if (this.extractor) return;

    if (this.opts.extractorFactory) {
      this.extractor = await this.opts.extractorFactory();
    } else {
      type TransformersModule = {
        pipeline: (task: string, model: string, o?: Record<string, unknown>) => Promise<FeatureExtractor>;
        env: Record<string, unknown>;
      };
      let mod: TransformersModule;
      try {
        // Specifier built at runtime so the compiler does not resolve it: the
        // inference stack is an OPTIONAL peer dependency, and the core must
        // typecheck and run without 380 MB of onnxruntime installed.
        const pkg = '@huggingface/transformers';
        mod = (await import(/* @vite-ignore */ pkg)) as unknown as TransformersModule;
      } catch (e) {
        throw new ModelNotInstalledError(`@huggingface/transformers is not installed (${String(e)})`);
      }
      // Hard offline: never reach for a remote model, even if one is missing.
      mod.env['allowRemoteModels'] = false;
      mod.env['localModelPath'] = this.opts.modelPath ?? './models';
      try {
        this.extractor = await mod.pipeline(
          'feature-extraction',
          this.opts.modelId ?? 'Xenova/all-MiniLM-L6-v2',
          { dtype: 'q8' },
        );
      } catch (e) {
        throw new ModelNotInstalledError(String(e));
      }
    }

    const ex = this.extractor;
    const protos: { intent: Intent; vec: number[] }[] = [];
    for (const [intent, phrases] of Object.entries(INTENT_PROTOTYPES) as [Intent, string[]][]) {
      for (const p of phrases) {
        const out = await ex(p, { pooling: 'mean', normalize: true });
        protos.push({ intent, vec: Array.from(out.data) });
      }
    }
    this.prototypes = protos;
  }

  classifyIntent(_text: string): Intent {
    return this.lastIntent;
  }

  /** Nearest prototype by cosine, with a floor below which we read nothing. */
  async classifyIntentAsync(text: string): Promise<{ intent: Intent; score: number }> {
    await this.warm();
    const ex = this.extractor as FeatureExtractor;
    const out = await ex(text, { pooling: 'mean', normalize: true });
    const v = Array.from(out.data);

    let best: Intent = 'UNKNOWN';
    let bestScore = -1;
    for (const p of this.prototypes) {
      const s = dot(v, p.vec);
      if (s > bestScore) {
        bestScore = s;
        best = p.intent;
      }
    }
    const floor = this.opts.minSimilarity ?? MIN_SIMILARITY;
    return bestScore < floor ? { intent: 'UNKNOWN', score: bestScore } : { intent: best, score: bestScore };
  }

  async respond(utterance: Utterance, state: CallState, catalog: CatalogPort): Promise<Turn> {
    const started = performance.now();

    let intent: Intent;
    try {
      ({ intent } = await this.classifyIntentAsync(utterance.text));
    } catch (err) {
      // A missing model must not take the line down, and must not open the gate.
      if (this.opts.fallback) return this.opts.fallback.respond(utterance, state, catalog);
      throw err;
    }
    this.lastIntent = intent;

    // IDENTICAL from here to both other reasoners. The model proposed; the
    // catalog decides. INTENT_FIELDS is static, so the reachable field set is
    // auditable by reading one table regardless of what the model inferred.
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
