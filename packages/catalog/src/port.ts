// PORT: CatalogPort
// LOCAL ADAPTER: SQLite metadata catalog (schema.sql) — tables → fields → PII
//   classification → lineage edges. Resolves every field access to a Decision
//   and emits a full AccessTrace. Zero network.
// QUALIFYING ADAPTER: DataHub (MCP Server / Agent Context Kit) — REQUIRED before
//   submitting to DataHub. Reads classification + lineage from the DataHub graph
//   AND writes access decisions back to it via emit() (contribute-back).
// Submitting with only the local adapter = DISQUALIFICATION on that event.

/**
 * Classification of a single field. There is no implicit "public" tier: a field
 * the catalog has never seen resolves to UNCLASSIFIED, and UNCLASSIFIED is
 * DENIED. This is the load-bearing default of the whole product — an operator
 * who forgets to classify a new column fails closed, not open.
 */
export type Classification =
  | 'PUBLIC' // clinic hours, address — disclosable to any caller
  | 'OPERATIONAL' // appointment slots, refill status — disclosable to a verified caller
  | 'PII' // name, phone, DOB — disclosable only to the verified data subject
  | 'SENSITIVE_PII' // SSN, insurance ID, full address — never disclosable by phone
  | 'PHI' // diagnosis, medication, notes — never disclosable by phone
  | 'UNCLASSIFIED'; // absent from the catalog. Always denied.

export type Decision = 'ALLOW' | 'DENY';

/** Why a decision came out the way it did. One rule fires per decision. */
export type RuleId =
  | 'RULE_UNCLASSIFIED_DENY' // not in catalog → deny (fail closed)
  | 'RULE_NEVER_BY_PHONE' // SENSITIVE_PII / PHI over ChannelPort → deny
  | 'RULE_SUBJECT_UNVERIFIED' // PII requested before caller identity verified → deny
  | 'RULE_SUBJECT_MISMATCH' // verified caller is not the data subject → deny
  | 'RULE_PUBLIC_ALLOW'
  | 'RULE_OPERATIONAL_ALLOW'
  | 'RULE_SUBJECT_SELF_ALLOW';

/** A fully-qualified field reference. */
export interface FieldRef {
  readonly table: string;
  readonly field: string;
}

/** One hop in the lineage chain the decision walked. */
export interface LineageHop {
  readonly from: FieldRef;
  readonly to: FieldRef;
  readonly transform: string; // 'copy' | 'derive' | 'aggregate' | 'join' | ...
  /**
   * Classification carried by `to`. Lineage PROPAGATES restriction: a field
   * derived from PHI is at least as restricted as its source, even if someone
   * classified the derived column loosely. The trace shows the inherited tier
   * so a judge can see the enforcement was not a lookup on the leaf alone.
   */
  readonly inheritedClassification: Classification;
}

/**
 * The hero artifact. One shape for ALLOW and DENY alike — a denial is not an
 * error, it is a decision with a different verdict, so the panel, the log and
 * the metadata sink all consume identical records.
 *
 * Three consumers, one object:
 *   render() → the live policy-trace panel (the video's first 20 seconds)
 *   log()    → append-only JSONL audit stream (CockroachDB criterion 4:
 *              "secure, observable") — this IS the observability artifact
 *   emit()   → external metadata sink (DataHub usage + lineage contribute-back)
 */
export interface AccessTrace {
  readonly traceId: string;
  readonly callId: string;
  /** Verbatim caller utterance that triggered the access. Kept for red-teaming. */
  readonly utterance: string;
  readonly intent: string;
  readonly requested: FieldRef;
  readonly resolvedClassification: Classification;
  /** Restriction after lineage propagation. Never looser than resolved. */
  readonly effectiveClassification: Classification;
  readonly decision: Decision;
  readonly rule: RuleId;
  /** One human sentence, shown in the panel and spoken by the agent. */
  readonly rationale: string;
  readonly lineage: readonly LineageHop[];
  readonly channel: Channel;
  readonly subjectVerified: boolean;
  readonly decidedAt: string; // ISO-8601
  readonly durationMicros: number; // catalog decision only, excludes rendering
}

/**
 * Where a disclosure would actually go.
 *
 * This is not cosmetic. A field's disclosability depends on the channel: an SSN
 * is never readable aloud on a phone call, and it is equally never sendable in
 * an email or a Slack message. Naming the channel in the request means the gate
 * evaluates the same rule for every surface an agent can reach, rather than
 * having a phone rule and an implicit "everything else is fine".
 */
export type Channel =
  | 'PHONE'
  | 'CHAT'
  | 'EMAIL'
  | 'SLACK'
  | 'DISCORD'
  | 'TELEGRAM'
  | 'SMS'
  | 'WHATSAPP'
  | 'X'
  | 'IMESSAGE'
  | 'GITHUB'
  | 'UNKNOWN_CHANNEL';

export interface AccessRequest {
  readonly callId: string;
  readonly utterance: string;
  readonly intent: string;
  readonly requested: FieldRef;
  readonly channel: Channel;
  readonly subjectVerified: boolean;
  /** Identity of the verified caller, when verified. */
  readonly callerSubjectId?: string;
  /** Data subject the requested row belongs to. */
  readonly rowSubjectId?: string;
}

/**
 * A metadata sink the catalog contributes back to. The local adapter's sink is
 * a no-op writing to JSONL; the DataHub adapter's sink writes usage statistics
 * and access-decision lineage into the graph. Keeping emit() behind this
 * interface is what lets the local adapter stay external-service-free.
 */
export interface MetadataSink {
  emit(trace: AccessTrace): Promise<void>;
}

export interface CatalogPort {
  /**
   * The single gate. Every field read in the product goes through this call —
   * there is no bypass, no cache, no debug helper that reads a field without a
   * Decision. If a caller can obtain a field value without a trace, the
   * product's thesis is false.
   */
  decide(request: AccessRequest): Promise<AccessTrace>;

  /** Classification of a field, UNCLASSIFIED if absent. */
  classify(ref: FieldRef): Promise<Classification>;

  /** Lineage chain terminating at `ref`, deepest-first. */
  lineage(ref: FieldRef): Promise<readonly LineageHop[]>;

  /** Where traces are contributed back. */
  readonly sink: MetadataSink;
}
