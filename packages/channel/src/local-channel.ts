// PORT: ChannelPort — LOCAL ADAPTERS
// LOCAL ADAPTER: BrowserSpeechSink speaks via the OS speechSynthesis voices
//   (offline, no service, no download). LocalChannel wires the CallMachine to it.
// QUALIFYING ADAPTER: CALL-E SDK — see docs/adapters/CALLE.md.

import { CallMachine, SilentSink, type SpeechSink, type VerificationOracle } from './core.js';
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
 * Verification against the catalog's own row store. Note what this does NOT do:
 * it never returns the date of birth, only whether a supplied value matches. The
 * field stays PII and unreadable; verification is a comparison, not a read.
 */
export class RowStoreOracle implements VerificationOracle {
  constructor(private readonly lookup: (subjectId: string, field: string) => string | undefined) {}

  matches(subjectId: string, dateOfBirth: string): boolean {
    const onFile = this.lookup(subjectId, 'patient.date_of_birth');
    if (onFile === undefined) return false;
    return this.normalise(onFile) === this.normalise(dateOfBirth);
  }

  /** Accepts 1954-03-11, 03/11/1954, "March 11 1954". */
  private normalise(s: string): string {
    const t = s.toLowerCase().trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
    if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
    const MONTHS = [
      'january','february','march','april','may','june',
      'july','august','september','october','november','december',
    ];
    const words = /^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
    if (words) {
      const m = MONTHS.indexOf(words[1]!);
      if (m >= 0) return `${words[3]}-${String(m + 1).padStart(2, '0')}-${words[2]!.padStart(2, '0')}`;
    }
    return t;
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
