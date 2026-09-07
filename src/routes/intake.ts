import type { Env, HoursPerWeek, IntakeFields } from '../types';
import { getActiveConsentVersion, insertEvidenceReadyCase, recordMetric } from '../lib/db';
import { badRequest, json } from '../lib/http';
import { IntakeValidationError, PiiPersistenceError, parseV2Intake } from '../lib/intake-v2';
import { PilotModeError, requireHumanPilot } from '../lib/pilot';
import { checkAndRecordRateLimit } from '../lib/rate-limit';
import { putObject, tempResumeKey } from '../lib/r2';
import { mintAccessToken } from '../lib/tokens';
import { ExtractError, extractResumeText } from '../pipeline/extract';

const HOURS: HoursPerWeek[] = ['lt5', '5-10', '10-20', '20plus'];
const MAX_BYTES = 8 * 1024 * 1024;

export async function handleIntake(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return badRequest('Method not allowed', 405);
  try {
    requireHumanPilot(env);
  } catch (err) {
    return json({ message: err instanceof PilotModeError ? err.message : 'Human pilot is unavailable.' }, 503);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return badRequest('Expected multipart form data');
  }

  const college = String(form.get('college') || '').trim();
  const hours_per_week = String(form.get('hours_per_week') || '').trim() as HoursPerWeek;
  const resumeEntry = form.get('resume');
  const resumeProvided = resumeEntry != null && typeof resumeEntry !== 'string' && resumeEntry.size > 0;

  if (college !== 'Green River College') {
    return badRequest('This intake endpoint is only for the Green River College pilot.');
  }
  const activeConsentVersion = await getActiveConsentVersion(env);
  if (!activeConsentVersion) return json({ message: 'No active consent policy is configured.' }, 503);
  const v2FieldNames = ['country', 'locality', 'timezone', 'work_hours', 'study_hours', 'income_urgency',
    'income_floor', 'mobility', 'transportation', 'work_authorization', 'education_status',
    'delivery_preferences', 'language', 'accessibility', 'guided_summary'];
  const isExactLegacySubmission = resumeProvided && !v2FieldNames.some((name) => form.has(name));
  let parsed;
  try {
    parsed = parseV2Intake(form, {
      resumeProvided,
      now: new Date().toISOString(),
      consentVersion: activeConsentVersion,
      // Clicking the unchanged legacy form's "Create" button is its affirmative submit action.
      allowLegacySubmitConsent: isExactLegacySubmission,
    });
  } catch (err) {
    return badRequest(err instanceof IntakeValidationError || err instanceof PiiPersistenceError ? err.message : 'Invalid intake.');
  }
  const { intake: v2, facts } = parsed;

  const file = resumeProvided ? resumeEntry as unknown as {
    name: string;
    type: string;
    size: number;
    arrayBuffer(): Promise<ArrayBuffer>;
  } : null;
  if (file && file.size > MAX_BYTES) {
    return badRequest('Résumé file must be between 1 byte and 8 MB.');
  }

  const filename = file?.name || '';
  const contentType = file?.type || null;
  const bytes = file ? await file.arrayBuffer() : null;

  // Extract early for rate-limit fingerprint (never log body)
  let sourceText = v2.guided_summary || '';
  if (file && bytes) {
    try {
      sourceText = await extractResumeText(bytes, filename, contentType || 'application/octet-stream');
    } catch (err) {
      const message = err instanceof ExtractError ? err.message : 'Could not read that résumé format. Please upload PDF or TXT for the beta.';
      return json({ message }, 400);
    }
    if (sourceText.length < 40) {
      return json({ message: 'That résumé appears too short to analyze. Please upload a fuller PDF or TXT.' }, 400);
    }
  }

  const caseId = crypto.randomUUID();
  const rate = await checkAndRecordRateLimit(env, sourceText, college, caseId);
  if (!rate.ok) {
    return json({ message: rate.message }, 429);
  }

  const { token, hash } = await mintAccessToken();
  const storageName = file ? storageFilename(filename) : null;
  const r2Key = storageName ? tempResumeKey(caseId, storageName) : null;
  const resumeStoredAt = r2Key ? new Date().toISOString() : null;
  if (r2Key && bytes) await putObject(env, r2Key, bytes, contentType || 'application/octet-stream');

  const intake: IntakeFields = {
    college,
    current_goal: v2.current_goal,
    work_location: v2.locality,
    hours_per_week: HOURS.includes(hours_per_week)
      ? hours_per_week
      : HOURS.includes(v2.work_hours as HoursPerWeek)
        ? v2.work_hours as HoursPerWeek
        : (v2.work_hours === 'WITHHELD' ? 'WITHHELD' : 'UNKNOWN'),
    constraints: v2.constraints === 'UNKNOWN' || v2.constraints === 'WITHHELD' || v2.constraints === null ? '' : v2.constraints,
    usage_context: v2.usage_context,
  };

  try {
    await insertEvidenceReadyCase(env, {
      id: caseId, intake, v2, facts, accessTokenHash: hash, resumeR2Key: r2Key,
      resumeStorageName: storageName, resumeContentType: contentType,
      resumeByteSize: file?.size || 0, resumeStoredAt, rateLimitFingerprint: rate.fingerprint,
      initialStatus: resumeProvided ? 'QUEUED' : 'HUMAN_REVIEW_REQUIRED',
    });
  } catch (err) {
    if (r2Key) await env.RESUME_BUCKET.delete(r2Key).catch(() => undefined);
    throw err;
  }

  if (resumeProvided) {
    await env.GENERATE_QUEUE.send({ caseId, attemptNumber: 1, reason: 'initial' });
  }

  await recordMetric(env, 'intake_accepted', caseId, v2.usage_context, {
    hours_per_week: v2.work_hours,
  });

  const base = (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/$/, '');
  const redirect_url = `${base}/status/${caseId}?t=${token}`;
  return json({ redirect_url });
}

/** Keep only the extension needed by the extractor; original names can contain PII. */
function storageFilename(filename: string): string {
  const match = filename.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return `resume${match ? `.${match[1]}` : '.bin'}`;
}
