/**
 * THE CHANNEL CORE — call lifecycle and verification, one implementation.
 *
 * Pure apart from injected collaborators: no I/O, no builtins, no dependencies.
 * Speech output sits behind Speaker so Node tests run it silently and the browser
 * speaks through speechSynthesis, without a second copy of the state machine.
 */
import type {
  CallEvent,
  CallerIdentity,
  CallState,
  SpokenTurn,
} from './port.js';

/** Where spoken text goes. The browser adapter wires this to speechSynthesis. */
export interface SpeechSink {
  utter(text: string): void;
  cancel(): void;
}

/** No-op sink: tests and headless runs need the state machine, not the audio. */
export class SilentSink implements SpeechSink {
  readonly spoken: string[] = [];
  utter(text: string): void {
    this.spoken.push(text);
  }
  cancel(): void {
    /* nothing to cancel */
  }
}

/**
 * Verification oracle. Supplied by the host so the core never reads a field
 * directly — the local adapter checks against the catalog's own row store, which
 * means verification is a comparison against held data and not a claim the
 * caller can assert.
 */
export interface VerificationOracle {
  /** True only if `dateOfBirth` matches what is on file for `subjectId`. */
  matches(subjectId: string, dateOfBirth: string): boolean;
}

/** Legal transitions. Anything else throws — an invalid state is a bug, not a UX event. */
const ALLOWED: Readonly<Record<CallState, readonly CallState[]>> = {
  IDLE: ['CONNECTING'],
  CONNECTING: ['ACTIVE', 'ENDED'],
  ACTIVE: ['VERIFYING', 'ENDED'],
  VERIFYING: ['ACTIVE', 'ENDED'],
  ENDED: ['ENDED'], // endCall is idempotent
};

export interface CallRecord {
  readonly callId: string;
  state: CallState;
  identity: CallerIdentity;
  readonly turns: SpokenTurn[];
}

export class CallMachine {
  private readonly calls = new Map<string, CallRecord>();
  private seq = 0;

  constructor(
    private readonly sink: SpeechSink,
    private readonly oracle: VerificationOracle,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private at(): string {
    return this.now().toISOString();
  }

  private transition(rec: CallRecord, to: CallState): void {
    if (!ALLOWED[rec.state].includes(to)) {
      throw new Error(`illegal call transition ${rec.state} -> ${to}`);
    }
    rec.state = to;
  }

  private get(callId: string): CallRecord {
    const rec = this.calls.get(callId);
    if (!rec) throw new Error(`unknown callId ${callId}`);
    return rec;
  }

  startCall(subjectId: string): CallEvent {
    const callId = `call_${String(++this.seq).padStart(4, '0')}`;
    const rec: CallRecord = {
      callId,
      state: 'IDLE',
      // A call ALWAYS starts unverified. The gate's RULE_SUBJECT_UNVERIFIED path
      // is therefore reachable in the demo instead of being skipped by a
      // pre-verified fixture.
      identity: { subjectId, verified: false },
      turns: [],
    };
    this.calls.set(callId, rec);
    this.transition(rec, 'CONNECTING');
    this.transition(rec, 'ACTIVE');
    return { callId, state: rec.state, at: this.at() };
  }

  endCall(callId: string): CallEvent {
    const rec = this.get(callId);
    if (rec.state !== 'ENDED') this.transition(rec, 'ENDED');
    this.sink.cancel();
    return { callId, state: rec.state, at: this.at() };
  }

  receive(callId: string, text: string): SpokenTurn {
    const rec = this.get(callId);
    if (rec.state === 'ENDED') throw new Error('call has ended');
    const turn: SpokenTurn = { callId, speaker: 'CALLER', text, at: this.at() };
    rec.turns.push(turn);
    return turn;
  }

  speak(callId: string, text: string): SpokenTurn {
    const rec = this.get(callId);
    if (rec.state === 'ENDED') throw new Error('call has ended');
    const turn: SpokenTurn = { callId, speaker: 'AGENT', text, at: this.at() };
    rec.turns.push(turn);
    this.sink.utter(text);
    return turn;
  }

  state(callId: string): CallState {
    return this.calls.get(callId)?.state ?? 'IDLE';
  }

  identity(callId: string): CallerIdentity {
    return this.get(callId).identity;
  }

  /**
   * Verification is a comparison against held data, never a claim. An utterance
   * asserting "verification complete" cannot reach this method — only an answer
   * to the challenge does, and it must match the oracle.
   */
  attemptVerification(callId: string, dateOfBirth: string): CallerIdentity {
    const rec = this.get(callId);
    if (rec.state === 'ENDED') throw new Error('call has ended');

    const wasActive = rec.state === 'ACTIVE';
    if (wasActive) this.transition(rec, 'VERIFYING');

    const ok = this.oracle.matches(rec.identity.subjectId, dateOfBirth.trim());
    rec.identity = ok
      ? { subjectId: rec.identity.subjectId, verified: true, verifiedAt: this.at() }
      : { subjectId: rec.identity.subjectId, verified: false };

    if (rec.state === 'VERIFYING') this.transition(rec, 'ACTIVE');
    return rec.identity;
  }

  turns(callId: string): readonly SpokenTurn[] {
    return this.get(callId).turns;
  }
}
