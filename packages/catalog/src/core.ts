/**
 * THE ADJUDICATION CORE — the single implementation of the gate.
 *
 * Pure: no I/O, no node builtins, no browser APIs, no dependencies. That is what
 * lets the SQLite adapter, the in-memory adapter, the test suite AND the browser
 * console all execute this same code rather than four copies of its rules.
 *
 * Storage is abstracted to CatalogGraph. A store supplies classification and
 * lineage; every decision — propagation, rule order, rationale wording, trace
 * construction — happens here and only here.
 */
import type {
  AccessRequest,
  AccessTrace,
  Classification,
  Decision,
  FieldRef,
  LineageHop,
  RuleId,
} from './port.js';

/**
 * Restriction order. Index is the comparison key: a higher index is strictly
 * more restrictive, which is what lets lineage propagation be a max().
 */
export const RESTRICTION_ORDER = [
  'PUBLIC',
  'OPERATIONAL',
  'PII',
  'SENSITIVE_PII',
  'PHI',
] as const;

export type DeclaredTier = (typeof RESTRICTION_ORDER)[number];

export const rank = (t: DeclaredTier): number => RESTRICTION_ORDER.indexOf(t);

/** Tiers no channel may ever disclose, at any verification level. */
export const NEVER_DISCLOSABLE: ReadonlySet<Classification> = new Set<Classification>([
  'SENSITIVE_PII',
  'PHI',
]);

export const keyOf = (ref: FieldRef): string => `${ref.table}.${ref.field}`;

/**
 * What a store must provide. Synchronous by design: node:sqlite is synchronous
 * and an in-memory snapshot is trivially so, and keeping the core synchronous
 * means the browser runs it without an async shim.
 */
export interface CatalogGraph {
  /** Declared tier, or UNCLASSIFIED when the field is absent from the catalog. */
  classifySync(ref: FieldRef): Classification;
  /** Upstream lineage terminating at `ref`, nearest-first. */
  lineageSync(ref: FieldRef): readonly LineageHop[];
}

/**
 * Effective tier: the most restrictive tier anywhere upstream, including the
 * field itself. This is the rule a keyword blocklist cannot express — a derived
 * column classified loosely by the operator still inherits its source's tier.
 */
export function effectiveOf(
  graph: CatalogGraph,
  ref: FieldRef,
  declared: Classification,
): Classification {
  if (declared === 'UNCLASSIFIED') return 'UNCLASSIFIED';
  return graph.lineageSync(ref).reduce<Classification>((worst, hop) => {
    const t = hop.inheritedClassification;
    if (t === 'UNCLASSIFIED' || worst === 'UNCLASSIFIED') return worst;
    return rank(t as DeclaredTier) > rank(worst as DeclaredTier) ? t : worst;
  }, declared);
}

/**
 * Rule evaluation, ordered most-restrictive-first. Exactly one rule fires and it
 * is named in the trace, so the panel can show *why* rather than only what.
 */
export function evaluate(
  request: AccessRequest,
  declared: Classification,
  effective: Classification,
): { decision: Decision; rule: RuleId; rationale: string } {
  const key = keyOf(request.requested);

  // 1. Fail closed. Never seen this field ⇒ deny.
  if (effective === 'UNCLASSIFIED') {
    return {
      decision: 'DENY',
      rule: 'RULE_UNCLASSIFIED_DENY',
      rationale: `${key} is not in the catalog. Unclassified fields are denied by default.`,
    };
  }

  // 2. Never disclosable on ANY channel, at any verification level. The rule id
  // retains its original name for trace-log compatibility, but the rationale
  // names the actual channel so a Slack denial does not read "by phone".
  if (NEVER_DISCLOSABLE.has(effective)) {
    const inherited = effective !== declared;
    const where = request.channel === 'PHONE' ? 'by phone' : `over ${request.channel.toLowerCase()}`;
    return {
      decision: 'DENY',
      rule: 'RULE_NEVER_BY_PHONE',
      rationale: inherited
        ? `${key} is classified ${declared}, but inherits ${effective} through lineage. Never disclosable ${where}.`
        : `${key} is ${effective}. Never disclosable ${where} under any verification.`,
    };
  }

  // 3. PII requires a verified data subject, and the subject must be the caller.
  if (effective === 'PII') {
    if (!request.subjectVerified) {
      return {
        decision: 'DENY',
        rule: 'RULE_SUBJECT_UNVERIFIED',
        rationale: `${request.requested.field} is PII and the caller is not yet verified.`,
      };
    }
    if (
      request.callerSubjectId === undefined ||
      request.rowSubjectId === undefined ||
      request.callerSubjectId !== request.rowSubjectId
    ) {
      return {
        decision: 'DENY',
        rule: 'RULE_SUBJECT_MISMATCH',
        rationale: `Verified caller is not the data subject for this record.`,
      };
    }
    return {
      decision: 'ALLOW',
      rule: 'RULE_SUBJECT_SELF_ALLOW',
      rationale: `Verified data subject reading their own PII.`,
    };
  }

  // 4. Operational data requires verification, but not subject identity.
  if (effective === 'OPERATIONAL') {
    if (!request.subjectVerified) {
      return {
        decision: 'DENY',
        rule: 'RULE_SUBJECT_UNVERIFIED',
        rationale: `${request.requested.field} requires caller verification.`,
      };
    }
    return {
      decision: 'ALLOW',
      rule: 'RULE_OPERATIONAL_ALLOW',
      rationale: `Operational field released to a verified caller.`,
    };
  }

  // 5. Public.
  return {
    decision: 'ALLOW',
    rule: 'RULE_PUBLIC_ALLOW',
    rationale: `Public information.`,
  };
}

/** Monotonic microsecond clock, present in Node and in every browser. */
const nowMicros = (): number => globalThis.performance.now() * 1000;

/**
 * THE GATE. Resolve, propagate, evaluate, and build the trace. Allow and deny
 * share one shape, because a denial is a decision and not an error.
 */
export function adjudicate(
  graph: CatalogGraph,
  request: AccessRequest,
  meta: { traceId: string; decidedAt: string },
): AccessTrace {
  const t0 = nowMicros();

  const declared = graph.classifySync(request.requested);
  const effective = effectiveOf(graph, request.requested, declared);
  const lineage: readonly LineageHop[] =
    declared === 'UNCLASSIFIED' ? [] : graph.lineageSync(request.requested);

  const { decision, rule, rationale } = evaluate(request, declared, effective);

  return {
    traceId: meta.traceId,
    callId: request.callId,
    utterance: request.utterance,
    intent: request.intent,
    requested: request.requested,
    resolvedClassification: declared,
    effectiveClassification: effective,
    decision,
    rule,
    rationale,
    lineage,
    channel: request.channel,
    subjectVerified: request.subjectVerified,
    decidedAt: meta.decidedAt,
    durationMicros: Math.max(1, Math.round(nowMicros() - t0)),
  };
}

/**
 * Serialisable catalog contents. Produced from the SQLite catalog by
 * `scripts/build-console.mjs`, so the browser's data cannot drift from the
 * fixture the suite tests — and a parity test asserts exactly that.
 */
export interface CatalogSnapshot {
  readonly fields: Readonly<
    Record<string, { readonly classification: DeclaredTier; readonly justification: string }>
  >;
  readonly edges: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    readonly transform: string;
  }>;
  /** `table.field` → subjectId (or `*`) → value. */
  readonly values: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** Splits `table.field`. Field names never contain a dot. */
export function refOf(key: string): FieldRef {
  const i = key.indexOf('.');
  return { table: key.slice(0, i), field: key.slice(i + 1) };
}

/**
 * CatalogGraph over a snapshot. Breadth-first upstream walk, nearest-first,
 * deduplicated by edge — the same traversal order the SQL recursive CTE
 * produces, which the parity test verifies field by field.
 */
export class SnapshotGraph implements CatalogGraph {
  constructor(private readonly snap: CatalogSnapshot) {}

  classifySync(ref: FieldRef): Classification {
    return this.snap.fields[keyOf(ref)]?.classification ?? 'UNCLASSIFIED';
  }

  lineageSync(ref: FieldRef): readonly LineageHop[] {
    const out: LineageHop[] = [];
    const seen = new Set<string>();
    let frontier = [keyOf(ref)];

    // Breadth-first, and within each depth sorted by source key. This is the
    // canonical hop order — it must match the SQL adapter's
    // `ORDER BY depth, from_dataset, from_field` exactly, or the panel would
    // render a different chain than the audit log recorded. core-parity.test.ts
    // asserts the orders agree field by field.
    while (frontier.length > 0) {
      const atDepth: LineageHop[] = [];
      const next: string[] = [];
      for (const node of frontier) {
        for (const e of this.snap.edges) {
          if (e.to !== node) continue;
          const id = `${e.from}>${e.to}`;
          if (seen.has(id)) continue;
          seen.add(id);
          atDepth.push({
            from: refOf(e.from),
            to: refOf(e.to),
            transform: e.transform,
            inheritedClassification: this.classifySync(refOf(e.from)),
          });
          next.push(e.from);
        }
      }
      // Plain codepoint comparison, NOT localeCompare: the latter is
      // locale-dependent, so Node and a browser under a different default
      // locale could order hops differently and silently break the parity this
      // ordering exists to guarantee. It also loads an ICU collator on first
      // call, which dominated the first decision's latency.
      atDepth.sort((a, b) => (keyOf(a.from) < keyOf(b.from) ? -1 : keyOf(a.from) > keyOf(b.from) ? 1 : 0));
      out.push(...atDepth);
      frontier = next.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    return out;
  }
}
