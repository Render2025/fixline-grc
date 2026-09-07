import type { Env } from '../types';
import { getCase } from '../lib/db';
import { html, json, notFound, unauthorized } from '../lib/http';
import { verifyAccessToken } from '../lib/tokens';

async function authorizeCase(
  request: Request,
  env: Env,
  caseId: string,
): Promise<{ ok: true; row: NonNullable<Awaited<ReturnType<typeof getCase>>>; token: string } | { ok: false; response: Response }> {
  const url = new URL(request.url);
  const token = url.searchParams.get('t') || request.headers.get('x-access-token') || '';
  const row = await getCase(env, caseId);
  if (!row) return { ok: false, response: notFound('Case not found') };
  const valid = await verifyAccessToken(token, row.access_token_hash);
  if (!valid) return { ok: false, response: unauthorized('Valid status token required') };
  return { ok: true, row, token };
}

export async function handleStatusPage(request: Request, env: Env, caseId: string): Promise<Response> {
  const auth = await authorizeCase(request, env, caseId);
  if (!auth.ok) return auth.response;
  const { row, token } = auth;

  const downloadReady = row.status === 'APPROVED_FOR_DELIVERY' && !!row.pdf_r2_key;
  const studentLabel = publicStatusLabel(row.status);
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Report status | FixLine GRC</title>
<style>
:root{--bg:#f8fafc;--ink:#0f172a;--muted:#475569;--line:#e2e8f0;--teal:#0f766e;--soft:#f0fdfa;--white:#fff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 system-ui,sans-serif}
.wrap{width:min(720px,calc(100% - 32px));margin:40px auto}.card{background:var(--white);border:1px solid var(--line);border-radius:20px;padding:28px;box-shadow:0 16px 46px rgba(15,23,42,.06)}
.eyebrow{font-size:.75rem;letter-spacing:.12em;text-transform:uppercase;font-weight:900;color:var(--teal)}
h1{font-size:1.8rem;letter-spacing:-.03em;margin:8px 0 12px}p{color:var(--muted)}
.btn{display:inline-flex;margin-top:16px;padding:12px 18px;border-radius:999px;background:var(--teal);color:#fff;text-decoration:none;font-weight:800}
.badge{display:inline-block;padding:6px 10px;border-radius:999px;background:var(--soft);color:var(--teal);font-weight:800;font-size:.85rem}
.small{font-size:.88rem;color:var(--muted)}
</style>
</head>
<body>
<main class="wrap">
  <div class="card">
    <div class="eyebrow">Green River College pilot</div>
    <h1>Your FixLine report status</h1>
    <p class="badge">${escapeHtml(studentLabel)}</p>
    <p>${escapeHtml(publicStatusHelp(row.status))}</p>
    ${downloadReady ? `<p><a class="btn" href="/api/download/${encodeURIComponent(caseId)}?t=${encodeURIComponent(token!)}">Download PDF report</a></p>` : ''}
    <p class="small">Case reference: ${escapeHtml(caseId)}</p>
    <p class="small">This page does not show résumé contents or internal QC details. Keep this link private.</p>
  </div>
</main>
<script>
(function(){
  const ready = ${downloadReady ? 'true' : 'false'};
  if (ready) return;
  const terminal = ${jsonBool(isTerminalStudentStatus(row.status))};
  if (terminal) return;
  setTimeout(function(){ location.reload(); }, 15000);
})();
</script>
</body>
</html>`;
  return html(body);
}

export async function handleStatusApi(request: Request, env: Env, caseId: string): Promise<Response> {
  const auth = await authorizeCase(request, env, caseId);
  if (!auth.ok) return auth.response;
  const { row } = auth;
  return json({
    case_id: row.id,
    status: row.status,
    public_label: publicStatusLabel(row.status),
    download_ready: row.status === 'APPROVED_FOR_DELIVERY' && !!row.pdf_r2_key,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

function publicStatusLabel(status: string): string {
  switch (status) {
    case 'QUEUED':
    case 'PROCESSING':
    case 'DRAFT_GENERATED':
    case 'REVISE':
      return 'Generating your report';
    case 'HUMAN_REVIEW_REQUIRED':
      return 'In review';
    case 'APPROVED_FOR_DELIVERY':
      return 'Ready to download';
    case 'RESEARCH_INCOMPLETE':
      return 'Needs more research — we will follow up';
    case 'REJECTED':
      return 'Not deliverable';
    case 'FAILED':
      return 'Processing issue';
    default:
      return 'In progress';
  }
}

function publicStatusHelp(status: string): string {
  switch (status) {
    case 'APPROVED_FOR_DELIVERY':
      return 'Your Opportunity Report is ready. Download the PDF below.';
    case 'HUMAN_REVIEW_REQUIRED':
      return 'Your draft passed automated checks and is waiting for a short human review before release.';
    case 'RESEARCH_INCOMPLETE':
      return 'Live research could not verify enough load-bearing claims for a student-ready report yet.';
    case 'REJECTED':
      return 'This report will not be released. If you believe this is an error, contact the pilot operator.';
    case 'FAILED':
      return 'Something went wrong while processing. You may try again later with PDF or TXT.';
    default:
      return 'FixLine is analyzing your résumé and building your Opportunity Report. This page refreshes automatically.';
  }
}

function isTerminalStudentStatus(status: string): boolean {
  return ['APPROVED_FOR_DELIVERY', 'RESEARCH_INCOMPLETE', 'REJECTED', 'FAILED'].includes(status);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function jsonBool(v: boolean): string {
  return v ? 'true' : 'false';
}
