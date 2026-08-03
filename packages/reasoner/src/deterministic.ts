// PORT: ReasonerPort — LOCAL ADAPTER (deterministic, on-device)
// LOCAL ADAPTER: intent match over normalized text + templated responses. Pure
//   functions. No model inference, no network, no wall-clock reads. This adapter
//   IS the Arm Create entry: on-device, arm64, zero-network, $0 per call.
// QUALIFYING ADAPTER: AWS Bedrock — REQUIRED before submitting to
//   CockroachDB × AWS (>=1 AWS service is mandatory there).
// Submitting with only the local adapter = DISQUALIFICATION on that event.

import type { CatalogPort } from '@switchboard/catalog';
import { runTurn } from './turn.js';

import type { CallState, Intent, ReasonerPort, Turn, Utterance } from './port.js';


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



export class DeterministicReasoner implements ReasonerPort {
  classifyIntent(text: string): Intent {
    const n = normalize(text);
    const c = collapsed(text);
    for (const p of PATTERNS) {
      if (p.test(n, c)) return p.intent;
    }
    return 'UNKNOWN';
  }

  async respond(utterance: Utterance, state: CallState, catalog: CatalogPort): Promise<Turn> {
    return runTurn(utterance, state, catalog, this.classifyIntent(utterance.text));
  }

  /**
   * Same pipeline with the intent supplied from outside — used by the browser's
   * on-device path so an externally-computed intent still traverses the one
   * shared turn implementation instead of a reimplementation in the page.
   */
  async respondWithIntent(
    utterance: Utterance,
    state: CallState,
    catalog: CatalogPort,
    intent: Intent,
  ): Promise<Turn> {
    return runTurn(utterance, state, catalog, intent);
  }
}
