# Baseline architecture diagram

```mermaid
flowchart LR
  U[Student / unchanged public form] -->|multipart POST| W[Cloudflare Worker]
  W -->|legacy + additive v2 metadata| D[(D1)]
  W -->|raw resume, temporary| R[(R2 temp/case/resume.ext)]
  W -->|caseId + attempt only| Q[Cloudflare Queue]
  Q --> C[Queue consumer]
  C -->|read transient bytes| R
  C -->|generation with web search| X[xAI Call A]
  C -->|separate QC| Y[xAI Call B]
  C -->|attempt + HUMAN_REVIEW_REQUIRED| D
  H[Human reviewer] -->|approve/revise/reject| W
  W -->|approved PDF| P[(R2 pdf/case/report.pdf)]
  U -->|token-gated status/download| W
  S[Hourly cron in frozen baseline] -->|processed-at retention| R
  S -->|deletion records| D
```

Privacy boundary: raw resume bytes exist only in temporary R2 and transient Worker/model-call memory. D1 and Queue carry structured/sanitized facts and identifiers, never raw resume text or contact details. Human review remains the only release path.
