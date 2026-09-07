import type { Env } from '../types';
import { insertDeletionRecord, nowIso } from './db';

export function tempResumeKey(caseId: string, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'resume.bin';
  return `temp/${caseId}/${safe}`;
}

export function pdfKey(caseId: string): string {
  return `pdf/${caseId}/opportunity-report.pdf`;
}

/** Delete temp résumé. Write deletion_records only after successful R2 delete. */
export async function deleteTempResume(
  env: Env,
  caseId: string,
  key: string | null | undefined,
  method: 'approve' | 'reject' | 'cron' | 'pipeline' | 'expiry',
): Promise<boolean> {
  if (!key) return false;
  try {
    await env.RESUME_BUCKET.delete(key);
  } catch {
    return false;
  }
  await insertDeletionRecord(env, caseId, key, 'temp_resume', method);
  const ts = nowIso();
  await env.DB.batch([
    env.DB.prepare(`UPDATE cases SET resume_r2_key = NULL, resume_deleted_at = ?, updated_at = ? WHERE id = ?`).bind(ts, ts, caseId),
    env.DB.prepare(`UPDATE artifact_metadata SET deleted_at = ? WHERE case_id = ? AND object_key = ?`).bind(ts, caseId, key),
    env.DB.prepare(`UPDATE v2_deletion_index SET status = 'DELETED', last_attempt_at = ?, deleted_at = ? WHERE case_id = ? AND object_key = ?`).bind(ts, ts, caseId, key),
    env.DB.prepare(
      `INSERT OR IGNORE INTO v2_deletion_record (artifact_id, case_id, object_key, deletion_reason, deleted_at)
       SELECT id, case_id, object_key, ?, ? FROM artifact_metadata WHERE case_id = ? AND object_key = ?`,
    ).bind(method, ts, caseId, key),
  ]);
  return true;
}

export async function putObject(
  env: Env,
  key: string,
  body: ArrayBuffer | Uint8Array | string,
  contentType: string,
): Promise<void> {
  await env.RESUME_BUCKET.put(key, body, {
    httpMetadata: { contentType },
  });
}

export async function getObjectBytes(env: Env, key: string): Promise<ArrayBuffer | null> {
  const obj = await env.RESUME_BUCKET.get(key);
  if (!obj) return null;
  return obj.arrayBuffer();
}
