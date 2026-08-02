// PORT: MemoryPort
// LOCAL ADAPTER: SQLite structured state per caller + a local vector index
//   (hashed lexical vectors, plain cosine). Zero dependencies, zero network.
// QUALIFYING ADAPTER: CockroachDB — REQUIRED before submitting to
//   CockroachDB × AWS. Must use >=2 CockroachDB tools (distributed vector index,
//   MCP Server, ccloud CLI) at runtime.
// Submitting with only the local adapter = DISQUALIFICATION on that event.

import type { AccessTrace, Classification, FieldRef } from '@switchboard/catalog';

/**
 * What a memory entry is. Three kinds share one table on purpose: conversation
 * turns, resolved entities, and access DECISIONS all live in the same substrate,
 * so "what the agent remembers" and "what the agent was allowed to see" are the
 * same queryable history rather than two systems that can disagree.
 */
export type MemoryKind =
  | 'TURN' // something said, by either party
  | 'ENTITY' // a resolved fact about the caller (appointment time, refill status)
  | 'DECISION'; // an adjudication that happened — audit and memory, one row

export interface MemoryEntry {
  readonly entryId: string;
  readonly callId: string;
  /**
   * The caller this memory belongs to. Every read is scoped by it, and there is
   * no query that omits it — cross-caller recall is not a permission that can be
   * granted, it is an operation the interface cannot express.
   */
  readonly subjectId: string;
  readonly kind: MemoryKind;
  /** Searchable content. Never holds a restricted value; see `field`. */
  readonly text: string;
  /**
   * Set when this memory refers to a catalog field. Recall re-adjudicates the
   * field through CatalogPort before returning the entry, so a memory written
   * when a field was permissive cannot be read back after it is reclassified.
   */
  readonly field?: FieldRef;
  /** Classification observed at write time, for drift detection. */
  readonly classification?: Classification;
  readonly createdAt: string;
  /** Hashed lexical vector, L2-normalised. See core.ts embed(). */
  readonly vector: readonly number[];
}

/** Input to remember(); ids, timestamps and vectors are assigned by the adapter. */
export interface MemoryWrite {
  readonly callId: string;
  readonly subjectId: string;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly field?: FieldRef;
  readonly classification?: Classification;
}

export interface RecallQuery {
  /** REQUIRED. There is no global recall. */
  readonly subjectId: string;
  readonly text: string;
  readonly limit?: number;
  readonly kinds?: readonly MemoryKind[];
  /** Channel and verification state, forwarded to the gate on re-adjudication. */
  readonly channel: 'PHONE' | 'CHAT';
  readonly subjectVerified: boolean;
  readonly callId: string;
}

export interface RecallHit {
  readonly entry: MemoryEntry;
  readonly score: number;
  /** Present when the entry named a field and had to be adjudicated. */
  readonly trace?: AccessTrace;
}

/**
 * A memory that matched the query but was gated out. Carries NO text — a
 * withheld memory must not leak through the shape of its own refusal.
 */
export interface WithheldMemory {
  readonly entryId: string;
  readonly kind: MemoryKind;
  readonly field: FieldRef;
  readonly score: number;
  readonly trace: AccessTrace;
}

export interface RecallResult {
  readonly hits: readonly RecallHit[];
  readonly withheld: readonly WithheldMemory[];
  /** Every adjudication performed during this recall. */
  readonly traces: readonly AccessTrace[];
  readonly scanned: number;
  readonly durationMicros: number;
}

export interface MemoryPort {
  remember(write: MemoryWrite): Promise<MemoryEntry>;

  /**
   * Scoped, gated retrieval. Requires a CatalogPort because a memory that names
   * a field is re-adjudicated at read time, not trusted because it was written.
   */
  recall(query: RecallQuery): Promise<RecallResult>;

  /** Ingest an access decision as a DECISION memory. Audit and memory, one row. */
  rememberDecision(trace: AccessTrace, subjectId: string): Promise<MemoryEntry>;

  /** Turns for one call, oldest first — conversation continuity. */
  callHistory(callId: string, subjectId: string): Promise<readonly MemoryEntry[]>;
}
