import type { Env } from '../types';

// Frozen prompts — imported as Text modules (wrangler [[rules]] type=Text)
import generatorPrompt from '../prompts/generator-v1.0.md';
import qcPrompt from '../prompts/qc-auditor-v1.0.md';

const XAI_RESPONSES_URL = 'https://api.x.ai/v1/responses';

export interface XaiCallResult {
  text: string;
  raw: unknown;
}

/** Call A: generator with web_search. System prompt = frozen generator file EXACTLY. */
export async function callGenerator(
  env: Env,
  userContent: string,
): Promise<XaiCallResult> {
  return callResponses(env, {
    model: env.XAI_MODEL_GENERATE || 'grok-4.6',
    system: String(generatorPrompt),
    user: userContent,
    tools: [{ type: 'web_search' }],
  });
}

/** Call B: QC auditor, NO web_search. System prompt = frozen QC file EXACTLY. */
export async function callQcAuditor(
  env: Env,
  userContent: string,
): Promise<XaiCallResult> {
  return callResponses(env, {
    model: env.XAI_MODEL_QC || 'grok-4.6',
    system: String(qcPrompt),
    user: userContent,
    tools: undefined,
  });
}

async function callResponses(
  env: Env,
  opts: {
    model: string;
    system: string;
    user: string;
    tools?: Array<{ type: string }>;
  },
): Promise<XaiCallResult> {
  if (!env.XAI_API_KEY) {
    throw new Error('XAI_API_KEY secret is not configured');
  }

  const body: Record<string, unknown> = {
    model: opts.model,
    input: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
  }

  const res = await fetch(XAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.XAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const raw = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      typeof raw === 'object' && raw && 'error' in (raw as object)
        ? JSON.stringify((raw as any).error)
        : `xAI HTTP ${res.status}`;
    throw new Error(`xAI responses error: ${msg}`);
  }

  return { text: extractOutputText(raw), raw };
}

/** Best-effort extraction across Responses API shapes. */
export function extractOutputText(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return String(raw ?? '');
  const r = raw as any;
  if (typeof r.output_text === 'string' && r.output_text.trim()) return r.output_text;

  if (Array.isArray(r.output)) {
    const parts: string[] = [];
    for (const item of r.output) {
      if (!item) continue;
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c?.text === 'string') parts.push(c.text);
          else if (c?.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
        }
      }
      if (typeof item.text === 'string') parts.push(item.text);
    }
    if (parts.length) return parts.join('\n\n');
  }

  if (Array.isArray(r.choices) && r.choices[0]?.message?.content) {
    return String(r.choices[0].message.content);
  }

  return JSON.stringify(raw);
}

export function buildGeneratorUserMessage(args: {
  intake: Record<string, unknown>;
  resumeText: string;
  priorFeedback?: string | null;
}): string {
  const parts = [
    'INTAKE JSON:',
    JSON.stringify(args.intake, null, 2),
    '',
    'RESUME TEXT:',
    args.resumeText,
    '',
    'INSTRUCTION: Only live-verify load-bearing claims (Best First Move, alt #1, alt #2, critical eligibility, critical training/cert). Include a Research Evidence Log as a JSON array of evidence objects with fields claim_id, claim, source_title, source_url, checked_at, supports_section, status (VERIFIED|UNVERIFIED), load_bearing (boolean).',
  ];
  if (args.priorFeedback) {
    parts.push('', 'PRIOR QC / GATE FEEDBACK TO ADDRESS:', args.priorFeedback);
  }
  return parts.join('\n');
}

export function buildQcUserMessage(args: {
  resumeText: string;
  intake: Record<string, unknown>;
  draft: string;
  evidenceLog: unknown;
}): string {
  return [
    'RESUME TEXT:',
    args.resumeText,
    '',
    'INTAKE JSON:',
    JSON.stringify(args.intake, null, 2),
    '',
    'DRAFT REPORT:',
    args.draft,
    '',
    'RESEARCH EVIDENCE LOG JSON:',
    JSON.stringify(args.evidenceLog, null, 2),
  ].join('\n');
}
