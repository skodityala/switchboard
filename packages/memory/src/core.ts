/**
 * THE MEMORY CORE — the single implementation of embedding, similarity and
 * gated recall.
 *
 * Pure: no I/O, no builtins, no dependencies. Storage sits behind MemoryStore, so
 * the SQLite adapter, the browser console and a future CockroachDB adapter all
 * execute this same code rather than three copies of its rules — the same
 * discipline as the catalog core.
 */
import type { AccessTrace, CatalogPort } from '@switchboard/catalog';
import type {
  MemoryEntry,
  MemoryKind,
  MemoryWrite,
  RecallHit,
  RecallQuery,
  RecallResult,
  WithheldMemory,
} from './port.js';

/** Vector width. Fixed so stored vectors stay comparable across adapters. */
export const EMBED_DIM = 128;

const STOP = new Set([
  'the','a','an','is','it','my','me','i','you','your','and','or','of','to','for',
  'on','in','at','be','was','do','does','did','can','could','would','please',
  'what','whats','when','where','who','how','that','this','with','have','has',
]);

/** FNV-1a. Deterministic across Node and every browser — no locale, no Math.random. */
function hash(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Hashed lexical embedding, L2-normalised.
 *
 * Deliberately NOT a learned model: a model would mean a dependency, a download,
 * and inference cost, which would falsify both the offline and the $0/call
 * claims. Sub-token shingles give it robustness to morphology ("appointment" /
 * "appointments") without any of that. Honest framing in the README: this is
 * lexical retrieval with vector mechanics, not semantic embedding.
 */
export function embed(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  const tokens = tokenize(text);

  for (const t of tokens) {
    v[hash(t) % EMBED_DIM]! += 1;
    // 4-char shingles: partial credit for related word forms.
    for (let i = 0; i + 4 <= t.length; i++) {
      v[hash(t.slice(i, i + 4)) % EMBED_DIM]! += 0.5;
    }
  }

  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}

/** Both inputs are L2-normalised, so this is the dot product. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * Storage behind an interface. `scanSubject` is the ONLY read primitive, and it
 * takes a subjectId that cannot be omitted — cross-caller recall is not a
 * permission to be granted but an operation this interface cannot express.
 */
export interface MemoryStore {
  insert(entry: MemoryEntry): void;
  scanSubject(subjectId: string, kinds?: readonly MemoryKind[]): readonly MemoryEntry[];
  callTurns(callId: string, subjectId: string): readonly MemoryEntry[];
  nextId(): string;
}

const nowMicros = (): number => globalThis.performance.now() * 1000;

export function buildEntry(
  store: MemoryStore,
  write: MemoryWrite,
  at: string,
): MemoryEntry {
  return {
    entryId: store.nextId(),
    callId: write.callId,
    subjectId: write.subjectId,
    kind: write.kind,
    text: write.text,
    ...(write.field !== undefined ? { field: write.field } : {}),
    ...(write.classification !== undefined ? { classification: write.classification } : {}),
    createdAt: at,
    vector: embed(write.text),
  };
}

/**
 * GATED RECALL — the core of the port.
 *
 * Two independent guards, and both must hold:
 *
 *   1. SCOPE. Candidates come only from scanSubject(query.subjectId). A memory
 *      belonging to another caller is never a candidate, so no scoring accident
 *      or off-by-one can surface it.
 *   2. RE-ADJUDICATION. A memory that names a catalog field is passed through
 *      CatalogPort.decide() at READ time. A memory written while a field was
 *      permissive is withheld once that field is reclassified — memory does not
 *      become a side channel around the catalog, and stale permission is not
 *      inherited from write time.
 *
 * Withheld results carry no text, only the field and the trace: a refusal must
 * not leak the content it is refusing.
 */
export async function recallCore(
  store: MemoryStore,
  catalog: CatalogPort,
  query: RecallQuery,
): Promise<RecallResult> {
  const t0 = nowMicros();
  const qv = embed(query.text);
  const limit = query.limit ?? 5;

  // Guard 1: scope. Nothing outside this subject is ever a candidate.
  const candidates = store.scanSubject(query.subjectId, query.kinds);

  const scored = candidates
    .map((entry) => ({ entry, score: cosine(qv, entry.vector) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.entry.entryId < b.entry.entryId ? -1 : 1));

  const hits: RecallHit[] = [];
  const withheld: WithheldMemory[] = [];
  const traces: AccessTrace[] = [];

  for (const c of scored) {
    if (hits.length >= limit) break;

    // Guard 2: re-adjudicate anything that names a field.
    if (c.entry.field !== undefined) {
      const trace = await catalog.decide({
        callId: query.callId,
        utterance: query.text,
        intent: 'MEMORY_RECALL',
        requested: c.entry.field,
        channel: query.channel,
        subjectVerified: query.subjectVerified,
        callerSubjectId: query.subjectId,
        rowSubjectId: c.entry.subjectId,
      });
      traces.push(trace);

      if (trace.decision === 'DENY') {
        withheld.push({
          entryId: c.entry.entryId,
          kind: c.entry.kind,
          field: c.entry.field,
          score: c.score,
          trace,
        });
        continue;
      }
      hits.push({ entry: c.entry, score: c.score, trace });
      continue;
    }

    hits.push({ entry: c.entry, score: c.score });
  }

  return {
    hits,
    withheld,
    traces,
    scanned: candidates.length,
    durationMicros: Math.max(1, Math.round(nowMicros() - t0)),
  };
}

/**
 * An access decision, as a memory. Stores the RATIONALE rather than any value,
 * so the audit history is recallable without becoming a copy of the data it
 * was protecting.
 */
export function decisionWrite(trace: AccessTrace, subjectId: string): MemoryWrite {
  return {
    callId: trace.callId,
    subjectId,
    kind: 'DECISION',
    text: `${trace.decision} ${trace.requested.table}.${trace.requested.field} — ${trace.rule}: ${trace.rationale}`,
    field: trace.requested,
    classification: trace.effectiveClassification,
  };
}
