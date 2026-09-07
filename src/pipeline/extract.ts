/**
 * Résumé text extraction for Cloudflare Workers.
 * PDF via unpdf; TXT direct; DOCX best-effort ZIP/XML; DOC/RTF best-effort or clear beta error.
 * Never log résumé body.
 */

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractError';
  }
}

function extOf(filename: string): string {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

export async function extractResumeText(
  bytes: ArrayBuffer,
  filename: string,
  contentType: string,
): Promise<string> {
  const ext = extOf(filename);
  const ct = (contentType || '').toLowerCase();

  if (ext === 'txt' || ct.startsWith('text/plain')) {
    return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes).trim();
  }

  if (ext === 'pdf' || ct === 'application/pdf') {
    return extractPdf(bytes);
  }

  if (ext === 'docx' || ct.includes('wordprocessingml')) {
    return extractDocx(bytes);
  }

  if (ext === 'rtf' || ct.includes('rtf')) {
    return extractRtf(bytes);
  }

  if (ext === 'doc' || ct === 'application/msword') {
    throw new ExtractError(
      'Legacy .doc Word files are not reliably supported in this Workers beta. Please re-upload as PDF or TXT.',
    );
  }

  throw new ExtractError(
    'Unsupported résumé format for this beta. Please upload PDF or TXT (DOCX/RTF best-effort).',
  );
}

async function extractPdf(bytes: ArrayBuffer): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    const out = (Array.isArray(text) ? text.join('\n') : String(text || '')).trim();
    if (!out) {
      throw new ExtractError('Could not extract text from PDF. Try a text-based PDF or TXT upload.');
    }
    return out;
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw new ExtractError(
      'PDF text extraction failed in this Workers environment. Please upload a text-based PDF or TXT file for the beta.',
    );
  }
}

async function extractDocx(bytes: ArrayBuffer): Promise<string> {
  try {
    const files = await unzipTextFiles(bytes);
    const docXml = files['word/document.xml'];
    if (!docXml) {
      throw new ExtractError('DOCX appears invalid (missing word/document.xml). Please upload PDF or TXT.');
    }
    const text = xmlToText(docXml);
    if (!text.trim()) {
      throw new ExtractError('Could not extract text from DOCX. Please upload PDF or TXT for the beta.');
    }
    return text.trim();
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw new ExtractError(
      'DOCX parsing failed in this Workers beta. Please re-upload as PDF or TXT.',
    );
  }
}

function extractRtf(bytes: ArrayBuffer): string {
  const raw = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes);
  // Best-effort strip of RTF control words — not a full RTF parser.
  let text = raw
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/\\[a-zA-Z]+-?\d* ?/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 40) {
    throw new ExtractError(
      'RTF extraction produced too little text for the beta. Please upload PDF or TXT instead.',
    );
  }
  return text;
}

function xmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** Minimal ZIP reader for DOCX (store + deflate via DecompressionStream). */
async function unzipTextFiles(buf: ArrayBuffer): Promise<Record<string, string>> {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const out: Record<string, string> = {};

  // Find End of Central Directory
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip');

  const totalEntries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  for (let n = 0; n < totalEntries; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLen);
    const name = new TextDecoder().decode(nameBytes);
    offset += 46 + nameLen + extraLen + commentLen;

    if (view.getUint32(localOffset, true) !== 0x04034b50) continue;
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const comp = bytes.slice(dataStart, dataStart + compSize);

    let data: Uint8Array;
    if (method === 0) {
      data = comp;
    } else if (method === 8) {
      data = await inflate(comp);
    } else {
      continue;
    }

    if (name.endsWith('.xml') || name.endsWith('.rels') || name.endsWith('.txt')) {
      out[name] = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(data);
    }
  }
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}
