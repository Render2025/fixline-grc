import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { DraftReport, EvidenceEntry } from '../types';

/**
 * Student-facing PDF. Branding, name, date, A–P content, evidence, limitations.
 * NO QC notes.
 */
export async function buildOpportunityPdf(args: {
  draft: DraftReport;
  evidence: EvidenceEntry[];
  college: string;
  generatedAt?: Date;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const margin = 50;
  const pageWidth = 612;
  const pageHeight = 792;
  const maxWidth = pageWidth - margin * 2;
  const lineHeight = 14;

  let page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const ensureSpace = (need: number) => {
    if (y - need < margin) {
      page = doc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
  };

  const drawWrapped = (text: string, size: number, bold = false, color = rgb(0.06, 0.09, 0.16)) => {
    const f = bold ? fontBold : font;
    const words = text.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const trial = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(trial, size) > maxWidth) {
        ensureSpace(lineHeight + 2);
        page.drawText(line, { x: margin, y, size, font: f, color });
        y -= lineHeight;
        line = word;
      } else {
        line = trial;
      }
    }
    if (line) {
      ensureSpace(lineHeight + 2);
      page.drawText(line, { x: margin, y, size, font: f, color });
      y -= lineHeight;
    }
  };

  const drawHeading = (text: string, size = 16) => {
    y -= 8;
    ensureSpace(size + 10);
    page.drawText(text.slice(0, 110), {
      x: margin,
      y,
      size,
      font: fontBold,
      color: rgb(0.06, 0.46, 0.43),
    });
    y -= size + 8;
  };

  // Cover / header
  drawHeading('FixLine Opportunity Report', 20);
  drawWrapped(args.college, 11, true, rgb(0.3, 0.35, 0.4));
  const name = args.draft.student_name || 'Student';
  const when = (args.generatedAt || new Date()).toISOString().slice(0, 10);
  drawWrapped(`Prepared for: ${name}`, 12, true);
  drawWrapped(`Date: ${when}`, 11);
  y -= 10;
  drawWrapped(
    'This report ranks realistic next steps from résumé evidence and live research. It is not a guarantee of employment, admission, funding, or outcomes.',
    10,
    false,
    rgb(0.3, 0.35, 0.4),
  );
  y -= 12;

  // Body — strip obvious QC sections if model leaked them
  const body = sanitizeStudentMarkdown(args.draft.raw_markdown);
  for (const block of body.split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (/^#{1,3}\s+/.test(trimmed)) {
      drawHeading(trimmed.replace(/^#{1,3}\s+/, ''), 13);
      const rest = trimmed.replace(/^#{1,3}\s+[^\n]+\n?/, '').trim();
      if (rest) drawWrapped(rest.replace(/\n/g, ' '), 10);
    } else if (/^[A-P]\.\s+/.test(trimmed)) {
      drawHeading(trimmed.split('\n')[0], 12);
      const rest = trimmed.split('\n').slice(1).join(' ').trim();
      if (rest) drawWrapped(rest, 10);
    } else {
      drawWrapped(trimmed.replace(/\n/g, ' '), 10);
    }
    y -= 6;
  }

  // Evidence appendix (student-safe)
  y -= 8;
  drawHeading('Research Evidence (selected)', 14);
  const verified = args.evidence.filter((e) => String(e.status).toUpperCase() === 'VERIFIED');
  const list = verified.length ? verified : args.evidence;
  if (!list.length) {
    drawWrapped('No structured evidence entries were available for this appendix.', 10);
  } else {
    for (const e of list.slice(0, 40)) {
      drawWrapped(
        `• [${e.status}] ${e.claim || e.claim_id} — ${e.source_title || 'source'}${e.source_url ? ` (${e.source_url})` : ''}`,
        9,
      );
      y -= 2;
    }
  }

  y -= 10;
  drawHeading('Limitations', 14);
  drawWrapped(
    'FixLine does not guarantee employment, income, admission, funding, or business success. Opportunities, program rules, and eligibility can change — verify critical details directly. Green River College is not affiliated with or responsible for FixLine unless otherwise stated.',
    10,
    false,
    rgb(0.3, 0.35, 0.4),
  );

  return doc.save();
}

function sanitizeStudentMarkdown(md: string): string {
  return md
    .replace(/```json[\s\S]*?```/gi, '')
    .replace(/VERDICT\s*:\s*(PASS|REVISE|RESEARCH_INCOMPLETE)[\s\S]*$/i, '')
    .replace(/CHECK\s+\d+\s*:\s*(PASS|FAIL)[\s\S]*?(?=\n[A-Z]|$)/gi, '')
    .trim();
}
