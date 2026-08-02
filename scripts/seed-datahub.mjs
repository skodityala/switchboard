#!/usr/bin/env node
/**
 * Seeds a DataHub instance with the Rosewood fixture graph, so the DataHub
 * adapter's live contract tests assert the SAME graph the local suite tests.
 *
 * The graph is read straight out of the SQLite fixture — the same pattern as
 * scripts/build-console.mjs — so the seeded instance cannot drift from what
 * the 142-test suite proves. This script is the "ingestion recipe" for the
 * fixture: zero dependencies, plain GMS OpenAPI v3 upserts over fetch.
 *
 * What it writes:
 *   - dataPlatform  clinic (the EHR-ish source) and switchboard (this product)
 *   - glossaryTerm  Public · Operational · PII · SensitivePII · PHI
 *   - dataset       the 7 rosewood tables, each field carrying its tier as a
 *                   glossary term, plus column-level (fine-grained) lineage
 *   - dataset       switchboard.access_log — the node the adapter's sink
 *                   points access-decision lineage at
 *
 * Usage:
 *   DATAHUB_SERVER=http://localhost:8080 DATAHUB_TOKEN=<pat> \
 *     node scripts/seed-datahub.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

const SERVER = process.env.DATAHUB_SERVER ?? 'http://localhost:8080';
const TOKEN = process.env.DATAHUB_TOKEN;
if (!TOKEN) {
  console.error('set DATAHUB_TOKEN (and optionally DATAHUB_SERVER) to seed. See docs/adapters/DATAHUB.md');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// ── the graph, straight from the fixture ─────────────────────────────────────
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(join(root, 'packages/catalog/schema.sql'), 'utf8'));
db.exec(readFileSync(join(root, 'packages/catalog/fixtures/rosewood.sql'), 'utf8'));

const datasets = db.prepare('SELECT name, description FROM dataset ORDER BY name').all();
const fields = db
  .prepare('SELECT dataset_name, name, classification, justification FROM field ORDER BY dataset_name, name')
  .all();
const edges = db
  .prepare('SELECT from_dataset, from_field, to_dataset, to_field, transform FROM lineage_edge')
  .all();

/** Must agree with TERM_TO_TIER in packages/catalog/src/adapters/datahub.ts. */
const TIER_TERM = {
  PUBLIC: 'Public',
  OPERATIONAL: 'Operational',
  PII: 'PII',
  SENSITIVE_PII: 'SensitivePII',
  PHI: 'PHI',
};

const TERM_DEFINITION = {
  Public: 'Disclosable to any caller on any channel.',
  Operational: 'Disclosable to a verified caller.',
  PII: 'Disclosable only to the verified data subject.',
  SensitivePII: 'Never disclosable over a conversational channel, at any verification level.',
  PHI: 'Protected health information. Never disclosable over a conversational channel.',
};

const AUDIT = { time: 0, actor: 'urn:li:corpuser:datahub' };
const platformUrn = (p) => `urn:li:dataPlatform:${p}`;
const datasetUrn = (table, platform = 'clinic') =>
  `urn:li:dataset:(${platformUrn(platform)},${table},PROD)`;
const schemaFieldUrn = (table, field, platform = 'clinic') =>
  `urn:li:schemaField:(${datasetUrn(table, platform)},${field})`;
const termUrn = (name) => `urn:li:glossaryTerm:${name}`;

// ── OpenAPI v3 upsert ────────────────────────────────────────────────────────
async function upsert(entityName, entities) {
  const res = await fetch(`${SERVER}/openapi/v3/entity/${entityName}?async=false`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(entities),
  });
  if (!res.ok) {
    throw new Error(`upsert ${entityName} failed: ${res.status} ${(await res.text()).slice(0, 500)}`);
  }
  console.log(`  ✓ ${entityName} × ${entities.length}`);
}

// ── entities ─────────────────────────────────────────────────────────────────
const platformEntities = [
  {
    urn: platformUrn('clinic'),
    dataPlatformInfo: {
      value: { name: 'clinic', displayName: 'Rosewood Clinic EHR', type: 'OTHERS', datasetNameDelimiter: '.' },
    },
  },
  {
    urn: platformUrn('switchboard'),
    dataPlatformInfo: {
      value: { name: 'switchboard', displayName: 'Switchboard', type: 'OTHERS', datasetNameDelimiter: '.' },
    },
  },
];

const termEntities = Object.values(TIER_TERM).map((name) => ({
  urn: termUrn(name),
  glossaryTermInfo: {
    value: { name, definition: TERM_DEFINITION[name], termSource: 'INTERNAL' },
  },
}));

const fieldsByDataset = new Map();
for (const f of fields) {
  const list = fieldsByDataset.get(f.dataset_name) ?? [];
  list.push(f);
  fieldsByDataset.set(f.dataset_name, list);
}

const edgesByDownstream = new Map();
for (const e of edges) {
  const list = edgesByDownstream.get(e.to_dataset) ?? [];
  list.push(e);
  edgesByDownstream.set(e.to_dataset, list);
}

const datasetEntities = datasets.map((d) => {
  const entity = {
    urn: datasetUrn(d.name),
    datasetProperties: { value: { name: d.name, description: d.description } },
    schemaMetadata: {
      value: {
        schemaName: d.name,
        platform: platformUrn('clinic'),
        version: 0,
        hash: '',
        platformSchema: { 'com.linkedin.schema.OtherSchema': { rawSchema: '' } },
        fields: (fieldsByDataset.get(d.name) ?? []).map((f) => ({
          fieldPath: f.name,
          type: { type: { 'com.linkedin.schema.StringType': {} } },
          nativeDataType: 'string',
          description: f.justification,
          glossaryTerms: {
            terms: [{ urn: termUrn(TIER_TERM[f.classification]) }],
            auditStamp: AUDIT,
          },
        })),
      },
    },
  };

  const upstreamEdges = edgesByDownstream.get(d.name) ?? [];
  if (upstreamEdges.length > 0) {
    const upstreamDatasets = [...new Set(upstreamEdges.map((e) => e.from_dataset))];
    entity.upstreamLineage = {
      value: {
        upstreams: upstreamDatasets.map((t) => ({
          auditStamp: AUDIT,
          dataset: datasetUrn(t),
          type: 'TRANSFORMED',
        })),
        fineGrainedLineages: upstreamEdges.map((e) => ({
          upstreamType: 'FIELD_SET',
          upstreams: [schemaFieldUrn(e.from_dataset, e.from_field)],
          downstreamType: 'FIELD',
          downstreams: [schemaFieldUrn(e.to_dataset, e.to_field)],
          transformOperation: e.transform,
          confidenceScore: 1.0,
        })),
      },
    };
  }
  return entity;
});

// The audit-log node the adapter's sink points access-decision lineage at.
datasetEntities.push({
  urn: datasetUrn('access_log', 'switchboard'),
  datasetProperties: {
    value: {
      name: 'access_log',
      description:
        'Switchboard append-only access-decision log. Every field access an AI ' +
        'agent attempts is adjudicated against this catalog and recorded here; ' +
        'upstream edges are contributed back by the adapter at decision time.',
    },
  },
  schemaMetadata: {
    value: {
      schemaName: 'access_log',
      platform: platformUrn('switchboard'),
      version: 0,
      hash: '',
      platformSchema: { 'com.linkedin.schema.OtherSchema': { rawSchema: '' } },
      fields: [
        'trace_id', 'call_id', 'requested_dataset', 'requested_field',
        'resolved_classification', 'effective_classification', 'decision',
        'rule', 'rationale', 'decided_at',
      ].map((name) => ({
        fieldPath: name,
        type: { type: { 'com.linkedin.schema.StringType': {} } },
        nativeDataType: 'string',
      })),
    },
  },
});

// ── go ───────────────────────────────────────────────────────────────────────
console.log(`Seeding ${SERVER} with the Rosewood graph:`);
await upsert('dataPlatform', platformEntities);
await upsert('glossaryTerm', termEntities);
await upsert('dataset', datasetEntities);
console.log(
  `Done: ${datasets.length + 1} datasets, ${fields.length} classified fields, ` +
  `${edges.length} column-level lineage edges.`,
);
