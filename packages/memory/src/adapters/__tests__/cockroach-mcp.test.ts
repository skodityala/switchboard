/**
 * CockroachDB Managed MCP Server — contract tests.
 *
 * The load-bearing assertion is ORDER: the gate runs BEFORE select_query is
 * sent. A gate that filters rows after the fact leaves restricted data in the
 * agent's context and trusts it not to repeat them, which is the failure this
 * product exists to make structurally impossible.
 *
 * Runs with no credential via an injected transport. The live path needs
 * CRDB_MCP_API_KEY and fails with one actionable line.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { SqliteCatalog } from '@switchboard/catalog';
import {
  CockroachMcp,
  MissingMcpCredentialError,
  referencedColumns,
  type McpTransport,
} from '../cockroach-mcp.js';

const here = dirname(fileURLToPath(import.meta.url));
const catalogPkg = join(here, '..', '..', '..', '..', 'catalog');

function makeCatalog(): SqliteCatalog {
  return new SqliteCatalog({
    schemaPath: join(catalogPkg, 'schema.sql'),
    fixturePath: join(catalogPkg, 'fixtures', 'rosewood.sql'),
    dataPath: join(catalogPkg, 'fixtures', 'rosewood-data.sql'),
  });
}

/** Records every MCP tool call so we can assert what was and was NOT sent. */
function fakeTransport(): { transport: McpTransport; calls: { name: string; args: Record<string, unknown> }[] } {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const transport: McpTransport = {
    async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
      calls.push({ name, args });
      if (name === 'list_databases') return { databases: ['switchboard'] } as T;
      if (name === 'get_table_schema') {
        const table = String(args['table']);
        const cols: Record<string, string[]> = {
          // `nickname` is deliberately NOT in the fixture — this is the drift.
          patient: ['patient_id', 'first_name', 'ssn', 'nickname'],
          clinic_info: ['hours', 'address', 'phone'],
        };
        return { columns: (cols[table] ?? []).map((name) => ({ name })) } as T;
      }
      return { rows: [{ hours: '8am to 6pm' }] } as T;
    },
  };
  return { transport, calls };
}

let catalog: SqliteCatalog;
let fake: ReturnType<typeof fakeTransport>;
let mcp: CockroachMcp;

beforeEach(() => {
  catalog = makeCatalog();
  fake = fakeTransport();
  mcp = new CockroachMcp({ catalog, transport: fake.transport });
});

describe('the gate runs BEFORE the MCP server sees the statement', () => {
  it('a restricted column means select_query is never sent', async () => {
    const r = await mcp.gatedSelect("SELECT ssn FROM patient WHERE patient_id = 'p_1001'", {
      callId: 'c1', channel: 'PHONE', subjectVerified: true,
      callerSubjectId: 'p_1001', rowSubjectId: 'p_1001',
    });
    expect(r.allowed).toBe(false);
    expect(fake.calls.some((c) => c.name === 'select_query'), 'SQL reached the cluster').toBe(false);
    expect(mcp.statementsExecuted).toBe(0);
    expect(r.refusal).toMatch(/SENSITIVE_PII|never disclosable/i);
  });

  it('lineage still propagates through MCP — the under-classified column is caught', async () => {
    const r = await mcp.gatedSelect('SELECT subscriber_key FROM claim', {
      callId: 'c2', channel: 'PHONE', subjectVerified: true,
    });
    expect(r.allowed).toBe(false);
    const t = r.traces.find((x) => x.requested.field === 'subscriber_key');
    expect(t?.resolvedClassification).toBe('OPERATIONAL');
    expect(t?.effectiveClassification).toBe('SENSITIVE_PII');
    expect(t?.lineage.length).toBeGreaterThanOrEqual(3);
  });

  it('an allowed column does reach the cluster, and returns rows', async () => {
    const r = await mcp.gatedSelect('SELECT hours FROM clinic_info', {
      callId: 'c3', channel: 'PHONE', subjectVerified: false,
    });
    expect(r.allowed).toBe(true);
    expect(fake.calls.some((c) => c.name === 'select_query')).toBe(true);
    expect(r.rows?.length).toBeGreaterThan(0);
  });

  it('every referenced column produces a trace — the audit artifact', async () => {
    const r = await mcp.gatedSelect('SELECT hours, address FROM clinic_info', {
      callId: 'c4', channel: 'PHONE', subjectVerified: false,
    });
    expect(r.traces.map((t) => t.requested.field).sort()).toEqual(['address', 'hours']);
  });

  it('a WHERE-clause column is adjudicated too — no oracle leak', async () => {
    // Never reads ssn in the projection, but tests it in the predicate.
    const r = await mcp.gatedSelect(
      "SELECT patient_id FROM patient WHERE ssn = '539-88-4021'",
      { callId: 'c5', channel: 'PHONE', subjectVerified: true,
        callerSubjectId: 'p_1001', rowSubjectId: 'p_1001' },
    );
    expect(r.allowed, 'answering this confirms an SSN by oracle').toBe(false);
    expect(fake.calls.some((c) => c.name === 'select_query')).toBe(false);
  });
});

describe('the SQL subset fails closed', () => {
  const unparseable = [
    'SELECT * FROM patient',
    'SELECT ssn FROM patient; DROP TABLE patient',
    'SELECT (SELECT ssn FROM patient) AS x FROM claim',
    'SELECT max(ssn) FROM patient',
    'SELECT p.ssn FROM patient p JOIN claim c ON c.id = p.id',
    'UPDATE patient SET ssn = 1',
    'WITH x AS (SELECT ssn FROM patient) SELECT * FROM x',
  ];

  it('refuses every statement it cannot adjudicate column-by-column', () => {
    for (const sql of unparseable) {
      expect(referencedColumns(sql), `parsed something it should refuse: ${sql}`).toBeNull();
    }
  });

  it('an unadjudicable statement never reaches the cluster', async () => {
    for (const sql of unparseable) {
      const r = await mcp.gatedSelect(sql, {
        callId: 'c6', channel: 'PHONE', subjectVerified: true,
      });
      expect(r.allowed, `allowed: ${sql}`).toBe(false);
    }
    expect(fake.calls.some((c) => c.name === 'select_query')).toBe(false);
  });

  it('resolves a qualified projection to its bare column', () => {
    expect(referencedColumns('SELECT patient.ssn FROM patient')).toEqual([
      { table: 'patient', field: 'ssn' },
    ]);
  });
});

describe('catalog drift, found through get_table_schema', () => {
  it('reports a cluster column the catalog has never classified', async () => {
    const report = await mcp.auditDrift(['patient', 'clinic_info']);
    expect(report.checked).toBe(7);
    expect(report.findings.map((f) => f.column)).toContain('nickname');
    // And everything the fixture DOES classify is absent from the report.
    expect(report.findings.map((f) => f.column)).not.toContain('ssn');
  });

  it('a drifted column is denied, not defaulted', async () => {
    const r = await mcp.gatedSelect('SELECT nickname FROM patient', {
      callId: 'c7', channel: 'PHONE', subjectVerified: true,
      callerSubjectId: 'p_1001', rowSubjectId: 'p_1001',
    });
    expect(r.allowed).toBe(false);
    expect(r.traces[0]?.rule).toBe('RULE_UNCLASSIFIED_DENY');
  });

  it('an unreadable table is recorded, because absence is not safety', async () => {
    const failing: McpTransport = {
      async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
        if (name === 'get_table_schema') throw new Error('MCP 503');
        return fake.transport.callTool<T>(name, args);
      },
    };
    const m = new CockroachMcp({ catalog, transport: failing });
    const report = await m.auditDrift(['patient']);
    expect(report.unreadable).toEqual(['patient']);
    expect(report.findings).toHaveLength(0);
  });
});

describe('MCP plumbing', () => {
  it('list_databases round-trips', async () => {
    expect(await mcp.listDatabases()).toContain('switchboard');
  });

  it('missing credentials raise one actionable error', () => {
    const k = process.env['CRDB_MCP_API_KEY'];
    delete process.env['CRDB_MCP_API_KEY'];
    try {
      expect(() => new CockroachMcp({ catalog })).toThrow(MissingMcpCredentialError);
      expect(() => new CockroachMcp({ catalog })).toThrow(/CRDB_MCP_API_KEY/);
    } finally {
      if (k !== undefined) process.env['CRDB_MCP_API_KEY'] = k;
    }
  });
});

describe('live CockroachDB MCP (opt-in)', () => {
  const live = process.env['CRDB_MCP_LIVE'] === '1';

  it.runIf(live)('gates a real select_query against the managed MCP server', async () => {
    const key = process.env['CRDB_MCP_API_KEY'];
    expect(key, 'CRDB_MCP_LIVE=1 requires CRDB_MCP_API_KEY. See docs/adapters/COCKROACHDB.md').toBeTruthy();
    const m = new CockroachMcp({ catalog });
    const dbs = await m.listDatabases();
    expect(dbs.length).toBeGreaterThan(0);
    const denied = await m.gatedSelect('SELECT ssn FROM patient', {
      callId: 'live', channel: 'PHONE', subjectVerified: true,
    });
    expect(denied.allowed).toBe(false);
    expect(m.statementsExecuted).toBe(0);
  }, 120_000);

  // ALWAYS runs — a skipped test hides missing work.
  it('reports live-verification status in the test output', () => {
    console.log(
      `\n  cockroachdb MCP tool: ${live ? 'LIVE PATH ENABLED' : 'NOT YET VERIFIED against the managed server'}\n` +
        (live ? '' :
          '  contract tests prove the gate runs BEFORE select_query is sent.\n' +
          '  To verify:  CRDB_MCP_LIVE=1 CRDB_MCP_API_KEY=<service-account key> \\\n' +
          '                npx vitest run packages/memory\n'),
    );
    expect(referencedColumns('SELECT * FROM patient')).toBeNull();
  });
});
