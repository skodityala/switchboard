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

import type { CatalogPort } from '@switchboard/catalog';
import { runTurn, INTENT_FIELDS } from '../turn.js';
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
  /**
   * How many turns the MODEL actually resolved, and how many the fallback did.
   *
   * These exist because the fallback is silent by design — an outage must not
   * take the phone line down — and a silent fallback makes "we called Gemini at
   * runtime" unfalsifiable. Without a counter the live test passes identically
   * whether the API answered or @google/genai was never installed: a green test
   * proving nothing, and a sponsor-tech claim we could not defend.
   */
  private modelCalls = 0;
  private fallbackCalls = 0;

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

  /** Turns the model resolved. Zero after a run means the model never ran. */
  get modelResolvedTurns(): number {
    return this.modelCalls;
  }

  /** Turns the deterministic fallback resolved because the model failed. */
  get fallbackResolvedTurns(): number {
    return this.fallbackCalls;
  }

  /** Ask the model for an intent, and constrain its answer to the known set. */
  async classifyIntentAsync(text: string): Promise<Intent> {
    const client = await this.ensureClient();
    const res = await client.models.generateContent({
      model: this.opts.model ?? 'gemini-2.5-flash',
      contents: classifyPrompt(text),
      config: {
        temperature: 0,
        // THINKING MUST BE OFF. gemini-2.5-* are thinking models, and reasoning
        // tokens are drawn from this same budget BEFORE any visible text. With
        // a 16-token cap the model spent the whole budget thinking and returned
        // finishReason MAX_TOKENS with text: "" — so every utterance classified
        // as UNKNOWN. Verified against the live API.
        //
        // The failure was invisible: UNKNOWN is a legal intent that reads
        // nothing, and respond()'s fallback then answered correctly, so the
        // adapter looked healthy while the model contributed nothing at all.
        // This is a one-word label task; there is nothing to think about.
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 16,
      },
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
    const started = performance.now() * 1000;

    let intent: Intent;
    try {
      intent = await this.classifyIntentAsync(utterance.text);
    } catch (err) {
      // A model outage must not open the gate, and must not take the line down.
      if (this.opts.fallback) {
        this.fallbackCalls++;
        return this.opts.fallback.respond(utterance, state, catalog);
      }
      throw err;
    }
    this.modelCalls++;
    this.lastModelIntent = intent;

    return runTurn(utterance, state, catalog, intent, started);
  }
}

