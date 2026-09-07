import type { CaseRow, CaseStatus, Env, IntakeFields, V2Fact, V2IntakeFields } from '../types';

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

/** Insert the legacy compatibility row and the additive v2 record set together. */
export async function insertEvidenceReadyCase(
  env: Env,
  args: {
    id: string;
    intake: IntakeFields;
    v2: V2IntakeFields;
    facts: V2Fact[];
    accessTokenHash: string;
    resumeR2Key: string | null;
    resumeStorageName: string | null;
    resumeContentType: string | null;
    resumeByteSize: number;
    resumeStoredAt: string | null;
    rateLimitFingerprint: string;
    initialStatus: 'QUEUED' | 'HUMAN_REVIEW_REQUIRED';
  },
): Promise<void> {
  const ts = nowIso();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO cases (
        id, college, current_goal, work_location, hours_per_week, constraints, usage_context,
        status, access_token_hash, resume_r2_key, resume_filename, resume_content_type,
        rate_limit_fingerprint, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).bind(
      args.id, args.intake.college, args.intake.current_goal, args.intake.work_location,
      args.intake.hours_per_week, args.intake.constraints || null, args.intake.usage_context,
      args.initialStatus, args.accessTokenHash, args.resumeR2Key, args.resumeStorageName, args.resumeContentType,
      args.rateLimitFingerprint, ts, ts,
    ),
    env.DB.prepare(
      `INSERT INTO v2_case (id, legacy_case_id, schema_version, state, processing_mode, created_at, updated_at)
       VALUES (?, ?, '2.0', ?, 'HUMAN_PROCESSING', ?, ?)`,
    ).bind(args.id, args.id, args.initialStatus, ts, ts),
    env.DB.prepare(
      `INSERT INTO v2_intake (
        case_id, current_goal, country, locality, timezone, work_hours, study_hours,
        income_urgency, income_floor, mobility, transportation, work_authorization,
        education_status, constraints, usage_context, delivery_preferences, language,
        accessibility, guided_summary, resume_provided, consent_policy_name, consent_version,
        consent_acknowledged, consented_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'intake_consent', ?, 1, ?, ?, ?)`,
    ).bind(
      args.id, args.v2.current_goal, args.v2.country, args.v2.locality, args.v2.timezone,
      args.v2.work_hours, args.v2.study_hours, args.v2.income_urgency, args.v2.income_floor,
      args.v2.mobility, args.v2.transportation, args.v2.work_authorization,
      args.v2.education_status, args.v2.constraints, args.v2.usage_context,
      args.v2.delivery_preferences, args.v2.language, args.v2.accessibility,
      args.v2.guided_summary, args.v2.resume_provided ? 1 : 0, args.v2.consent_version,
      args.v2.consented_at, ts, ts,
    ),
    env.DB.prepare(
      `INSERT INTO v2_case_event
       (case_id, event_type, from_state, to_state, actor, metadata_json, created_at)
       VALUES (?, 'INTAKE_ACCEPTED', NULL, ?, 'USER', '{}', ?)`,
    ).bind(args.id, args.initialStatus, ts),
  ];

  for (const item of args.facts) {
    statements.push(env.DB.prepare(
      `INSERT INTO v2_user_fact
       (case_id, fact_name, value_json, availability_status, provenance, source_field, collected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(args.id, item.name, item.value === null ? null : JSON.stringify(item.value), item.availability, item.provenance, item.sourceField, ts));
  }

  if (args.resumeR2Key) {
    const artifactId = crypto.randomUUID();
    const storedAt = args.resumeStoredAt || ts;
    // Five-minute purge margin keeps deletion within the absolute 24-hour storage maximum.
    const deleteBy = new Date(new Date(storedAt).getTime() + 23 * 60 * 60 * 1000).toISOString();
    statements.push(
      env.DB.prepare(
        `INSERT INTO artifact_metadata
         (id, case_id, object_key, artifact_type, content_type, byte_size, storage_class, stored_at, delete_by)
         VALUES (?, ?, ?, 'RAW_RESUME', ?, ?, 'ACTIVE_TEMPORARY', ?, ?)`,
      ).bind(artifactId, args.id, args.resumeR2Key, args.resumeContentType, args.resumeByteSize, storedAt, deleteBy),
      env.DB.prepare(
        `INSERT INTO v2_deletion_index (artifact_id, case_id, object_key, delete_by)
         VALUES (?, ?, ?, ?)`,
      ).bind(artifactId, args.id, args.resumeR2Key, deleteBy),
    );
  }
  await env.DB.batch(statements);
}

export async function getActiveConsentVersion(env: Env): Promise<string | null> {
  const ts = nowIso();
  const row = await env.DB.prepare(
    `SELECT version FROM policy_version
     WHERE policy_name = 'intake_consent' AND active = 1
       AND effective_at <= ? AND (retired_at IS NULL OR retired_at > ?)
     ORDER BY effective_at DESC LIMIT 1`,
  ).bind(ts, ts).first<{ version: string }>();
  return row?.version || null;
}

export async function getCase(env: Env, caseId: string): Promise<CaseRow | null> {
  return env.DB.prepare(`SELECT * FROM cases WHERE id = ?`).bind(caseId).first<CaseRow>();
}

export async function getV2Intake(env: Env, caseId: string): Promise<V2IntakeFields | null> {
  const row = await env.DB.prepare(`SELECT * FROM v2_intake WHERE case_id = ?`).bind(caseId).first<Record<string, unknown>>();
  if (!row) return null;
  return { ...row, resume_provided: row.resume_provided === 1 } as unknown as V2IntakeFields;
}

export async function getRawArtifactDeadline(env: Env, caseId: string, objectKey: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT d.delete_by FROM v2_deletion_index d
     JOIN artifact_metadata a ON a.id = d.artifact_id
     WHERE d.case_id = ? AND d.object_key = ? AND a.artifact_type = 'RAW_RESUME'
     LIMIT 1`,
  ).bind(caseId, objectKey).first<{ delete_by: string }>();
  return row?.delete_by || null;
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
  const ts = values[1] as string;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO v2_case_event (case_id, event_type, from_state, to_state, actor, metadata_json, created_at)
       SELECT id, 'STATE_CHANGED', state, ?, 'SYSTEM', '{}', ? FROM v2_case WHERE legacy_case_id = ?`,
    ).bind(status, ts, caseId),
    env.DB.prepare(`UPDATE cases SET ${sets.join(', ')} WHERE id = ?`).bind(...values),
    env.DB.prepare(`UPDATE v2_case SET state = ?, updated_at = ? WHERE legacy_case_id = ?`).bind(status, ts, caseId),
  ]);
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
     SELECT ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM deletion_records WHERE case_id = ? AND object_key = ? AND object_type = ?
     )`,
  )
    .bind(caseId, objectKey, objectType, nowIso(), method, caseId, objectKey, objectType)
    .run();
}
