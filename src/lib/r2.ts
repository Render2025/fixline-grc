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
  method: 'approve' | 'reject' | 'cron' | 'pipeline',
): Promise<boolean> {
  if (!key) return false;
  try {
    await env.RESUME_BUCKET.delete(key);
  } catch {
    return false;
  }
  await insertDeletionRecord(env, caseId, key, 'temp_resume', method);
  await env.DB.prepare(
    `UPDATE cases SET resume_r2_key = NULL, resume_deleted_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(nowIso(), nowIso(), caseId)
    .run();
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
