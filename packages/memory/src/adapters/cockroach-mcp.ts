// QUALIFYING TOOL #2 — CockroachDB Cloud Managed MCP Server.
//
// The rules require >=2 CockroachDB tools from their published list:
//   Managed MCP Server · Distributed Vector Indexing · ccloud CLI · Agent Skills.
// Tool #1 is the distributed vector index in cockroachdb.ts. This is tool #2,
// and it is deliberately NOT a checkbox: the MCP server is the reason this
// product needs to exist at that event.
//
// THE ARGUMENT. CockroachDB's managed MCP server hands an AI agent read-only
// SQL against a production cluster — `list_databases`, `get_table_schema`,
// `select_query`. That is exactly the capability our thesis is about. An agent
// with `select_query` can write `SELECT ssn FROM patient` and the database will
// answer it, because the database is doing its job. Nothing in the MCP layer
// knows that `claim.subscriber_key` inherits SENSITIVE_PII through four hops of
// column lineage.
//
// So this adapter puts the gate IN FRONT of the MCP server:
//
//   1. gatedSelect() adjudicates every column a query references BEFORE the
//      query is sent. One DENY and the SQL is never executed — the agent does
//      not receive rows it then has to be trusted to discard.
//   2. auditDrift() uses get_table_schema to find columns the cluster has and
//      the catalog has never classified. Those are UNCLASSIFIED, which the core
//      denies, so drift is surfaced as a governance report rather than
//      discovered by a leak.
//
// FAIL CLOSED, INCLUDING THE PARSER. Column extraction is deliberately
// conservative: `SELECT *`, subqueries, unparseable SQL and anything with a
// column it cannot resolve all DENY. A permissive SQL parser here would be a
// bypass of the entire product, so when in doubt this refuses.
//
// CREDENTIALS: CRDB_MCP_URL (default https://cockroachlabs.cloud/mcp)
//              CRDB_MCP_API_KEY (Cloud service-account key)
// See docs/adapters/COCKROACHDB.md.

import type {
  AccessRequest,
  AccessTrace,
  CatalogPort,
  Channel,
  FieldRef,
} from '@switchboard/catalog';

export class MissingMcpCredentialError extends Error {
  constructor() {
    super(
      'set CRDB_MCP_API_KEY (a CockroachDB Cloud service-account key) to run the ' +
        'MCP tool (see docs/adapters/COCKROACHDB.md)',
    );
    this.name = 'MissingMcpCredentialError';
  }
}

/** The MCP surface used here. JSON-RPC over HTTP; SSE is deprecated in MCP. */
export interface McpTransport {
  callTool<T>(name: string, args: Record<string, unknown>): Promise<T>;
}

/**
 * JSON-RPC 2.0 over HTTP against the managed endpoint. Zero dependencies —
 * `tools/call` is one POST, so an MCP client library would be a dependency
 * bought for nothing.
 */
export class HttpMcpTransport implements McpTransport {
  private id = 0;

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    /**
     * Required by the managed server — it routes by cluster, not by token.
     * Verified against the live endpoint: the Cloud Console's own MCP snippet
     * sets exactly this header.
     */
    private readonly clusterId: string | undefined = process.env['CRDB_CLUSTER_ID'],
  ) {}

  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The managed server negotiates streamable HTTP; it rejects a request
        // that will not accept an event-stream reply.
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${this.apiKey}`,
        ...(this.clusterId !== undefined ? { 'mcp-cluster-id': this.clusterId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++this.id,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    if (!res.ok) throw new Error(`CockroachDB MCP ${res.status} ${res.statusText}`);
    const body = (await res.json()) as {
      result?: { content?: { type: string; text?: string }[]; structuredContent?: T };
      error?: { message: string };
    };
    if (body.error) throw new Error(`CockroachDB MCP: ${body.error.message}`);
    if (body.result?.structuredContent !== undefined) return body.result.structuredContent;
    // MCP returns tool output as content parts; the SQL tools emit JSON text.
    const text = body.result?.content?.find((c) => c.type === 'text')?.text ?? '';
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
}

/** A column the cluster exposes that the catalog has never classified. */
export interface DriftFinding {
  readonly table: string;
  readonly column: string;
  /** Always UNCLASSIFIED — that is the point; the core denies it. */
  readonly classification: 'UNCLASSIFIED';
}

export interface DriftReport {
  readonly checked: number;
  readonly findings: readonly DriftFinding[];
  /** Tables get_table_schema could not be read for. Absence is not safety. */
  readonly unreadable: readonly string[];
}

export interface GatedSelectResult {
  readonly allowed: boolean;
  /** One trace per column the statement referenced. The audit artifact. */
  readonly traces: readonly AccessTrace[];
  /** Present only when every referenced column was ALLOWed. */
  readonly rows?: readonly Record<string, unknown>[];
  /** Why the statement was refused, in one sentence, when it was. */
  readonly refusal?: string;
}

export interface CockroachMcpOptions {
  readonly catalog: CatalogPort;
  readonly endpoint?: string;
  readonly apiKey?: string;
  /** Injected in tests. */
  readonly transport?: McpTransport;
  readonly database?: string;
}

/**
 * Column references in a SELECT, or null when the statement cannot be
 * conservatively understood.
 *
 * Null means DENY. This is not a SQL parser and must never be mistaken for one:
 * it recognises a narrow, auditable subset and refuses everything else, because
 * the failure mode of a clever parser is a silent bypass of the gate.
 */
export function referencedColumns(sql: string): FieldRef[] | null {
  const flat = sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
  if (/;/.test(flat)) return null; // no statement batching
  if (/\b(insert|update|delete|drop|truncate|alter|create|grant|copy)\b/i.test(flat)) return null;

  const m = /^select\s+(.+?)\s+from\s+([a-z_][a-z0-9_]*)\s*(where\s+.*)?$/i.exec(flat);
  if (!m) return null;

  const [, projection, table, where = ''] = m;
  if (projection === undefined || table === undefined) return null;
  if (projection.includes('*')) return null; // SELECT * cannot be adjudicated
  if (/\(|\bselect\b|\bjoin\b|\bunion\b/i.test(projection)) return null; // no functions/subqueries
  if (/\bselect\b/i.test(where)) return null; // no subquery in the predicate

  const names = new Set<string>();
  for (const raw of projection.split(',')) {
    // `patient.ssn AS x` → ssn ; `ssn` → ssn
    const col = raw.trim().split(/\s+as\s+/i)[0]?.trim();
    if (col === undefined || col === '') return null;
    const bare = col.includes('.') ? col.slice(col.lastIndexOf('.') + 1) : col;
    if (!/^[a-z_][a-z0-9_]*$/i.test(bare)) return null;
    names.add(bare);
  }

  // Columns in the predicate are read too: `WHERE ssn = '…'` tests a value the
  // caller is not allowed to learn, and answering it leaks by oracle.
  //
  // String literals are stripped FIRST. Without this, `WHERE patient_id =
  // 'p_1001'` scans the literal's contents and adjudicates a phantom column
  // `patient.p_1001` — which fails closed, so it denies, but it denies for the
  // wrong reason and puts a fictional field in the audit trail. An audit log
  // naming columns that do not exist is worse than a terse one.
  const predicate = where.replace(/'(?:[^']|'')*'/g, " '' ");
  for (const ident of predicate.matchAll(/[a-z_][a-z0-9_.]*/gi)) {
    const tok = ident[0];
    if (/^(where|and|or|not|like|in|is|null|between|order|by|limit|asc|desc|true|false)$/i.test(tok)) {
      continue;
    }
    const bare = tok.includes('.') ? tok.slice(tok.lastIndexOf('.') + 1) : tok;
    if (/^[a-z_][a-z0-9_]*$/i.test(bare)) names.add(bare);
  }

  return [...names].sort().map((field) => ({ table, field }));
}

/**
 * The gate in front of CockroachDB's MCP server.
 *
 * Note what is NOT reimplemented here: the decision. Every column goes through
 * CatalogPort.decide(), which is the same adjudicate() the console and the 294
 * tests run. This class decides only WHICH columns to ask about.
 */
export class CockroachMcp {
  private readonly transport: McpTransport;
  private readonly catalog: CatalogPort;
  private readonly database: string;
  private seq = 0;

  constructor(opts: CockroachMcpOptions) {
    const endpoint = opts.endpoint ?? process.env['CRDB_MCP_URL'] ?? 'https://cockroachlabs.cloud/mcp';
    const apiKey = opts.apiKey ?? process.env['CRDB_MCP_API_KEY'];
    if (!opts.transport && !apiKey) throw new MissingMcpCredentialError();
    this.transport = opts.transport ?? new HttpMcpTransport(endpoint, apiKey as string);
    this.catalog = opts.catalog;
    this.database = opts.database ?? 'switchboard';
  }

  /** MCP `list_databases`. */
  async listDatabases(): Promise<readonly string[]> {
    const out = await this.transport.callTool<{ databases?: string[] } | string[]>(
      'list_databases',
      {},
    );
    return Array.isArray(out) ? out : (out.databases ?? []);
  }

  /** MCP `get_table_schema` → column names. */
  async columnsOf(table: string): Promise<readonly string[]> {
    const out = await this.transport.callTool<
      { columns?: ({ name?: string; column_name?: string } | string)[] } | undefined
    >('get_table_schema', { database: this.database, table });
    const cols = out?.columns ?? [];
    return cols
      .map((c) => (typeof c === 'string' ? c : (c.name ?? c.column_name)))
      .filter((c): c is string => typeof c === 'string');
  }

  /**
   * CATALOG DRIFT. Columns the cluster exposes that the catalog has never
   * classified resolve to UNCLASSIFIED, which the core denies — so drift shows
   * up as a report rather than as a leak. This is the governance answer to
   * "someone added a column and forgot to classify it".
   */
  async auditDrift(tables: readonly string[]): Promise<DriftReport> {
    const findings: DriftFinding[] = [];
    const unreadable: string[] = [];
    let checked = 0;

    for (const table of tables) {
      let columns: readonly string[];
      try {
        columns = await this.columnsOf(table);
      } catch {
        unreadable.push(table); // an unreadable table is not a clean table
        continue;
      }
      for (const column of columns) {
        checked++;
        const tier = await this.catalog.classify({ table, field: column });
        if (tier === 'UNCLASSIFIED') {
          findings.push({ table, column, classification: 'UNCLASSIFIED' });
        }
      }
    }
    return { checked, findings, unreadable };
  }

  /**
   * MCP `select_query`, adjudicated first.
   *
   * The order is the whole point: every referenced column is decided BEFORE the
   * statement reaches the cluster. On any DENY the SQL is never sent, so there
   * is no moment where restricted rows exist in the agent's context and the
   * agent is trusted not to repeat them.
   */
  async gatedSelect(
    sql: string,
    ctx: {
      callId: string;
      utterance?: string;
      intent?: string;
      channel: Channel;
      subjectVerified: boolean;
      callerSubjectId?: string;
      rowSubjectId?: string;
    },
  ): Promise<GatedSelectResult> {
    const refs = referencedColumns(sql);
    if (refs === null) {
      return {
        allowed: false,
        traces: [],
        refusal:
          'Statement could not be adjudicated column-by-column (wildcard, join, ' +
          'subquery, function or non-SELECT). Refused rather than guessed.',
      };
    }

    const traces: AccessTrace[] = [];
    for (const requested of refs) {
      const request: AccessRequest = {
        callId: ctx.callId,
        utterance: ctx.utterance ?? sql,
        intent: ctx.intent ?? 'MCP_SELECT',
        requested,
        channel: ctx.channel,
        subjectVerified: ctx.subjectVerified,
        ...(ctx.callerSubjectId !== undefined ? { callerSubjectId: ctx.callerSubjectId } : {}),
        ...(ctx.rowSubjectId !== undefined ? { rowSubjectId: ctx.rowSubjectId } : {}),
      };
      traces.push(await this.catalog.decide(request));
    }

    const denied = traces.filter((t) => t.decision === 'DENY');
    if (denied.length > 0) {
      const first = denied[0];
      return {
        allowed: false,
        traces,
        refusal: first ? first.rationale : 'Denied.',
      };
    }

    this.seq++;
    const out = await this.transport.callTool<
      { rows?: Record<string, unknown>[] } | Record<string, unknown>[]
    >('select_query', { database: this.database, sql });
    const rows = Array.isArray(out) ? out : (out.rows ?? []);
    return { allowed: true, traces, rows };
  }

  get statementsExecuted(): number {
    return this.seq;
  }
}
