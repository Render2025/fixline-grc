# FixLine v2 Step 0 gap analysis and legacy mapping

## Gap analysis

| v2 Step 1 contract | Frozen baseline | Step 1 disposition |
|---|---|---|
| Explicit `UNKNOWN` / `WITHHELD` | Empty strings/null only | Preserve explicit sentinels; distinguish omitted values and provenance. |
| Separate work/study hours | One `hours_per_week` | Add both; map legacy hours to work hours. |
| Consent version/time | No structured record | Add version and timestamp with a legacy-notice compatibility default. |
| Country/locality/timezone | Free-text work location | Add all three; map location to locality. |
| Goal, income urgency/floor | Goal only | Preserve goal; add urgency/floor. |
| Mobility/transportation/authorization | Possibly buried in constraints | Add separate self-report fields without inferring from constraints. |
| Education status | Resume only | Add self-report field. |
| Constraints/context | Existing fields | Preserve and normalize as user facts. |
| Delivery/language/accessibility | Not represented | Add preferences; do not collect a delivery address/contact in D1. |
| No-resume guided summary | Resume mandatory | Permit a sanitized summary of at least 40 characters. |
| Fact provenance | None | Add user/resume fact tables with source and collection time. |
| No raw/contact in D1/Queue | Queue IDs only; generated attempts could repeat contacts; filenames could contain PII | Keep ID-only queue, use opaque filenames, and fail closed before unsafe intake/model output reaches D1. |
| Absolute 24h active storage | 24h after `processed_at` | Deadline/index at upload, with a 23h operational deadline for hourly scheduling margin. |
| Human processing | Passing QC went to human | Preserve and make `HUMAN_PROCESSING` explicit/immutable in v2 schema/config. |

Step 2+ generation redesign, extraction-to-structured-resume-facts, policy automation, autonomous release, public deployment, and frontend redesign remain out of scope.

## Legacy field mapping

| Legacy | v2 | Rule |
|---|---|---|
| `cases.id` | `v2_case.id`, `legacy_case_id` | Same UUID, one-to-one. |
| `college` | user fact / legacy compatibility | Fixed GRC pilot value. |
| `current_goal` | `v2_intake.current_goal` | Direct, contact-redacted. |
| `work_location` | `locality` | `LEGACY_MAPPING`; country/timezone remain omitted unless explicitly supplied. |
| `hours_per_week` | `work_hours` | `LEGACY_MAPPING`; study hours remain omitted unless supplied. |
| `constraints` | `constraints` | Direct, contact-redacted; no inference into other fields. |
| `usage_context` | `usage_context` | Direct. |
| resume presence | `resume_provided` fact | Boolean metadata only; no raw text. |
| no equivalent | other v2 intake fields | Supplied value, explicit sentinel, or omitted; delivery defaults to status-page download with `SYSTEM_DEFAULT` provenance. |

## State mapping

Every legacy state maps one-to-one to `v2_case.state`. `v2_case_event` provides an append-only transition history. `processing_mode` is always `HUMAN_PROCESSING`; `APPROVED_FOR_DELIVERY` remains possible only through the existing authenticated reviewer action.

## Repository/spec conflict noted

No separate canonical-specification file was present in the delivered repository/archive. This implementation therefore treats the requirements quoted in the task—especially the named Step 1 fields and prohibitions—as the available governing excerpt. Exact canonical enum vocabularies beyond `UNKNOWN`/`WITHHELD` were unavailable, so Step 1 stores non-empty self-reported strings rather than inventing restrictive enums.
