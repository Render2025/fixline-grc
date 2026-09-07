# FixLine GRC — Green River College pilot (Cloudflare Workers)

TypeScript Cloudflare Worker for the FixLine Opportunity Report pilot.

**Do not launch to GRC students until the five `test-fixtures/` cases all reach `APPROVED_FOR_DELIVERY` (see `scripts/beta-checklist.md`).**

**Do not claim résumé deletion works until you have tested R2 deletion + `deletion_records` (approve/reject and cron).**

Also see `MOCKS_AND_GAPS.md` for known limits and incomplete areas.

## What is included

- `POST /api/intake` — multipart intake, 30-day HMAC rate limit, temp R2 store, D1 case, queue enqueue, `{ redirect_url }`
- Additive FixLine v2 Step 1 intake/fact/provenance records; legacy form remains compatible and a guided-summary API intake may omit the résumé
- `GET /status/:caseId?t=token` — student status HTML (no résumé/QC internals)
- `GET /api/status/:caseId?t=token` — JSON status
- `GET /api/download/:caseId?t=token` — PDF only if `APPROVED_FOR_DELIVERY`
- `GET /review`, `/review/:caseId` — private reviewer HTML
- `POST /review/:caseId/approve|revise|reject` — Bearer or cookie `REVIEW_PASSWORD`
- Queue consumer — extract, Call A (web_search), gates, Call B (QC), HUMAN_REVIEW_REQUIRED on PASS
- Approve builds pdf-lib PDF to R2; temp résumé deleted ASAP
- Cron `*/5 * * * *` — purge temporary résumés using an upload-time deletion index (23h operational deadline, absolute 24h maximum)

Step 0 inventory, gap/mapping analysis, and diagrams are in `docs/`. `PILOT_MODE=human`; no code path autonomously releases a report.

Frozen prompts: `src/prompts/generator-v1.0.md`, `src/prompts/qc-auditor-v1.0.md`
Landing page: `public/green-river-college/index.html` with `data-endpoint="/api/intake"`.

## Deploy - exact numbered steps
1. Install Node 22+ and place this project on your machine.
2. cd into the fixline-grc directory.
3. Install Node dependencies in this project.
4. Authenticate the Cloudflare CLI (wrangler login).
5. Create the D1 database named fixline-grc.
6. Paste database_id into wrangler.toml d1 binding (replace REPLACE_WITH_D1_DATABASE_ID).
7. Create R2 bucket fixline-grc-resumes.
8. Create queue fixline-generate.
9. Optional: create DLQ fixline-generate-dlq and uncomment dead_letter_queue.
10. Apply D1 migrations remotely (db:migrate:remote script).
11. Configure Worker secret XAI_API_KEY.
12. Configure Worker secret RATE_LIMIT_SALT (long random).
13. Configure Worker secret REVIEW_PASSWORD.
14. Set PUBLIC_BASE_URL in wrangler.toml vars to Worker URL.
15. Confirm MAX_REVISE_ATTEMPTS=3 and both XAI model vars are grok-4.6.
16. Run typecheck and confirm it passes.
17. Publish the Worker (wrangler deploy).
18. If PUBLIC_BASE_URL was a placeholder, set the real URL and republish.
19. Point live form data-endpoint to YOUR_WORKER/api/intake.
20. Lock down /review with Access; sign in at /review/login using REVIEW_PASSWORD.
21. Complete scripts/beta-checklist.md five fixtures before GRC student launch.
22. Test deletion (approve/reject + cron) before claiming deletion works.

Front-end expects JSON redirect_url or message. See MOCKS_AND_GAPS.md.
