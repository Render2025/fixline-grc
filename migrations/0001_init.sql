-- FixLine GRC pilot schema
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  college TEXT NOT NULL,
  current_goal TEXT NOT NULL,
  work_location TEXT NOT NULL,
  hours_per_week TEXT NOT NULL,
  constraints TEXT,
  usage_context TEXT NOT NULL CHECK (usage_context IN ('self', 'advisor')),
  status TEXT NOT NULL,
  access_token_hash TEXT NOT NULL,
  resume_r2_key TEXT,
  resume_filename TEXT,
  resume_content_type TEXT,
  rate_limit_fingerprint TEXT,
  pdf_r2_key TEXT,
  student_name TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  resume_deleted_at TEXT,
  last_error TEXT,
  review_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_processed_at ON cases(processed_at);
CREATE INDEX IF NOT EXISTS idx_cases_rate_fp ON cases(rate_limit_fingerprint);

-- Append-only generation / QC attempts
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  result TEXT,
  severity TEXT,
  failure_reason TEXT,
  systemic_yes_no TEXT,
  fix_made TEXT,
  final_status TEXT,
  qc_verdict TEXT,
  qc_failures_json TEXT,
  evidence_log_json TEXT,
  draft_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_case_num ON attempts(case_id, attempt_number);

CREATE TABLE IF NOT EXISTS rate_limits (
  fingerprint TEXT PRIMARY KEY,
  college TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  case_id TEXT
);

CREATE TABLE IF NOT EXISTS deletion_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  object_type TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  method TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deletion_case ON deletion_records(case_id);

CREATE TABLE IF NOT EXISTS pilot_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  case_id TEXT,
  usage_context TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metrics_event ON pilot_metrics(event, created_at);
