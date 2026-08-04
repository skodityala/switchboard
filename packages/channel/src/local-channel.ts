// PORT: ChannelPort — LOCAL ADAPTERS
// LOCAL ADAPTER: BrowserSpeechSink speaks via the OS speechSynthesis voices
//   (offline, no service, no download). LocalChannel wires the CallMachine to it.
// QUALIFYING ADAPTER: CALL-E SDK — see docs/adapters/CALLE.md.

import { CallMachine, SilentSink, type SpeechSink, type VerificationOracle } from './core.js';
import type { FieldRef } from '@switchboard/catalog';
import type {
  CallEvent,
  CallerIdentity,
  CallState,
  ChannelPort,
  SpokenTurn,
} from './port.js';

/**
 * speechSynthesis sink. Voices are installed with the OS, so this works with the
 * network unplugged — the reason this is the local adapter rather than a cloud TTS.
 * Guards on availability so the same bundle runs in a headless context.
 */
export class BrowserSpeechSink implements SpeechSink {
  private readonly synth: SpeechSynthesis | undefined;

  constructor(
    private readonly opts: { rate?: number; pitch?: number; voiceHint?: string } = {},
  ) {
    this.synth =
      typeof globalThis.speechSynthesis !== 'undefined' ? globalThis.speechSynthesis : undefined;
  }

  get available(): boolean {
    return this.synth !== undefined;
  }

  utter(text: string): void {
    if (!this.synth) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = this.opts.rate ?? 1.05;
    u.pitch = this.opts.pitch ?? 1;
    if (this.opts.voiceHint) {
      const v = this.synth.getVoices().find((x) => x.name.includes(this.opts.voiceHint!));
      if (v) u.voice = v;
    }
    this.synth.speak(u);
  }

  cancel(): void {
    this.synth?.cancel();
  }
}

/**
 * Verification against the catalog, without a disclosure path.
 *
 * This takes a COMPARISON function, not a lookup. Previously it received a
 * value-returning lookup, which callers satisfied by forging an ALLOW trace and
 * calling readValue() on patient.date_of_birth — PII, and a read that should
 * never have been possible. CatalogPort.matchesValue answers "does this match?"
 * with a boolean, so the field is never returned to anyone, including us.
 */
export class RowStoreOracle implements VerificationOracle {
  constructor(
    private readonly compare: (subjectId: string, field: FieldRef, candidate: string) => boolean,
  ) {}

  matches(subjectId: string, dateOfBirth: string): boolean {
    return this.compare(subjectId, { table: 'patient', field: 'date_of_birth' }, dateOfBirth);
  }
}

export interface LocalChannelOptions {
  readonly sink?: SpeechSink;
  readonly oracle: VerificationOracle;
  readonly now?: () => Date;
}

export class LocalChannel implements ChannelPort {
  readonly machine: CallMachine;

  constructor(opts: LocalChannelOptions) {
    this.machine = new CallMachine(
      opts.sink ?? new SilentSink(),
      opts.oracle,
      opts.now ?? ((): Date => new Date()),
    );
  }

  async startCall(subjectId: string): Promise<CallEvent> {
    return this.machine.startCall(subjectId);
  }
  async endCall(callId: string): Promise<CallEvent> {
    return this.machine.endCall(callId);
  }
  async receive(callId: string, text: string): Promise<SpokenTurn> {
    return this.machine.receive(callId, text);
  }
  async speak(callId: string, text: string): Promise<SpokenTurn> {
    return this.machine.speak(callId, text);
  }
  state(callId: string): CallState {
    return this.machine.state(callId);
  }
  identity(callId: string): CallerIdentity {
    return this.machine.identity(callId);
  }
  async attemptVerification(callId: string, dateOfBirth: string): Promise<CallerIdentity> {
    return this.machine.attemptVerification(callId, dateOfBirth);
  }
  turns(callId: string): readonly SpokenTurn[] {
    return this.machine.turns(callId);
  }
}
