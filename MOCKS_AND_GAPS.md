# FixLine GRC mocks
## Implemented (real code paths)

- Multipart intake with existing field names + validation
- 30-day HMAC rate-limit gate (D1 `rate_limits`)
- Temp résumé put to R2; case + access token in D1
- Queue enqueue + consumer ortchestration
- Dual xAI Responses API calls: Call A with `tools: [{ type: "web_search" }]`, Call B without tools
- Frozen prompts loaded as Text modules (verbatim)
- Evidence log JSON parsing + worker-side gates
- Append-only `attempts` rows
- Reviewer UI (list, detail, APPROVE/REVISE/REJECT) with password auth
- PDF via pdf-lib on APPROVE; download gated on APPROVED_FOR_DELIVERY- Retention cron + `deletion_records`
- Five synthetic .txt fixtures + beta checklist
- Bundled public HTML with data-endpoint=/api/intake


## Limited / best-effort

- Legacy .doc: not supported (clear error → PDF/TXT)
- .rtf: best-effort strip, not a full parser
- .docx: minimal ZIP/XML text extract
- PDF via unpdf: text PDFs OK; scanned PDFs fail
- Evidence log parse: heuristic JSON from model text (fragile if no JSON array)
- Draft parse: heuristic markdown sections
- PDF layout: plain multi-page; not designed print / no visual tables
- Student name: from draft if present else "Student"
- Reviewer auth: REVIEW_PASSWORD only; CF Access documented not coded
- xAI envelope parse: defensive; may need tweak if API changes
- REVISE: re-enqueue with QC feedback; model must revise
- Extra states: PROCESSING / FAILED also used


## Real code but untested live

1. Live web_search citations feeding Evidence Log
2. Five-fixture beta to five APPROVED_FOR_DELIVERY
3. R2 deletion + deletion_records proof (do not claim deletion works until tested)
4. Cron purge with case older than 24h
5. Queue retries under real load
6. Deploy to your Cloudflare account
7. Cross-origin POST from existing dsolomon.workers.dev — CORS may be missing if intake is on a different Worker host

## Not implemented / out of scope in this zip

- Deploy to your Cloudflare account (intentionally not done)
- Cloudflare Access policy (documented only)
- Email delivery of PDF (status-token download only)
- Student accounts / SSO (by design)
- Editing frozen prompts (forbidden without new version)
- Guaranteeing zero invented facts (prompts + QC + human review only)
- Dead-letter queue (commented placeholder in wrangler.toml)
- Auto-wiring already-deployed dsolomon.workers.dev HTML (you must set data-endpoint)
- Origin cloud-agent repo (no Origin namespace; zip is the deliverable)

## Prompt SHA-256

- generator-v1.0.md: 4ee50ef6e7d795a59db2c69de30e759144a27128b920674b853357e874df8bb6
- qc-auditor-v1.0.md: 787eb0967b30ae224d750437672f43a09ce520d7396febaaa500aee1204e1da4
