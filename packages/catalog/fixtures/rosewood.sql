-- Seed fixture: Rosewood Family Practice — a 3-provider independent clinic that
-- cannot absorb a $50k HIPAA settlement. This is the named audience with the
-- named cost, and the worked example in every video cut.
--
-- Lineage is deliberately ≥3 hops deep so the on-screen chain is more than a
-- single lookup: patient.ssn → billing_account.ssn_last4 → claim.subscriber_key
-- → claim_export.subscriber_key. A judge sees restriction propagate through a
-- column somebody classified loosely at the far end.

INSERT INTO dataset (urn, name, description) VALUES
  ('urn:li:dataset:(clinic,patient,PROD)',         'patient',        'Patient demographics and identifiers'),
  ('urn:li:dataset:(clinic,appointment,PROD)',     'appointment',    'Scheduled visits'),
  ('urn:li:dataset:(clinic,prescription,PROD)',    'prescription',   'Active and past medications'),
  ('urn:li:dataset:(clinic,billing_account,PROD)', 'billing_account','Patient billing and balances'),
  ('urn:li:dataset:(clinic,claim,PROD)',           'claim',          'Insurance claims'),
  ('urn:li:dataset:(clinic,claim_export,PROD)',    'claim_export',   'Flat file handed to the clearinghouse'),
  ('urn:li:dataset:(clinic,clinic_info,PROD)',     'clinic_info',    'Public clinic details');

INSERT INTO field (dataset_name, name, classification, justification) VALUES
  ('clinic_info','hours',              'PUBLIC',       'Posted on the front door and the website'),
  ('clinic_info','address',            'PUBLIC',       'Public listing'),
  ('clinic_info','phone',              'PUBLIC',       'Public listing'),

  ('patient','patient_id',             'OPERATIONAL',  'Internal surrogate key, not disclosable but not identifying alone'),
  ('patient','first_name',             'PII',          'Identifies the data subject'),
  ('patient','last_name',              'PII',          'Identifies the data subject'),
  ('patient','date_of_birth',          'PII',          'Identifier used for verification; never read back to a caller'),
  ('patient','phone',                  'PII',          'Contact identifier'),
  ('patient','ssn',                    'SENSITIVE_PII','Full SSN. Never disclosable by phone under any verification'),
  ('patient','insurance_member_id',    'SENSITIVE_PII','Enables benefits fraud if disclosed'),
  ('patient','home_address',           'SENSITIVE_PII','Physical safety risk for patients with protective orders'),

  ('appointment','appt_id',            'OPERATIONAL',  'Scheduling key'),
  ('appointment','starts_at',          'OPERATIONAL',  'Disclosable to the verified data subject'),
  ('appointment','provider_name',      'OPERATIONAL',  'Disclosable to the verified data subject'),
  ('appointment','visit_reason',       'PHI',          'Clinical reason for the visit'),

  ('prescription','rx_id',             'OPERATIONAL',  'Refill key'),
  ('prescription','refill_status',     'OPERATIONAL',  'Disclosable to the verified data subject'),
  ('prescription','drug_name',         'PHI',          'Reveals diagnosis by inference'),
  ('prescription','prescriber_note',   'PHI',          'Clinical note'),

  ('billing_account','account_id',     'OPERATIONAL',  'Billing key'),
  ('billing_account','balance_cents',  'OPERATIONAL',  'Disclosable to the verified data subject'),
  ('billing_account','ssn_last4',      'SENSITIVE_PII','Derived from patient.ssn; still identifying'),

  ('claim','claim_id',                 'OPERATIONAL',  'Claim key'),
  ('claim','diagnosis_code',           'PHI',          'ICD-10 code is diagnosis in the clear'),
  -- Deliberately UNDER-classified by the operator. Lineage propagation is what
  -- catches this; a leaf-only lookup would leak it. This row is the point.
  ('claim','subscriber_key',           'OPERATIONAL',  'Operator believed this was an opaque key'),

  ('claim_export','row_id',            'OPERATIONAL',  'Export row key'),
  ('claim_export','subscriber_key',    'OPERATIONAL',  'Copied verbatim into the clearinghouse file');

INSERT INTO lineage_edge (from_dataset, from_field, to_dataset, to_field, transform) VALUES
  ('patient','ssn',                  'billing_account','ssn_last4',      'derive'),
  ('billing_account','ssn_last4',    'claim','subscriber_key',           'derive'),
  ('claim','subscriber_key',         'claim_export','subscriber_key',    'copy'),
  ('patient','date_of_birth',        'claim','subscriber_key',           'derive'),
  ('prescription','drug_name',       'claim','diagnosis_code',           'derive'),
  ('appointment','visit_reason',     'claim','diagnosis_code',           'derive'),
  ('patient','patient_id',           'appointment','appt_id',            'join'),
  ('patient','patient_id',           'billing_account','account_id',     'join');
