# FixLine GRC — Beta checklist (five APPROVED_FOR_DELIVERY gates)

**Do not launch to Green River College students until all five fixtures below reach `APPROVED_FOR_DELIVERY` with a downloadable PDF.**

**Do not claim résumé deletion works until you have verified R2 object absence + a matching `deletion_records` row after approve/reject/cron.**

## Fixtures

Use files in `test-fixtures/`:

1. `strong-student.txt`
2. `sparse.txt`
3. `career-changer.txt`
4. `messy-gaps.txt`
5. `highly-educated-unclear.txt`

## Per-fixture procedure

For each file:

1. Open the pilot page (`/green-river-college/` or live Pages URL with `data-endpoint` pointed at this Worker `/api/intake`).
2. Fill intake fields realistically for that persona; set `usage_context` once as `self` and at least once as `advisor` across the set.
3. Upload the `.txt` fixture.
4. Confirm JSON redirect to `/status/:caseId?t=...`.
5. Wait until status is `HUMAN_REVIEW_REQUIRED` (or document `REVISE` / `RESEARCH_INCOMPLETE` / `FAILED` — those do **not** count as pass).
6. Sign in to `/review`, open the case, confirm draft + evidence look sane (no invented employers/degrees beyond the fixture).
7. Click **Approve → PDF**.
8. Confirm case status `APPROVED_FOR_DELIVERY`.
9. On the student status link, download PDF via `/api/download/:caseId?t=...`.
10. Confirm PDF contains branding, name/date, report body, evidence/limitations, and **no QC notes**.
11. Confirm temp résumé key under `temp/{caseId}/` is gone and `deletion_records` has a `temp_resume` row for that case.

## Gate table

| # | Fixture | Case ID | HUMAN_REVIEW_REQUIRED | APPROVED_FOR_DELIVERY | PDF download OK | Temp résumé deleted + deletion_records | Notes |
|---|---------|---------|-----------------------|-----------------------|-----------------|----------------------------------------|-------|
| 1 | strong-student.txt | | ☐ | ☐ | ☐ | ☐ | |
| 2 | sparse.txt | | ☐ | ☐ | ☐ | ☐ | |
| 3 | career-changer.txt | | ☐ | ☐ | ☐ | ☐ | |
| 4 | messy-gaps.txt | | ☐ | ☐ | ☐ | ☐ | |
| 5 | highly-educated-unclear.txt | | ☐ | ☐ | ☐ | ☐ | |

## Additional checks before student launch

- [ ] 30-day rate limit blocks immediate re-upload of the same normalized résumé text + college
- [ ] Status page never shows résumé text or QC internals
- [ ] Download denied unless `APPROVED_FOR_DELIVERY`
- [ ] Cron retention purge tested with a processed case older than 24h (or temporarily shortened cutoff in a non-prod Worker)
- [ ] Secrets set: `XAI_API_KEY`, `RATE_LIMIT_SALT`, `REVIEW_PASSWORD`
- [ ] `PUBLIC_BASE_URL` matches the deployed Worker URL
- [ ] Live marketing page `data-endpoint` points to this Worker’s `/api/intake` only when ready

## Explicit non-claims

- Deletion is implemented but **unproven** until the table above and cron test are checked.
- DOC (legacy binary) upload is expected to fail with a clear PDF/TXT message.
