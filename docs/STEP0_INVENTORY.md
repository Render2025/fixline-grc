# Step 0 — repository inventory and frozen baseline

Inventory date: 2026-09-07. The checked-in repository, rather than earlier descriptions, is the baseline. Step 0 was completed before Step 1 behavior was changed; `tests/baseline.test.ts` captures the reproducible public health/not-found baseline.

## Routes and endpoints

| Method | Route | Baseline behavior |
|---|---|---|
| POST | `/api/intake` | Multipart pilot intake, rate limit, R2 upload, D1 insert, queue send. |
| GET | `/api/status/:caseId?t=...` | Token-protected JSON status. |
| GET | `/status/:caseId?t=...` | Token-protected student HTML status. |
| GET | `/api/download/:caseId?t=...` | PDF only in `APPROVED_FOR_DELIVERY`. |
| GET/POST | `/review/login` | Password login and cookie. |
| GET | `/review` and `/review/:caseId` | Password-protected human review list/detail. |
| POST | `/review/:caseId/{approve,revise,reject}` | Human decision; approval creates PDF. |
| GET | `/health` | Service health JSON. |
| GET | `/`, `/green-river-college[/]`, assets | Existing public frontend/static assets. |

The baseline Worker also had a queue consumer and an hourly scheduled retention handler. Step 1 tightens the schedule to every five minutes.

## Baseline intake and storage

The public form fields were `college`, `current_goal`, `work_location`, `hours_per_week` (`lt5`, `5-10`, `10-20`, `20plus`), optional `constraints`, `usage_context` (`self`, `advisor`), and required `resume`. It accepted PDF/TXT plus best-effort DOCX/RTF; legacy DOC was rejected. Files were capped at 8 MiB and text extraction had to produce at least 40 characters.

D1 migration `0001_init.sql` creates `cases`, append-only `attempts`, `rate_limits`, `deletion_records`, and `pilot_metrics`. The baseline puts raw resumes at `temp/{caseId}/{sanitized-original-name}` and approved reports at `pdf/{caseId}/opportunity-report.pdf` in the single `RESUME_BUCKET` R2 binding. D1 retains object keys and file metadata, but not raw extracted resume text. Queue messages contain only `caseId`, `attemptNumber`, and `reason`.

## Prompts, states, and human flow

The frozen prompt files are `generator-v1.0.md` and `qc-auditor-v1.0.md`. Their baseline SHA-256 values are recorded in `MOCKS_AND_GAPS.md`. The effective states are `QUEUED`, `PROCESSING`, `DRAFT_GENERATED`, `REVISE`, `RESEARCH_INCOMPLETE`, `HUMAN_REVIEW_REQUIRED`, `APPROVED_FOR_DELIVERY`, `REJECTED`, and `FAILED`.

The queue consumer extracts from R2, generates with xAI/web search, applies worker gates, performs a separate QC call, and routes a passing result to `HUMAN_REVIEW_REQUIRED`. It never approves automatically. A password-authenticated reviewer approves, requests revision, or rejects. Approval creates an R2 PDF and enables token-gated download; approval and rejection delete the temporary resume.

## Baseline retention, flags, and tests

The baseline hourly purge used `processed_at + 24h`, so an unprocessed object had no deletion deadline and the implementation did **not** meet an absolute upload-to-deletion limit. Deletion success was written to legacy `deletion_records`. Baseline variables were `PUBLIC_BASE_URL`, `MAX_REVISE_ATTEMPTS`, `XAI_MODEL_GENERATE`, and `XAI_MODEL_QC`; secrets were `XAI_API_KEY`, `RATE_LIMIT_SALT`, and `REVIEW_PASSWORD`. There was no explicit pilot-mode flag. There was no automated test runner; five text fixtures and a manual beta checklist were present.

## Files identified for Step 1

- `migrations/0002_v2_evidence_ready.sql` — additive v2 records and policy/deletion indexes.
- `src/types.ts`, `src/lib/intake-v2.ts` — v2 contract, unavailable-value and PII rules.
- `src/routes/intake.ts`, `src/lib/db.ts` — compatible evidence-ready/no-resume intake and provenance persistence.
- `src/pipeline/generate.ts` — expiry gate and fail-closed persistence checks; guided summaries are not treated as résumés.
- `src/lib/r2.ts`, `src/lib/retention.ts` — opaque file naming and absolute active-storage deletion metadata/enforcement.
- `wrangler.toml`, `.dev.vars.example` — explicit human pilot mode; consent versions resolve from D1 policy records.
- `tests/*`, `package.json` — reproducible baseline and Step 1 checks.
- `README.md`, `ARCHITECTURE.md`, `MOCKS_AND_GAPS.md` — operational truth after Step 1.
