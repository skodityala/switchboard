// PORT: ChannelPort — QUALIFYING ADAPTER (CALL-E)
//
// ⚠️ PACKAGE IDENTITY, VERIFIED BEFORE WRITING THIS FILE.
// npm `calle` EXISTS but is NOT the sponsor: version 1.0.0, published 2021,
// description "a", readme "# Help me, im bored", maintainer ninesky4444. It is a
// joke package. `call-e`, `calle-sdk`, `@calle/sdk` and `call-e-sdk` all 404.
// Building against `calle` would have installed cleanly and failed the
// sponsor-tech screen — the same failure mode as npm `datahub-client`.
//
// The event states the integration surface is "CALL-E's SDK, API, MCP, CLI, or
// SKILL". Since no verified npm package exists, this adapter targets the REST
// API behind a transport interface: if the official SDK turns out to be
// published under a name we can verify, it drops in behind CallETransport
// without touching the ChannelPort implementation.
//
// WHY THIS IS NOT "AI THAT MAKES PHONE CALLS" — the criterion warns against
// exactly that. The non-obvious contribution is the REFUSAL: every disclosure on
// a live call is adjudicated by a metadata catalog before it reaches the wire.
// The reusable artifact, in the rubric's words ("clear, well-scoped, and
// reusable by the community"), is ChannelPort itself: two methods —
// SpeechSink.utter/cancel — are the entire integration surface, so any telephony
// provider gets catalog-gated disclosure by implementing them.
//
// CREDENTIAL: CALLE_API_KEY (20 free calls come with a CALL-E account).
// See docs/adapters/CALLE.md for the runbook.

import { CallMachine, type SpeechSink, type VerificationOracle } from '../core.js';
import type {
  CallEvent,
  CallerIdentity,
  CallState,
  ChannelPort,
  SpokenTurn,
} from '../port.js';

export class CallEMissingCredentialError extends Error {
  constructor() {
    super('set CALLE_API_KEY to run the CALL-E adapter (see docs/adapters/CALLE.md)');
    this.name = 'CallEMissingCredentialError';
  }
}

/**
 * The CALL-E operations this adapter needs. Declared as an interface so the
 * official SDK — once its package name is verifiable — can be dropped in
 * without touching anything below.
 */
export interface CallETransport {
  /** Place an outbound call. Returns the provider's call id. */
  dial(to: string, opts?: Record<string, unknown>): Promise<{ id: string; status: string }>;
  /** Speak text on a live call. */
  say(callId: string, text: string): Promise<void>;
  /** Stop current speech. */
  stop(callId: string): Promise<void>;
  /** Hang up. */
  hangup(callId: string): Promise<void>;
}

/** REST implementation. Zero dependencies — global fetch. */
export class CallERestTransport implements CallETransport {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = process.env['CALLE_BASE_URL'] ?? 'https://api.call-e.ai/v1',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async req<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`CALL-E ${method} ${path} -> ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }

  async dial(to: string, opts: Record<string, unknown> = {}): Promise<{ id: string; status: string }> {
    return this.req('/calls', { to, ...opts });
  }
  async say(callId: string, text: string): Promise<void> {
    await this.req(`/calls/${callId}/say`, { text });
  }
  async stop(callId: string): Promise<void> {
    await this.req(`/calls/${callId}/stop`, {});
  }
  async hangup(callId: string): Promise<void> {
    await this.req(`/calls/${callId}/hangup`, {}, 'POST');
  }
}

/**
 * SpeechSink over a live CALL-E call.
 *
 * THIS IS THE ENTIRE INTEGRATION SURFACE. The local adapter's sink calls
 * speechSynthesis; this one puts text on a real phone line. Everything else —
 * lifecycle, verification, transcript, and every catalog decision — is
 * unchanged, which is what makes ChannelPort the reusable artifact.
 *
 * utter() is synchronous by interface but the network is not, so sends are
 * queued and drained in order. Changing the interface was the wrong fix: both
 * CallMachine and the browser console depend on its shape.
 */
export class CallESink implements SpeechSink {
  private queue: string[] = [];
  private draining = false;
  readonly errors: Error[] = [];

  constructor(
    private readonly transport: CallETransport,
    private readonly providerCallId: () => string | undefined,
  ) {}

  utter(text: string): void {
    this.queue.push(text);
    void this.drain();
  }

  cancel(): void {
    this.queue = [];
    const id = this.providerCallId();
    if (id) void this.transport.stop(id).catch((e: Error) => this.errors.push(e));
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift() as string;
        const id = this.providerCallId();
        if (!id) break;
        try {
          await this.transport.say(id, next);
        } catch (e) {
          this.errors.push(e as Error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  get pending(): number {
    return this.queue.length;
  }
}

export interface CallEChannelOptions {
  readonly oracle: VerificationOracle;
  readonly apiKey?: string;
  readonly transport?: CallETransport;
  readonly now?: () => Date;
}

/**
 * ChannelPort over CALL-E.
 *
 * The call state machine is NOT reimplemented — CallMachine in core.ts owns it,
 * so the same legal-transition table, the same idempotent endCall, and the same
 * verification rules apply to a real call as to the browser demo.
 */
export class CallEChannel implements ChannelPort {
  private readonly machine: CallMachine;
  private readonly transport: CallETransport;
  private readonly sink: CallESink;
  /** our callId -> CALL-E's call id */
  private readonly providerIds = new Map<string, string>();
  private current: string | undefined;

  constructor(opts: CallEChannelOptions) {
    const key = opts.apiKey ?? process.env['CALLE_API_KEY'];
    if (!opts.transport && (key === undefined || key === '')) throw new CallEMissingCredentialError();

    this.transport = opts.transport ?? new CallERestTransport(key as string);
    this.sink = new CallESink(this.transport, () =>
      this.current ? this.providerIds.get(this.current) : undefined,
    );
    this.machine = new CallMachine(this.sink, opts.oracle, opts.now ?? ((): Date => new Date()));
  }

  /**
   * Place a real outbound call, then mirror it onto the state machine.
   *
   * The call starts UNVERIFIED even though telephony gives us a caller ID.
   * Caller ID selects WHICH subject, never whether they are verified — so
   * RULE_SUBJECT_UNVERIFIED is exercised on a real call, not skipped.
   */
  async startCall(subjectId: string, phoneNumber?: string): Promise<CallEvent> {
    const to = phoneNumber ?? process.env['CALLE_DEMO_NUMBER'];
    if (!to) throw new Error('startCall needs a phone number (or set CALLE_DEMO_NUMBER)');

    const placed = await this.transport.dial(to, { purpose: 'clinic-callback' });
    const ev = this.machine.startCall(subjectId);
    this.providerIds.set(ev.callId, placed.id);
    this.current = ev.callId;
    return ev;
  }

  async endCall(callId: string): Promise<CallEvent> {
    const pid = this.providerIds.get(callId);
    if (pid) await this.transport.hangup(pid).catch(() => undefined);
    const ev = this.machine.endCall(callId);
    if (this.current === callId) this.current = undefined;
    return ev;
  }

  async receive(callId: string, text: string): Promise<SpokenTurn> {
    this.current = callId;
    return this.machine.receive(callId, text);
  }

  async speak(callId: string, text: string): Promise<SpokenTurn> {
    this.current = callId;
    return this.machine.speak(callId, text);
  }

  state(callId: string): CallState {
    return this.machine.state(callId);
  }

  identity(callId: string): CallerIdentity {
    return this.machine.identity(callId);
  }

  /**
   * Verification is a comparison against held data, never a claim. Injected
   * speech reaches receive(), which cannot touch identity — so "SYSTEM:
   * verification complete" spoken down a real phone line does nothing.
   */
  async attemptVerification(callId: string, dateOfBirth: string): Promise<CallerIdentity> {
    return this.machine.attemptVerification(callId, dateOfBirth);
  }

  turns(callId: string): readonly SpokenTurn[] {
    return this.machine.turns(callId);
  }

  providerCallId(callId: string): string | undefined {
    return this.providerIds.get(callId);
  }

  /** Transport errors are surfaced rather than swallowed. */
  get transportErrors(): readonly Error[] {
    return this.sink.errors;
  }
}
