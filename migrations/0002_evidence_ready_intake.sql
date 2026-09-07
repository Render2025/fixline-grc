-- Additive evidence-ready intake schema. The legacy tables remain authoritative for legacy routes.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS v2_policy_version (
  id TEXT PRIMARY KEY, policy_name TEXT NOT NULL, version TEXT NOT NULL,
  effective_at TEXT NOT NULL, retired_at TEXT, is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0,1)),
  UNIQUE(policy_name, version)
);
INSERT OR IGNORE INTO v2_policy_version(id,policy_name,version,effective_at,is_active)
VALUES ('intake-consent-1','intake_consent','1','2026-09-07T00:00:00.000Z',1);

CREATE TABLE IF NOT EXISTS v2_case (
  id TEXT PRIMARY KEY REFERENCES cases(id), intake_mode TEXT NOT NULL CHECK(intake_mode IN ('LEGACY_RESUME','V2_RESUME','V2_NO_RESUME')),
  policy_version_id TEXT REFERENCES v2_policy_version(id), acknowledged_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS v2_intake (
  case_id TEXT PRIMARY KEY REFERENCES v2_case(id), country TEXT, locality TEXT, timezone TEXT, goal TEXT,
  work_hours TEXT, study_hours TEXT, income_urgency TEXT, income_floor TEXT, mobility TEXT, transportation TEXT,
  work_authorization TEXT, education_status TEXT, constraints TEXT, usage_context TEXT,
  delivery_preferences TEXT, language TEXT, accessibility TEXT, guided_summary TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS v2_user_fact (
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL REFERENCES v2_case(id), field_name TEXT NOT NULL,
  value_json TEXT, answer_state TEXT NOT NULL CHECK(answer_state IN ('KNOWN','UNKNOWN','WITHHELD','OMITTED')),
  provenance TEXT NOT NULL CHECK(provenance IN ('DIRECT_USER','LEGACY_MAPPING','SYSTEM_DEFAULT','NORMALIZED')),
  source_fact_id INTEGER REFERENCES v2_user_fact(id), created_at TEXT NOT NULL, UNIQUE(case_id,field_name,provenance)
);
CREATE TABLE IF NOT EXISTS v2_resume_fact (
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL REFERENCES v2_case(id), fact_type TEXT NOT NULL,
  value_json TEXT NOT NULL, source_locator TEXT, provenance TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS v2_case_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL, event_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v2_event_case ON v2_case_event(case_id,created_at);
CREATE TABLE IF NOT EXISTS v2_artifact (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL, artifact_type TEXT NOT NULL, object_key TEXT,
  content_type TEXT, byte_length INTEGER, sha256 TEXT, stored_at TEXT, delete_by TEXT,
  deleted_at TEXT, created_at TEXT NOT NULL, UNIQUE(object_key)
);
CREATE INDEX IF NOT EXISTS idx_v2_artifact_expiry ON v2_artifact(delete_by) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS v2_deletion_index (
  artifact_id TEXT PRIMARY KEY REFERENCES v2_artifact(id), status TEXT NOT NULL CHECK(status IN ('PENDING','FAILED','DELETED')),
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS v2_deletion_record (
  artifact_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, object_key TEXT NOT NULL, deleted_at TEXT NOT NULL, method TEXT NOT NULL
);

-- Cover active raw objects created before this migration. Their deadline is conservatively due immediately.
INSERT OR IGNORE INTO v2_artifact(id,case_id,artifact_type,object_key,content_type,created_at,delete_by)
SELECT 'legacy-'||id,id,'RAW_RESUME',resume_r2_key,resume_content_type,created_at,created_at
FROM cases WHERE resume_r2_key IS NOT NULL AND resume_deleted_at IS NULL;
INSERT OR IGNORE INTO v2_deletion_index(artifact_id,status,updated_at)
SELECT id,'PENDING',created_at FROM v2_artifact WHERE artifact_type='RAW_RESUME' AND deleted_at IS NULL;
