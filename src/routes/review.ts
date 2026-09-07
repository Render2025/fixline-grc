import type { Env } from '../types';
import {
  getCase,
  getLatestAttempt,
  listCasesForReview,
  nowIso,
  recordMetric,
  updateCaseStatus,
} from '../lib/db';
import { html, json, notFound, unauthorized } from '../lib/http';
import { deleteTempResume, pdfKey, putObject } from '../lib/r2';
import { buildOpportunityPdf } from '../pipeline/pdf';
import type { DraftReport, EvidenceEntry } from '../types';
import { PilotModeError, requireHumanPilot } from '../lib/pilot';
import { PiiPersistenceError, assertNoContactDetails } from '../lib/intake-v2';

const COOKIE = 'fixline_review';

export async function requireReviewAuth(request: Request, env: Env): Promise<Response | null> {
  const expected = env.REVIEW_PASSWORD;
  if (!expected) return unauthorized('REVIEW_PASSWORD is not configured');

  const auth = request.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token === expected) return null;
  }

  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)fixline_review=([^;]+)/);
  if (match && decodeURIComponent(match[1]) === expected) return null;

  // Allow password via query for simple HTML form login posts handled separately
  return unauthorized('Reviewer auth required (Authorization: Bearer or cookie)');
}

export async function handleReviewLogin(request: Request, env: Env): Promise<Response> {
  if (request.method === 'GET') {
    return html(loginPage());
  }
  const form = await request.formData();
  const password = String(form.get('password') || '');
  if (!env.REVIEW_PASSWORD || password !== env.REVIEW_PASSWORD) {
    return html(loginPage('Invalid password'), 401);
  }
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'set-cookie': `${COOKIE}=${encodeURIComponent(password)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
    location: '/review',
  });
  return new Response(null, { status: 302, headers });
}

export async function handleReviewList(request: Request, env: Env): Promise<Response> {
  const denied = await requireReviewAuth(request, env);
  if (denied) {
    // soft redirect to login page for browsers
    if ((request.headers.get('accept') || '').includes('text/html')) {
      return html(loginPage('Sign in to continue'), 401);
    }
    return denied;
  }
  const cases = await listCasesForReview(env);
  const rows = cases
    .map(
      (c) => `<tr>
      <td><a href="/review/${escapeHtml(c.id)}">${escapeHtml(c.id.slice(0, 8))}…</a></td>
      <td>${escapeHtml(c.status)}</td>
      <td>${escapeHtml(c.usage_context)}</td>
      <td>${escapeHtml(c.updated_at)}</td>
    </tr>`,
    )
    .join('');
  return html(`<!doctype html><html><head><meta charset="utf-8"><title>FixLine Review</title>
<style>body{font:15px/1.5 system-ui;margin:24px;background:#f8fafc;color:#0f172a}table{border-collapse:collapse;width:100%;background:#fff}th,td{border:1px solid #e2e8f0;padding:8px 10px;text-align:left}a{color:#0f766e}</style>
</head><body>
<h1>FixLine GRC — Review queue</h1>
<p>Private reviewer UI. Prefer Cloudflare Access in front of /review*.</p>
<table><thead><tr><th>Case</th><th>Status</th><th>Context</th><th>Updated</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4">No cases yet</td></tr>'}</tbody></table>
</body></html>`);
}

export async function handleReviewCase(request: Request, env: Env, caseId: string): Promise<Response> {
  const denied = await requireReviewAuth(request, env);
  if (denied) {
    if ((request.headers.get('accept') || '').includes('text/html')) return html(loginPage('Sign in'), 401);
    return denied;
  }
  const row = await getCase(env, caseId);
  if (!row) return notFound('Case not found');
  const attempt = await getLatestAttempt(env, caseId);
  const draft = safeJson<DraftReport>(attempt?.draft_json);
  const evidence = safeJson<EvidenceEntry[]>(attempt?.evidence_log_json) || [];
  const qcFailures = attempt?.qc_failures_json || '[]';

  return html(`<!doctype html><html><head><meta charset="utf-8"><title>Review ${escapeHtml(caseId)}</title>
<style>
body{font:15px/1.5 system-ui;margin:24px;background:#f8fafc;color:#0f172a;max-width:1100px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin:12px 0}
pre{white-space:pre-wrap;word-break:break-word;background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;max-height:420px;overflow:auto}
.actions form{display:inline-block;margin-right:8px}button{padding:10px 14px;border-radius:999px;border:0;font-weight:700;cursor:pointer}
.approve{background:#0f766e;color:#fff}.revise{background:#f59e0b;color:#111}.reject{background:#b91c1c;color:#fff}
.meta{color:#475569;font-size:.92rem}
</style></head><body>
<p><a href="/review">← All cases</a></p>
<h1>Case ${escapeHtml(caseId)}</h1>
<div class="card meta">
  <div><strong>Status:</strong> ${escapeHtml(row.status)}</div>
  <div><strong>Goal:</strong> ${escapeHtml(row.current_goal)}</div>
  <div><strong>Location:</strong> ${escapeHtml(row.work_location)} · <strong>Hours:</strong> ${escapeHtml(row.hours_per_week)} · <strong>Usage:</strong> ${escapeHtml(row.usage_context)}</div>
  <div><strong>QC verdict:</strong> ${escapeHtml(attempt?.qc_verdict || '—')} · attempt #${attempt?.attempt_number ?? '—'}</div>
</div>
<div class="card">
  <h2>Actions</h2>
  <form class="actions" method="post" action="/review/${encodeURIComponent(caseId)}/approve"><button class="approve" type="submit">Approve → PDF</button></form>
  <form class="actions" method="post" action="/review/${encodeURIComponent(caseId)}/revise" onsubmit="const n=this.notes.value; if(!n) return false;">
    <input name="notes" placeholder="Revise notes" style="padding:8px;min-width:220px">
    <button class="revise" type="submit">Revise</button>
  </form>
  <form class="actions" method="post" action="/review/${encodeURIComponent(caseId)}/reject" onsubmit="return confirm('Reject this case?');">
    <input name="notes" placeholder="Reject reason" style="padding:8px;min-width:180px">
    <button class="reject" type="submit">Reject</button>
  </form>
</div>
<div class="card"><h2>Draft (student-facing content)</h2><pre>${escapeHtml(draft?.raw_markdown || '(no draft)')}</pre></div>
<div class="card"><h2>Evidence log</h2><pre>${escapeHtml(JSON.stringify(evidence, null, 2))}</pre></div>
<div class="card"><h2>QC failures</h2><pre>${escapeHtml(qcFailures)}</pre></div>
</body></html>`);
}

export async function handleReviewAction(
  request: Request,
  env: Env,
  caseId: string,
  action: 'approve' | 'revise' | 'reject',
): Promise<Response> {
  try {
    requireHumanPilot(env);
  } catch (err) {
    return json({ message: err instanceof PilotModeError ? err.message : 'Human pilot is unavailable.' }, 503);
  }
  const denied = await requireReviewAuth(request, env);
  if (denied) return denied;

  const row = await getCase(env, caseId);
  if (!row) return notFound('Case not found');

  let notes = '';
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const body = (await request.json().catch(() => ({}))) as { notes?: string };
    notes = String(body.notes || '');
  } else {
    const form = await request.formData().catch(() => null);
    notes = String(form?.get('notes') || '');
  }
  try {
    notes = assertNoContactDetails(notes);
  } catch (err) {
    return json({ message: err instanceof PiiPersistenceError ? err.message : 'Review notes are invalid.' }, 400);
  }

  if (action === 'approve') {
    const attempt = await getLatestAttempt(env, caseId);
    if (!attempt?.draft_json) {
      return json({ message: 'No draft available to approve' }, 400);
    }
    const draft = safeJson<DraftReport>(attempt.draft_json);
    const evidence = safeJson<EvidenceEntry[]>(attempt.evidence_log_json) || [];
    if (!draft?.raw_markdown) return json({ message: 'Draft missing raw markdown' }, 400);

    const pdfBytes = await buildOpportunityPdf({
      draft,
      evidence,
      college: row.college,
      generatedAt: new Date(),
    });
    const key = pdfKey(caseId);
    await putObject(env, key, pdfBytes, 'application/pdf');

    await updateCaseStatus(env, caseId, 'APPROVED_FOR_DELIVERY', {
      pdf_r2_key: key,
      processed_at: row.processed_at || nowIso(),
      review_notes: notes || 'approved',
      student_name: draft.student_name || row.student_name,
    });

    // Delete temp résumé ASAP after approve
    await deleteTempResume(env, caseId, row.resume_r2_key, 'approve');
    await recordMetric(env, 'approved_for_delivery', caseId, row.usage_context, {});

    if ((request.headers.get('accept') || '').includes('text/html')) {
      return Response.redirect(new URL(`/review/${caseId}`, request.url).toString(), 303);
    }
    return json({ ok: true, status: 'APPROVED_FOR_DELIVERY', pdf_r2_key: key });
  }

  if (action === 'reject') {
    await updateCaseStatus(env, caseId, 'REJECTED', {
      processed_at: nowIso(),
      review_notes: notes || 'rejected',
    });
    await deleteTempResume(env, caseId, row.resume_r2_key, 'reject');
    await recordMetric(env, 'rejected', caseId, row.usage_context, {});
    if ((request.headers.get('accept') || '').includes('text/html')) {
      return Response.redirect(new URL(`/review/${caseId}`, request.url).toString(), 303);
    }
    return json({ ok: true, status: 'REJECTED' });
  }

  // revise — store reviewer notes and re-enqueue if under max (attempts remain append-only from pipeline)
  const maxAttempts = Number(env.MAX_REVISE_ATTEMPTS || '3') || 3;
  const nextAttempt = (row.attempt_count || 0) + 1;

  if (nextAttempt <= maxAttempts) {
    await updateCaseStatus(env, caseId, 'REVISE', {
      review_notes: notes || 'revise',
    });
    await env.GENERATE_QUEUE.send({
      caseId,
      attemptNumber: nextAttempt,
      reason: 'revise',
    });
  } else {
    await updateCaseStatus(env, caseId, 'REVISE', {
      processed_at: nowIso(),
      last_error: 'Max attempts reached on human revise',
      review_notes: notes || 'revise',
    });
  }

  if ((request.headers.get('accept') || '').includes('text/html')) {
    return Response.redirect(new URL(`/review/${caseId}`, request.url).toString(), 303);
  }
  return json({ ok: true, status: 'REVISE' });
}

function loginPage(message = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Review login</title>
<style>body{font:16px system-ui;display:grid;place-items:center;min-height:100vh;background:#f8fafc}form{background:#fff;padding:24px;border-radius:16px;border:1px solid #e2e8f0;width:min(360px,90vw)}input,button{width:100%;padding:10px;margin-top:8px}button{background:#0f766e;color:#fff;border:0;border-radius:999px;font-weight:800}</style>
</head><body><form method="post" action="/review/login">
<h1>FixLine review</h1>
${message ? `<p>${escapeHtml(message)}</p>` : ''}
<label>Password<input type="password" name="password" required autocomplete="current-password"></label>
<button type="submit">Sign in</button>
</form></body></html>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function safeJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
