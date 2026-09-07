import type { Env } from '../types';
import { rateLimitFingerprint } from './crypto';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function checkAndRecordRateLimit(
  env: Env,
  resumeText: string,
  college: string,
  caseId: string,
): Promise<{ ok: true; fingerprint: string } | { ok: false; message: string; fingerprint: string }> {
  const fingerprint = await rateLimitFingerprint(env.RATE_LIMIT_SALT, resumeText, college);
  const now = new Date();
  const row = await env.DB.prepare(
    `SELECT fingerprint, first_seen_at, last_seen_at, case_id FROM rate_limits WHERE fingerprint = ?`,
  )
    .bind(fingerprint)
    .first<{ fingerprint: string; first_seen_at: string; last_seen_at: string; case_id: string | null }>();

  if (row) {
    const first = Date.parse(row.first_seen_at);
    if (!Number.isNaN(first) && now.getTime() - first < THIRTY_DAYS_MS) {
      return {
        ok: false,
        fingerprint,
        message:
          'During this pilot, the same résumé may generate one new report every 30 days. Please try again after the waiting period, or after a meaningful résumé update.',
      };
    }
  }

  const iso = now.toISOString();
  await env.DB.prepare(
    `INSERT INTO rate_limits (fingerprint, college, first_seen_at, last_seen_at, case_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(fingerprint) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       first_seen_at = excluded.first_seen_at,
       case_id = excluded.case_id,
       college = excluded.college`,
  )
    .bind(fingerprint, college, iso, iso, caseId)
    .run();

  return { ok: true, fingerprint };
}
