import type { CaseRow, CaseStatus, Env, IntakeFields } from '../types';
import { assertSafeText } from './safety';

export function nowIso(): string {
  return new Date().toISOString();
}

export async function insertCase(
  env: Env,
  args: {
    id: string;
    intake: IntakeFields;
    accessTokenHash: string;
    resumeR2Key: string;
    resumeFilename: string;
    resumeContentType: string;
    rateLimitFingerprint: string;
  },
): Promise<void> {
  const ts = nowIso();
  await env.DB.prepare(
    `INSERT INTO cases (
      id, college, current_goal, work_location, hours_per_week, constraints, usage_context,
      status, access_token_hash, resume_r2_key, resume_filename, resume_content_type,
      rate_limit_fingerprint, attempt_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(
      args.id,
      args.intake.college,
      args.intake.current_goal,
      args.intake.work_location,
      args.intake.hours_per_week,
      args.intake.constraints || null,
      args.intake.usage_context,
      'QUEUED',
      args.accessTokenHash,
      args.resumeR2Key,
      args.resumeFilename,
      args.resumeContentType,
      args.rateLimitFingerprint,
      ts,
      ts,
    )
    .run();
}

export async function getCase(env: Env, caseId: string): Promise<CaseRow | null> {
  return env.DB.prepare(`SELECT * FROM cases WHERE id = ?`).bind(caseId).first<CaseRow>();
}

export async function updateCaseStatus(
  env: Env,
  caseId: string,
  status: CaseStatus,
  extra: Partial<{
    attempt_count: number;
    processed_at: string;
    resume_deleted_at: string;
    last_error: string | null;
    review_notes: string | null;
    pdf_r2_key: string | null;
    student_name: string | null;
    resume_r2_key: string | null;
  }> = {},
): Promise<void> {
  const sets = ['status = ?', 'updated_at = ?'];
  const values: unknown[] = [status, nowIso()];
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(caseId);
  await env.DB.prepare(`UPDATE cases SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
}

export async function insertAttempt(
  env: Env,
  row: {
    case_id: string;
    attempt_number: number;
    result?: string | null;
    severity?: string | null;
    failure_reason?: string | null;
    systemic_yes_no?: string | null;
    fix_made?: string | null;
    final_status?: string | null;
    qc_verdict?: string | null;
    qc_failures_json?: string | null;
    evidence_log_json?: string | null;
    draft_json?: string | null;
  },
): Promise<void> {
  [row.failure_reason,row.fix_made,row.qc_failures_json,row.draft_json].forEach((v)=>assertSafeText(v));
  await env.DB.prepare(
    `INSERT INTO attempts (
      case_id, attempt_number, result, severity, failure_reason, systemic_yes_no, fix_made,
      final_status, qc_verdict, qc_failures_json, evidence_log_json, draft_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.case_id,
      row.attempt_number,
      row.result ?? null,
      row.severity ?? null,
      row.failure_reason ?? null,
      row.systemic_yes_no ?? null,
      row.fix_made ?? null,
      row.final_status ?? null,
      row.qc_verdict ?? null,
      row.qc_failures_json ?? null,
      row.evidence_log_json ?? null,
      row.draft_json ?? null,
      nowIso(),
    )
    .run();
}

export async function getLatestAttempt(env: Env, caseId: string) {
  return env.DB.prepare(
    `SELECT * FROM attempts WHERE case_id = ? ORDER BY attempt_number DESC LIMIT 1`,
  )
    .bind(caseId)
    .first<{
      id: number;
      case_id: string;
      attempt_number: number;
      result: string | null;
      severity: string | null;
      failure_reason: string | null;
      systemic_yes_no: string | null;
      fix_made: string | null;
      final_status: string | null;
      qc_verdict: string | null;
      qc_failures_json: string | null;
      evidence_log_json: string | null;
      draft_json: string | null;
      created_at: string;
    }>();
}

export async function listCasesForReview(env: Env, limit = 50): Promise<CaseRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM cases WHERE status IN ('HUMAN_REVIEW_REQUIRED', 'REVISE', 'RESEARCH_INCOMPLETE', 'APPROVED_FOR_DELIVERY', 'REJECTED', 'PROCESSING', 'QUEUED')
     ORDER BY updated_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<CaseRow>();
  return res.results ?? [];
}

export async function recordMetric(
  env: Env,
  event: string,
  caseId: string | null,
  usageContext: string | null,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pilot_metrics (event, case_id, usage_context, meta_json, created_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(event, caseId, usageContext, JSON.stringify(meta), nowIso())
    .run();
}

export async function insertDeletionRecord(
  env: Env,
  caseId: string,
  objectKey: string,
  objectType: string,
  method: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO deletion_records (case_id, object_key, object_type, deleted_at, method)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(caseId, objectKey, objectType, nowIso(), method)
    .run();
}
