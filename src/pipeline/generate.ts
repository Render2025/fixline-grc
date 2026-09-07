import type { Env, GenerateQueueMessage } from '../types';
import {
  getCase,
  getLatestAttempt,
  insertAttempt,
  nowIso,
  recordMetric,
  updateCaseStatus,
} from '../lib/db';
import { getObjectBytes } from '../lib/r2';
import { assertHumanMode, assertSafeText, enqueueIdentifierOnly } from '../lib/safety';
import { ExtractError, extractResumeText } from './extract';
import { applyWorkerGates } from './gates';
import { parseDraft, parseEvidenceLog, parseQcResult } from './parse';
import {
  buildGeneratorUserMessage,
  buildQcUserMessage,
  callGenerator,
  callQcAuditor,
} from './xai';

/**
 * Queue consumer: extract → Call A (generate+web_search) → gates → Call B (QC) → state.
 * PASS → HUMAN_REVIEW_REQUIRED (never auto APPROVED).
 */
export async function handleGenerateMessage(env: Env, msg: GenerateQueueMessage): Promise<void> {
  assertHumanMode(env);
  const caseRow = await getCase(env, msg.caseId);
  if (!caseRow) return;
  const expiry = await env.DB.prepare(`SELECT delete_by FROM v2_artifact WHERE case_id=? AND artifact_type='RAW_RESUME' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`).bind(msg.caseId).first<{delete_by:string|null}>();
  if (!expiry?.delete_by || !Number.isFinite(Date.parse(expiry.delete_by)) || Date.parse(expiry.delete_by) <= Date.now()) {
    await updateCaseStatus(env, caseRow.id, 'FAILED', {last_error:'Raw résumé retention deadline missing, malformed, due, or overdue',processed_at:nowIso()});
    return;
  }

  const maxAttempts = Number(env.MAX_REVISE_ATTEMPTS || '3') || 3;
  const attemptNumber = msg.attemptNumber || caseRow.attempt_count + 1;

  if (attemptNumber > maxAttempts) {
    await updateCaseStatus(env, caseRow.id, 'FAILED', {
      last_error: `Exceeded MAX_REVISE_ATTEMPTS (${maxAttempts})`,
      processed_at: nowIso(),
    });
    return;
  }

  await updateCaseStatus(env, caseRow.id, 'PROCESSING', {
    attempt_count: attemptNumber,
    last_error: null,
  });

  if (!caseRow.resume_r2_key) {
    await updateCaseStatus(env, caseRow.id, 'FAILED', {
      last_error: 'Missing temp résumé object',
      processed_at: nowIso(),
    });
    return;
  }

  const bytes = await getObjectBytes(env, caseRow.resume_r2_key);
  if (!bytes) {
    await updateCaseStatus(env, caseRow.id, 'FAILED', {
      last_error: 'Temp résumé not found in R2',
      processed_at: nowIso(),
    });
    return;
  }

  let resumeText: string;
  try {
    resumeText = await extractResumeText(
      bytes,
      caseRow.resume_filename || 'resume.pdf',
      caseRow.resume_content_type || 'application/octet-stream',
    );
  } catch (err) {
    const message = err instanceof ExtractError ? err.message : 'Résumé extraction failed';
    await updateCaseStatus(env, caseRow.id, 'FAILED', {
      last_error: message,
      processed_at: nowIso(),
    });
    await recordMetric(env, 'extract_failed', caseRow.id, caseRow.usage_context, {});
    return;
  }

  const intake = {
    college: caseRow.college,
    current_goal: caseRow.current_goal,
    work_location: caseRow.work_location,
    hours_per_week: caseRow.hours_per_week,
    constraints: caseRow.constraints,
    usage_context: caseRow.usage_context,
  };

  const prior = await getLatestAttempt(env, caseRow.id);
  const priorFeedback =
    msg.reason === 'revise'
      ? [prior?.failure_reason, prior?.qc_verdict, prior?.qc_failures_json].filter(Boolean).join('\n')
      : null;

  // Call A
  let generatorRaw: string;
  try {
    const gen = await callGenerator(
      env,
      buildGeneratorUserMessage({ intake, resumeText, priorFeedback }),
    );
    generatorRaw = gen.text;
  } catch (err) {
    await updateCaseStatus(env, caseRow.id, 'FAILED', {
      last_error: err instanceof Error ? err.message : 'Generator call failed',
      processed_at: nowIso(),
    });
    return;
  }

  const draft = parseDraft(generatorRaw);
  assertSafeText(generatorRaw, resumeText);
  const evidence = parseEvidenceLog(generatorRaw);
  const gate = applyWorkerGates(evidence, draft.raw_markdown);

  if (!gate.ok) {
    await insertAttempt(env, {
      case_id: caseRow.id,
      attempt_number: attemptNumber,
      result: gate.status,
      severity: 'material',
      failure_reason: gate.reason,
      evidence_log_json: JSON.stringify(evidence),
      draft_json: JSON.stringify(draft),
      final_status: gate.status,
    });

    if (gate.status === 'RESEARCH_INCOMPLETE') {
      await updateCaseStatus(env, caseRow.id, 'RESEARCH_INCOMPLETE', {
        processed_at: nowIso(),
        student_name: draft.student_name || null,
      });
      await recordMetric(env, 'research_incomplete', caseRow.id, caseRow.usage_context, {
        attempt: attemptNumber,
      });
      return;
    }

    // REVISE from worker gate
    if (attemptNumber < maxAttempts) {
      await updateCaseStatus(env, caseRow.id, 'REVISE', {
        student_name: draft.student_name || null,
      });
      await enqueueIdentifierOnly(env, {
        caseId: caseRow.id,
        attemptNumber: attemptNumber + 1,
        reason: 'revise',
      });
    } else {
      await updateCaseStatus(env, caseRow.id, 'REVISE', {
        processed_at: nowIso(),
        last_error: 'Max revise attempts reached after worker gate',
        student_name: draft.student_name || null,
      });
    }
    return;
  }

  await updateCaseStatus(env, caseRow.id, 'DRAFT_GENERATED', {
    student_name: draft.student_name || null,
  });

  // Call B — separate request, no web_search
  let qcRaw: string;
  try {
    const qc = await callQcAuditor(
      env,
      buildQcUserMessage({
        resumeText,
        intake,
        draft: draft.raw_markdown,
        evidenceLog: evidence,
      }),
    );
    qcRaw = qc.text;
  } catch (err) {
    await insertAttempt(env, {
      case_id: caseRow.id,
      attempt_number: attemptNumber,
      result: 'FAILED',
      failure_reason: err instanceof Error ? err.message : 'QC call failed',
      evidence_log_json: JSON.stringify(evidence),
      draft_json: JSON.stringify(draft),
      final_status: 'FAILED',
    });
    await updateCaseStatus(env, caseRow.id, 'FAILED', {
      last_error: err instanceof Error ? err.message : 'QC call failed',
      processed_at: nowIso(),
    });
    return;
  }

  const qc = parseQcResult(qcRaw);
  assertSafeText(qcRaw, resumeText);
  const systemic =
    qc.failures.find((f) => f.systemic_possibility)?.systemic_possibility || null;
  const severity = qc.failures.find((f) => f.severity)?.severity || null;

  if (qc.verdict === 'PASS') {
    await insertAttempt(env, {
      case_id: caseRow.id,
      attempt_number: attemptNumber,
      result: 'PASS',
      severity,
      systemic_yes_no: systemic,
      qc_verdict: 'PASS',
      qc_failures_json: JSON.stringify(qc.failures),
      evidence_log_json: JSON.stringify(evidence),
      draft_json: JSON.stringify(draft),
      final_status: 'HUMAN_REVIEW_REQUIRED',
    });
    await updateCaseStatus(env, caseRow.id, 'HUMAN_REVIEW_REQUIRED', {
      processed_at: nowIso(),
      student_name: draft.student_name || null,
    });
    await recordMetric(env, 'human_review_required', caseRow.id, caseRow.usage_context, {
      attempt: attemptNumber,
    });
    return;
  }

  if (qc.verdict === 'RESEARCH_INCOMPLETE') {
    await insertAttempt(env, {
      case_id: caseRow.id,
      attempt_number: attemptNumber,
      result: 'RESEARCH_INCOMPLETE',
      severity,
      failure_reason: 'QC verdict RESEARCH_INCOMPLETE',
      systemic_yes_no: systemic,
      qc_verdict: 'RESEARCH_INCOMPLETE',
      qc_failures_json: JSON.stringify(qc.failures),
      evidence_log_json: JSON.stringify(evidence),
      draft_json: JSON.stringify(draft),
      final_status: 'RESEARCH_INCOMPLETE',
    });
    await updateCaseStatus(env, caseRow.id, 'RESEARCH_INCOMPLETE', {
      processed_at: nowIso(),
      student_name: draft.student_name || null,
    });
    return;
  }

  // REVISE (default)
  const failureReason =
    qc.failures.map((f) => f.required_fix || f.check).filter(Boolean).join('; ') ||
    'QC verdict REVISE';

  await insertAttempt(env, {
    case_id: caseRow.id,
    attempt_number: attemptNumber,
    result: 'REVISE',
    severity,
    failure_reason: failureReason,
    systemic_yes_no: systemic,
    qc_verdict: 'REVISE',
    qc_failures_json: JSON.stringify(qc.failures),
    evidence_log_json: JSON.stringify(evidence),
    draft_json: JSON.stringify(draft),
    final_status: 'REVISE',
  });

  if (attemptNumber < maxAttempts) {
    await updateCaseStatus(env, caseRow.id, 'REVISE', {
      student_name: draft.student_name || null,
    });
    await enqueueIdentifierOnly(env, {
      caseId: caseRow.id,
      attemptNumber: attemptNumber + 1,
      reason: 'revise',
    });
  } else {
    await updateCaseStatus(env, caseRow.id, 'REVISE', {
      processed_at: nowIso(),
      last_error: 'Max revise attempts reached after QC',
      student_name: draft.student_name || null,
    });
  }
}
