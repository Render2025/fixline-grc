import type { Env, GenerateQueueMessage } from '../types';

const CONTACT = /(?:\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|(?:\+?\d[\d .()-]{7,}\d)|\b\d{1,6}\s+[\w .'-]+\s(?:street|st\.|avenue|ave\.|road|rd\.)\b)/i;

export function assertHumanMode(env: Env): void {
  if (env.PILOT_MODE !== 'human') throw new Error('PILOT_MODE must be explicitly set to human');
}

export function assertSafeText(value: string | null | undefined, resumeText?: string): void {
  if (!value) return;
  if (CONTACT.test(value)) throw new Error('PII persistence rejected');
  if (resumeText) {
    const passages = resumeText.replace(/\s+/g, ' ').match(/.{80,160}/g) || [];
    const normalized = value.replace(/\s+/g, ' ');
    if (passages.some((p) => normalized.includes(p))) throw new Error('Copied resume passage rejected');
  }
}

export async function enqueueIdentifierOnly(env: Env, message: GenerateQueueMessage): Promise<void> {
  assertHumanMode(env);
  if (!message.caseId || Object.keys(message).some((k) => !['caseId','attemptNumber','reason'].includes(k))) {
    throw new Error('Queue payload must be identifier-only');
  }
  await env.GENERATE_QUEUE.send(message);
}
