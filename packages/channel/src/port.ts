// PORT: ChannelPort
// LOCAL ADAPTER: simulated phone call in the browser — call lifecycle states plus
//   spoken responses via the built-in speechSynthesis API. No external service,
//   no network, works offline (voices ship with the OS).
// QUALIFYING ADAPTER: CALL-E SDK/API/MCP placing real outbound calls — REQUIRED
//   before submitting to CALL-E. See docs/adapters/CALLE.md.
// Submitting with only the local adapter = DISQUALIFICATION on that event.

/**
 * Call lifecycle. A real telephony adapter has more states (RINGING, BUSY,
 * FAILED); these are the ones the demo and the gate care about, and a qualifying
 * adapter maps its own onto them.
 */
export type CallState =
  | 'IDLE' // no call
  | 'CONNECTING' // dialling / picking up
  | 'ACTIVE' // in conversation
  | 'VERIFYING' // identity challenge in flight
  | 'ENDED';

export type Speaker = 'CALLER' | 'AGENT';

export interface CallEvent {
  readonly callId: string;
  readonly state: CallState;
  readonly at: string;
}

export interface SpokenTurn {
  readonly callId: string;
  readonly speaker: Speaker;
  readonly text: string;
  readonly at: string;
}

/**
 * Identity of the party on the line. The local adapter fabricates nothing: a call
 * starts UNVERIFIED and only becomes verified through an explicit challenge, so
 * the gate's RULE_SUBJECT_UNVERIFIED path is exercised in the demo rather than
 * being skipped by a pre-verified fixture.
 */
export interface CallerIdentity {
  readonly subjectId: string;
  readonly verified: boolean;
  /** Set once a verification challenge has been answered correctly. */
  readonly verifiedAt?: string;
}

export interface ChannelPort {
  /** Begin a call. Returns the callId used for every trace and memory row. */
  startCall(subjectId: string): Promise<CallEvent>;

  /** End it. Idempotent — ending an ended call is not an error. */
  endCall(callId: string): Promise<CallEvent>;

  /** What the caller said. */
  receive(callId: string, text: string): Promise<SpokenTurn>;

  /**
   * What the agent says back. The local adapter speaks it aloud through
   * speechSynthesis; a telephony adapter puts it on the wire.
   */
  speak(callId: string, text: string): Promise<SpokenTurn>;

  state(callId: string): CallState;

  identity(callId: string): CallerIdentity;

  /**
   * Answer a verification challenge. The local adapter compares against the
   * catalog's own record rather than accepting a claim — an injected
   * "verification complete" must never move this needle.
   */
  attemptVerification(callId: string, dateOfBirth: string): Promise<CallerIdentity>;
}
