import type { DraftReport, EvidenceEntry, QcFailure, QcResult } from '../types';

/** Extract Research Evidence Log entries — prefer JSON array in model output. */
export function parseEvidenceLog(raw: string): EvidenceEntry[] {
  const jsonBlock = extractJsonArray(raw);
  if (jsonBlock) {
    try {
      const parsed = JSON.parse(jsonBlock) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map(normalizeEvidence).filter(Boolean) as EvidenceEntry[];
      }
    } catch {
      // fall through
    }
  }

  const idx = raw.search(/Research Evidence Log/i);
  if (idx >= 0) {
    const slice = raw.slice(idx);
    const arr = extractJsonArray(slice);
    if (arr) {
      try {
        const parsed = JSON.parse(arr) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.map(normalizeEvidence).filter(Boolean) as EvidenceEntry[];
        }
      } catch {
        /* ignore */
      }
    }
  }
  return [];
}

function normalizeEvidence(e: any): EvidenceEntry | null {
  if (!e || typeof e !== 'object') return null;
  const status = String(e.status || '').toUpperCase();
  return {
    claim_id: String(e.claim_id ?? e.claimId ?? ''),
    claim: String(e.claim ?? ''),
    source_title: String(e.source_title ?? e.sourceTitle ?? ''),
    source_url: String(e.source_url ?? e.sourceUrl ?? ''),
    checked_at: String(e.checked_at ?? e.checkedAt ?? ''),
    supports_section: String(e.supports_section ?? e.supportsSection ?? ''),
    status: status === 'VERIFIED' || status === 'UNVERIFIED' ? status : String(e.status ?? 'UNVERIFIED'),
    load_bearing: Boolean(e.load_bearing ?? e.loadBearing ?? false),
  };
}

function extractJsonArray(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/i);
  if (fence) return fence[1];
  const start = text.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        if (candidate.includes('{')) return candidate;
        return null;
      }
    }
  }
  return null;
}

export function parseDraft(raw: string): DraftReport {
  const name =
    raw.match(/(?:Student|Candidate|Name)\s*[:|-]\s*(.+)/i)?.[1]?.trim() ||
    raw.match(/^#\s+(.+)/m)?.[1]?.trim();

  const bfm =
    raw.match(/Best First Move[:\s]*([^\n]+)/i)?.[1]?.trim() ||
    raw.match(/##?\s*Best First Move[\s\S]*?\n\n([^\n]+)/i)?.[1]?.trim();

  return {
    raw_markdown: raw,
    student_name: name,
    best_first_move: bfm,
  };
}

export function parseQcResult(raw: string): QcResult {
  const verdictMatch = raw.match(/VERDICT\s*:\s*(PASS|REVISE|RESEARCH_INCOMPLETE)/i);
  const verdict = (verdictMatch?.[1] || 'REVISE').toUpperCase();

  const failures: QcFailure[] = [];
  const failBlocks = raw.split(/(?=-\s*CHECK\s*:)/i);
  for (const block of failBlocks) {
    if (!/-\s*CHECK\s*:/i.test(block)) continue;
    const get = (label: string) =>
      block.match(new RegExp(`-\\s*${label}\\s*:\\s*(.+)`, 'i'))?.[1]?.trim();
    failures.push({
      check: get('CHECK'),
      severity: get('SEVERITY'),
      location: get('LOCATION'),
      quote: get('QUOTE'),
      required_fix: get('REQUIRED FIX'),
      systemic_possibility: get('SYSTEMIC POSSIBILITY'),
    });
  }

  return { verdict, failures, raw };
}
