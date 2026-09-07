import type { EvidenceEntry } from '../types';

export type GateOutcome =
  | { ok: true }
  | { ok: false; status: 'RESEARCH_INCOMPLETE' | 'REVISE'; reason: string };

/**
 * Worker gates after Call A:
 * - zero VERIFIED load_bearing → RESEARCH_INCOMPLETE
 * - Best First Move depends on UNVERIFIED load_bearing → REVISE
 */
export function applyWorkerGates(
  evidence: EvidenceEntry[],
  draftMarkdown: string,
): GateOutcome {
  const loadBearing = evidence.filter((e) => e.load_bearing);
  const verifiedLb = loadBearing.filter((e) => String(e.status).toUpperCase() === 'VERIFIED');

  if (verifiedLb.length === 0) {
    return {
      ok: false,
      status: 'RESEARCH_INCOMPLETE',
      reason: 'Zero VERIFIED load-bearing evidence entries for the primary recommendation set.',
    };
  }

  const unverifiedLb = loadBearing.filter((e) => String(e.status).toUpperCase() === 'UNVERIFIED');
  if (unverifiedLb.length === 0) return { ok: true };

  const bfmRegion = extractBestFirstMoveRegion(draftMarkdown).toLowerCase();
  const bfmDependsOnUnverified = unverifiedLb.some((e) => {
    const claim = (e.claim || '').toLowerCase();
    const id = (e.claim_id || '').toLowerCase();
    if (!claim && !id) return false;
    if (bfmRegion && claim && bfmRegion.includes(claim.slice(0, Math.min(40, claim.length)))) {
      return true;
    }
    const section = (e.supports_section || '').toLowerCase();
    if (section.includes('best first move') || section.includes('bfm') || section.includes('section e')) {
      return true;
    }
    return false;
  });

  if (bfmDependsOnUnverified) {
    return {
      ok: false,
      status: 'REVISE',
      reason: 'Best First Move depends on UNVERIFIED load-bearing claim(s).',
    };
  }

  return { ok: true };
}

function extractBestFirstMoveRegion(md: string): string {
  const m = md.match(/Best First Move[\s\S]{0,2500}/i);
  return m ? m[0] : md.slice(0, 2000);
}
