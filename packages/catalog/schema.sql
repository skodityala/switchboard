-- Switchboard catalog — LOCAL adapter schema (SQLite).
-- Mirrors the subset of a DataHub metadata graph the runtime gate needs, so the
-- DataHub qualifying adapter can satisfy CatalogPort without touching callers.
--
-- Fail-closed is enforced structurally: a field absent from `field` resolves to
-- UNCLASSIFIED, and UNCLASSIFIED is denied. There is no default-allow row.

PRAGMA foreign_keys = ON;

CREATE TABLE dataset (
  urn         TEXT PRIMARY KEY,            -- datahub-compatible URN
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE field (
  id             INTEGER PRIMARY KEY,
  dataset_name   TEXT NOT NULL REFERENCES dataset(name) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN
                   ('PUBLIC','OPERATIONAL','PII','SENSITIVE_PII','PHI')),
  -- Why this tier, in the operator's words. Surfaces in the trace rationale.
  justification  TEXT NOT NULL DEFAULT '',
  UNIQUE (dataset_name, name)
);

-- Directed lineage: `from` flows into `to`. Restriction propagates along edges,
-- so a loosely-classified derived column still inherits its source's tier.
CREATE TABLE lineage_edge (
  id           INTEGER PRIMARY KEY,
  from_dataset TEXT NOT NULL,
  from_field   TEXT NOT NULL,
  to_dataset   TEXT NOT NULL,
  to_field     TEXT NOT NULL,
  transform    TEXT NOT NULL CHECK (transform IN
                 ('copy','derive','aggregate','join','mask')),
  FOREIGN KEY (from_dataset, from_field) REFERENCES field(dataset_name, name) ON DELETE CASCADE,
  FOREIGN KEY (to_dataset,   to_field)   REFERENCES field(dataset_name, name) ON DELETE CASCADE,
  UNIQUE (from_dataset, from_field, to_dataset, to_field)
);

CREATE INDEX idx_lineage_to   ON lineage_edge (to_dataset, to_field);
CREATE INDEX idx_lineage_from ON lineage_edge (from_dataset, from_field);

-- Append-only decision log. This table IS the observability artifact cited for
-- CockroachDB criterion 4 ("secure, observable, and scalable") and the payload
-- the DataHub adapter contributes back to the graph as usage metadata.
CREATE TABLE access_trace (
  trace_id                 TEXT PRIMARY KEY,
  call_id                  TEXT NOT NULL,
  utterance                TEXT NOT NULL,
  intent                   TEXT NOT NULL,
  requested_dataset        TEXT NOT NULL,
  requested_field          TEXT NOT NULL,
  resolved_classification  TEXT NOT NULL,
  effective_classification TEXT NOT NULL,
  decision                 TEXT NOT NULL CHECK (decision IN ('ALLOW','DENY')),
  rule                     TEXT NOT NULL,
  rationale                TEXT NOT NULL,
  lineage_json             TEXT NOT NULL DEFAULT '[]',
  -- Must stay in step with the Channel union in src/port.ts. The constraint is
  -- deliberately explicit rather than a free-text column: an unrecognised
  -- channel is a bug, and a bug here means a decision was recorded against a
  -- surface the gate does not actually reason about.
  channel                  TEXT NOT NULL CHECK (channel IN (
                             'PHONE','CHAT','EMAIL','SLACK','DISCORD','TELEGRAM',
                             'SMS','WHATSAPP','X','IMESSAGE','GITHUB','UNKNOWN_CHANNEL')),
  subject_verified         INTEGER NOT NULL CHECK (subject_verified IN (0,1)),
  decided_at               TEXT NOT NULL,
  duration_micros          INTEGER NOT NULL
);

CREATE INDEX idx_trace_call     ON access_trace (call_id, decided_at);
CREATE INDEX idx_trace_decision ON access_trace (decision, decided_at);
