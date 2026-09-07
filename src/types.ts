/** FixLine GRC shared types */

export type HoursPerWeek = 'lt5' | '5-10' | '10-20' | '20plus';
export type UsageContext = 'self' | 'advisor';
export type AvailabilityStatus = 'KNOWN' | 'UNKNOWN' | 'WITHHELD' | 'OMITTED';
export type FactProvenance = 'DIRECT_USER' | 'LEGACY_MAPPING' | 'SYSTEM_DEFAULT' | 'NORMALIZED';

export type CaseStatus =
  | 'QUEUED'
  | 'PROCESSING'
  | 'DRAFT_GENERATED'
  | 'REVISE'
  | 'RESEARCH_INCOMPLETE'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'APPROVED_FOR_DELIVERY'
  | 'REJECTED'
  | 'FAILED';

export interface Env {
  DB: D1Database;
  RESUME_BUCKET: R2Bucket;
  GENERATE_QUEUE: Queue<GenerateQueueMessage>;
  ASSETS?: Fetcher;
  PUBLIC_BASE_URL: string;
  MAX_REVISE_ATTEMPTS: string;
  XAI_MODEL_GENERATE: string;
  XAI_MODEL_QC: string;
  XAI_API_KEY: string;
  RATE_LIMIT_SALT: string;
  REVIEW_PASSWORD: string;
  PILOT_MODE: 'human';
}

export interface IntakeFields {
  college: string;
  current_goal: string;
  work_location: string;
  hours_per_week: HoursPerWeek | 'UNKNOWN' | 'WITHHELD';
  constraints: string;
  usage_context: UsageContext;
}

export interface V2IntakeFields {
  current_goal: string;
  country: string | null;
  locality: string | null;
  timezone: string | null;
  work_hours: string | null;
  study_hours: string | null;
  income_urgency: string | null;
  income_floor: string | null;
  mobility: string | null;
  transportation: string | null;
  work_authorization: string | null;
  education_status: string | null;
  constraints: string | null;
  usage_context: UsageContext;
  delivery_preferences: KnownOrUnavailable;
  language: string | null;
  accessibility: string | null;
  guided_summary: string | null;
  consent_version: string;
  consented_at: string;
  consent_acknowledged: true;
  resume_provided: boolean;
}

export interface V2Fact {
  name: string;
  value: string | null;
  availability: AvailabilityStatus;
  provenance: FactProvenance;
  sourceField: string | null;
}

export interface GenerateQueueMessage {
  caseId: string;
  attemptNumber: number;
  reason?: 'initial' | 'revise' | 'manual';
}

export interface EvidenceEntry {
  claim_id: string;
  claim: string;
  source_title: string;
  source_url: string;
  checked_at: string;
  supports_section: string;
  status: 'VERIFIED' | 'UNVERIFIED' | string;
  load_bearing: boolean;
}

export interface DraftReport {
  raw_markdown: string;
  student_name?: string;
  best_first_move?: string;
  sections?: Record<string, string>;
}

export interface QcFailure {
  check?: string;
  severity?: string;
  location?: string;
  quote?: string;
  required_fix?: string;
  systemic_possibility?: string;
}

export interface QcResult {
  verdict: 'PASS' | 'REVISE' | 'RESEARCH_INCOMPLETE' | string;
  failures: QcFailure[];
  raw: string;
}

export interface CaseRow {
  id: string;
  college: string;
  current_goal: string;
  work_location: string;
  hours_per_week: string;
  constraints: string | null;
  usage_context: string;
  status: string;
  access_token_hash: string;
  resume_r2_key: string | null;
  resume_filename: string | null;
  resume_content_type: string | null;
  rate_limit_fingerprint: string | null;
  pdf_r2_key: string | null;
  student_name: string | null;
  attempt_count: number;
  processed_at: string | null;
  resume_deleted_at: string | null;
  last_error: string | null;
  review_notes: string | null;
  created_at: string;
  updated_at: string;
}
