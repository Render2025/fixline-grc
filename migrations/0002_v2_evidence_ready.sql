-- FixLine v2 Step 1: additive evidence-ready intake model.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS v2_case (
  id TEXT PRIMARY KEY,
  legacy_case_id TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL DEFAULT '2.0',
  state TEXT NOT NULL,
  processing_mode TEXT NOT NULL DEFAULT 'HUMAN_PROCESSING'
    CHECK (processing_mode = 'HUMAN_PROCESSING'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (legacy_case_id) REFERENCES cases(id)
);

CREATE TABLE IF NOT EXISTS policy_version (
  policy_name TEXT NOT NULL,
  version TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  retired_at TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (policy_name, version)
);

CREATE TABLE IF NOT EXISTS v2_intake (
  case_id TEXT PRIMARY KEY,
  current_goal TEXT NOT NULL,
  country TEXT,
  locality TEXT,
  timezone TEXT,
  work_hours TEXT,
  study_hours TEXT,
  income_urgency TEXT,
  income_floor TEXT,
  mobility TEXT,
  transportation TEXT,
  work_authorization TEXT,
  education_status TEXT,
  constraints TEXT,
  usage_context TEXT NOT NULL,
  delivery_preferences TEXT NOT NULL,
  language TEXT,
  accessibility TEXT,
  guided_summary TEXT,
  resume_provided INTEGER NOT NULL CHECK (resume_provided IN (0, 1)),
  consent_policy_name TEXT NOT NULL DEFAULT 'intake_consent',
  consent_version TEXT NOT NULL,
  consent_acknowledged INTEGER NOT NULL CHECK (consent_acknowledged = 1),
  consented_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (case_id) REFERENCES v2_case(id),
  FOREIGN KEY (consent_policy_name, consent_version)
    REFERENCES policy_version(policy_name, version)
);

CREATE TABLE IF NOT EXISTS v2_user_fact (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  fact_name TEXT NOT NULL,
  value_json TEXT,
  availability_status TEXT NOT NULL
    CHECK (availability_status IN ('KNOWN', 'UNKNOWN', 'WITHHELD', 'OMITTED')),
  provenance TEXT NOT NULL
    CHECK (provenance IN ('DIRECT_USER', 'LEGACY_MAPPING', 'SYSTEM_DEFAULT', 'NORMALIZED')),
  source_field TEXT,
  collected_at TEXT NOT NULL,
  UNIQUE(case_id, fact_name),
  FOREIGN KEY (case_id) REFERENCES v2_case(id)
);

CREATE TABLE IF NOT EXISTS v2_resume_fact (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  source_artifact_id TEXT NOT NULL,
  fact_name TEXT NOT NULL,
  value_json TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance = 'ARTIFACT_DERIVED'),
  source_locator_json TEXT NOT NULL,
  extraction_version TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  UNIQUE(case_id, source_artifact_id, fact_name),
  FOREIGN KEY (case_id) REFERENCES v2_case(id),
  FOREIGN KEY (source_artifact_id) REFERENCES artifact_metadata(id)
);

CREATE TABLE IF NOT EXISTS v2_case_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  actor TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (case_id) REFERENCES v2_case(id)
);
CREATE INDEX IF NOT EXISTS idx_v2_case_event_case ON v2_case_event(case_id, created_at);

CREATE TABLE IF NOT EXISTS artifact_metadata (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  artifact_type TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER,
  storage_class TEXT NOT NULL,
  stored_at TEXT NOT NULL,
  delete_by TEXT,
  deleted_at TEXT,
  FOREIGN KEY (case_id) REFERENCES v2_case(id)
);
CREATE INDEX IF NOT EXISTS idx_artifact_delete_by ON artifact_metadata(delete_by, deleted_at);

CREATE TABLE IF NOT EXISTS v2_deletion_index (
  artifact_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  delete_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'DELETED', 'FAILED')),
  last_attempt_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY (artifact_id) REFERENCES artifact_metadata(id),
  FOREIGN KEY (case_id) REFERENCES v2_case(id)
);
CREATE INDEX IF NOT EXISTS idx_v2_deletion_due ON v2_deletion_index(status, delete_by);

CREATE TABLE IF NOT EXISTS v2_deletion_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id TEXT NOT NULL UNIQUE,
  case_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  deletion_reason TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES artifact_metadata(id),
  FOREIGN KEY (case_id) REFERENCES v2_case(id)
);

INSERT OR IGNORE INTO policy_version
  (policy_name, version, effective_at, active, metadata_json)
VALUES
  ('intake_consent', 'fixline-v2-step1', '2026-09-07T00:00:00.000Z', 1,
   '{"processing_mode":"HUMAN_PROCESSING"}'),
  ('active_resume_retention', '24h-absolute-v1', '2026-09-07T00:00:00.000Z', 1,
   '{"maximum_hours":24,"operational_delete_by_hours":23}');

-- Make pre-migration cases and active raw artifacts visible to v2 retention.
INSERT OR IGNORE INTO v2_case
  (id, legacy_case_id, schema_version, state, processing_mode, created_at, updated_at)
SELECT id, id, '2.0', status, 'HUMAN_PROCESSING', created_at, updated_at FROM cases;

INSERT OR IGNORE INTO artifact_metadata
  (id, case_id, object_key, artifact_type, content_type, byte_size, storage_class,
   stored_at, delete_by, deleted_at)
SELECT 'legacy-resume-' || id, id, resume_r2_key, 'RAW_RESUME',
       COALESCE(resume_content_type, 'application/octet-stream'), NULL,
       'ACTIVE_TEMPORARY', created_at,
       strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+23 hours'), resume_deleted_at
FROM cases WHERE resume_r2_key IS NOT NULL;

INSERT OR IGNORE INTO v2_deletion_index
  (artifact_id, case_id, object_key, delete_by, status, deleted_at)
SELECT id, case_id, object_key, delete_by,
       CASE WHEN deleted_at IS NULL THEN 'PENDING' ELSE 'DELETED' END, deleted_at
FROM artifact_metadata
WHERE artifact_type = 'RAW_RESUME' AND delete_by IS NOT NULL;
