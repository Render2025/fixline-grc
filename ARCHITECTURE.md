# FixLine GRC Backend — Architecture (working plan)

Live frontend (do not redesign): https://green-river-college.dsolomon.workers.dev/

## Status
- Architecture: proposed / working plan
- Code: NOT started — blocked on Generator Prompt v1.0 + QC Auditor Prompt texts

## Form fields (existing page)
- college (hidden): Green River College
- current_goal
- work_location
- hours_per_week: lt5 | 5-10 | 10-20 | 20plus
- constraints (optional)
- usage_context: self | advisor
- resume: pdf, doc, docx, txt, rtf

Front-end patch only: set form `data-endpoint` to `/api/intake` (currently empty).
Submit already accepts JSON `{ redirect_url }` or `{ message }`.

## Pipeline
1. POST /api/intake → validate, 30-day gate, temp R2 store, enqueue
2. Redirect to /status/:caseId
3. Queue job:
   - extract résumé text
   - Call A: xAI Responses API + web_search + Generator Prompt v1.0
   - Research Evidence Log
   - gates: RESEARCH_INCOMPLETE / REVISE
   - Call B: separate Grok QC request (QC Auditor Prompt; no web_search)
   - QC PASS → HUMAN_REVIEW_REQUIRED (beta: never auto-deliver)
4. Reviewer (Cloudflare Access): APPROVE / REVISE / REJECT
5. APPROVE → PDF → APPROVED_FOR_DELIVERY → student download
6. Cron: delete résumé ≤24h after processing; write deletion_records

## States
DRAFT_GENERATED | REVISE | RESEARCH_INCOMPLETE | HUMAN_REVIEW_REQUIRED | APPROVED_FOR_DELIVERY

Only APPROVED_FOR_DELIVERY may produce downloadable student PDF.

## Cloudflare
- Worker
- Queues (fixline-generate)
- R2 (temp résumés + final PDFs)
- D1 (cases, attempts, rate_limits, deletion_records, pilot_metrics)
- Cron Trigger (hourly purge)
- Cloudflare Access (/review*)

## xAI
- Call A: POST https://api.x.ai/v1/responses — model with tools: [{ "type": "web_search" }]
- Call B: separate POST /v1/responses — QC only, no web_search
- Live-verify only load-bearing claims (Best First Move, alt #1, alt #2, critical eligibility, critical training/cert)

## Secrets
XAI_API_KEY, XAI_MODEL_GENERATE, XAI_MODEL_QC, RATE_LIMIT_SALT, PUBLIC_BASE_URL, MAX_REVISE_ATTEMPTS
Bindings: DB, RESUME_BUCKET, GENERATE_QUEUE

## 30-day limit
HMAC-SHA256(salt, normalize(resume_text) + "|" + college) — no accounts, no email on form.

## Privacy
No résumés in git/logs/permanent D1. Temp R2 only. Delete ≤24h. Deletion records. Don't claim deletion works until tested.

## Blockers before build
1. Exact FixLine Personalized Opportunity Report Generator Prompt v1.0
2. Exact FixLine QC Auditor Prompt

## Cannot fully automate
Human approve; guaranteeing zero invented facts across live runs; Office format extract quality; deploy needs your Cloudflare auth; deletion proof until tested.
