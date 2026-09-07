import type { Env } from '../types';
import { getCase } from '../lib/db';
import { notFound, unauthorized } from '../lib/http';
import { verifyAccessToken } from '../lib/tokens';

export async function handleDownload(request: Request, env: Env, caseId: string): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('t') || request.headers.get('x-access-token') || '';
  const row = await getCase(env, caseId);
  if (!row) return notFound('Case not found');
  const ok = await verifyAccessToken(token, row.access_token_hash);
  if (!ok) return unauthorized('Valid token required');

  if (row.status !== 'APPROVED_FOR_DELIVERY' || !row.pdf_r2_key) {
    return new Response(JSON.stringify({ message: 'PDF is only available after approval.' }), {
      status: 403,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const obj = await env.RESUME_BUCKET.get(row.pdf_r2_key);
  if (!obj) return notFound('PDF missing');

  const headers = new Headers();
  headers.set('content-type', 'application/pdf');
  headers.set('content-disposition', `attachment; filename="FixLine-Opportunity-Report-${caseId.slice(0, 8)}.pdf"`);
  headers.set('cache-control', 'private, no-store');
  return new Response(obj.body, { status: 200, headers });
}
