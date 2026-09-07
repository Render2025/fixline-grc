import type { Env } from '../types';
import { insertDeletionRecord, nowIso } from './db';

export function isArtifactDue(deleteBy: string | null, nowMs = Date.now()): boolean {
  if (!deleteBy) return true;
  const deadline = Date.parse(deleteBy);
  return Number.isNaN(deadline) || deadline <= nowMs;
}

/**
 * Five-minute cron: purge temp résumés no later than 24h after entering active storage.
 * Writes deletion_records only after successful R2 delete.
 * Do not claim this works in production until tested.
 */
export async function runRetentionPurge(env: Env): Promise<{ scanned: number; deleted: number }> {
  const now = nowIso();
  const rows = await env.DB.prepare(
    `SELECT c.id, c.resume_r2_key, c.status, a.id AS artifact_id
     FROM cases c
     JOIN artifact_metadata a ON a.case_id = c.id AND a.object_key = c.resume_r2_key
     JOIN v2_deletion_index d ON d.artifact_id = a.id
     WHERE c.resume_r2_key IS NOT NULL AND c.resume_deleted_at IS NULL
       AND d.status IN ('PENDING', 'FAILED') AND d.delete_by <= ?`,
  )
    .bind(now)
    .all<{ id: string; resume_r2_key: string; status: string; artifact_id: string }>();

  let deleted = 0;
  const list = rows.results ?? [];
  for (const row of list) {
    try {
      await env.RESUME_BUCKET.delete(row.resume_r2_key);
      const ts = nowIso();
      await insertDeletionRecord(env, row.id, row.resume_r2_key, 'temp_resume', 'cron');
      await env.DB.batch([
        env.DB.prepare(`UPDATE cases SET resume_r2_key = NULL, resume_deleted_at = ?, updated_at = ? WHERE id = ?`).bind(ts, ts, row.id),
        env.DB.prepare(`UPDATE artifact_metadata SET deleted_at = ? WHERE id = ?`).bind(ts, row.artifact_id),
        env.DB.prepare(`UPDATE v2_deletion_index SET status = 'DELETED', last_attempt_at = ?, deleted_at = ? WHERE artifact_id = ?`).bind(ts, ts, row.artifact_id),
        env.DB.prepare(`INSERT OR IGNORE INTO v2_deletion_record (artifact_id, case_id, object_key, deletion_reason, deleted_at) VALUES (?, ?, ?, '24_HOUR_ABSOLUTE_LIMIT', ?)`).bind(row.artifact_id, row.id, row.resume_r2_key, ts),
      ]);
      deleted += 1;
    } catch {
      await env.DB.prepare(`UPDATE v2_deletion_index SET status = 'FAILED', last_attempt_at = ? WHERE artifact_id = ?`).bind(nowIso(), row.artifact_id).run();
    }
  }
  return { scanned: list.length, deleted };
}
