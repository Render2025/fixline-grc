import type { HoursPerWeek, UsageContext, V2Fact, V2IntakeFields } from '../types';

const HOURS: HoursPerWeek[] = ['lt5', '5-10', '10-20', '20plus'];
const USAGE: UsageContext[] = ['self', 'advisor'];
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{4}\b/;
const SOCIAL = /(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com\/in|facebook\.com|instagram\.com|t\.me)\//i;
const ADDRESS = /\b\d{1,6}\s+[\p{L}0-9.'-]+(?:\s+[\p{L}0-9.'-]+){0,4}\s+(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd)\b/iu;

export class IntakeValidationError extends Error {}
export class PiiPersistenceError extends Error {}

export function assertNoContactDetails(value: string): string {
  if (EMAIL.test(value) || PHONE.test(value) || SOCIAL.test(value) || ADDRESS.test(value)) {
    throw new PiiPersistenceError('Contact details cannot be stored with this intake. Remove them and try again.');
  }
  return value.trim();
}

function fact(
  form: FormData,
  name: string,
  options: { fallbackField?: string; systemDefault?: string } = {},
): V2Fact {
  const direct = form.has(name);
  const sourceField = direct ? name : options.fallbackField && form.has(options.fallbackField) ? options.fallbackField : null;
  const raw = sourceField ? String(form.get(sourceField) || '').trim() : '';
  if (raw === 'UNKNOWN' || raw === 'WITHHELD') {
    return { name, value: raw, availability: raw, provenance: sourceField === name ? 'DIRECT_USER' : 'LEGACY_MAPPING', sourceField };
  }
  if (raw) {
    return { name, value: assertNoContactDetails(raw), availability: 'KNOWN', provenance: sourceField === name ? 'DIRECT_USER' : 'LEGACY_MAPPING', sourceField };
  }
  if (options.systemDefault) {
    return { name, value: options.systemDefault, availability: 'KNOWN', provenance: 'SYSTEM_DEFAULT', sourceField: null };
  }
  return { name, value: null, availability: 'OMITTED', provenance: 'NORMALIZED', sourceField };
}

export function parseV2Intake(
  form: FormData,
  options: { resumeProvided: boolean; now: string; consentVersion: string; allowLegacySubmitConsent?: boolean },
): { intake: V2IntakeFields; facts: V2Fact[] } {
  const explicitlyAcknowledged = String(form.get('consent_acknowledged') || '') === 'true';
  if (!explicitlyAcknowledged && !options.allowLegacySubmitConsent) {
    throw new IntakeValidationError('Affirmative consent is required.');
  }
  if (explicitlyAcknowledged && String(form.get('consent_version') || '') !== options.consentVersion) {
    throw new IntakeValidationError('The consent version is stale or invalid. Reload and try again.');
  }

  const currentGoal = fact(form, 'current_goal');
  const locality = fact(form, 'locality', { fallbackField: 'work_location' });
  const workHours = fact(form, 'work_hours', { fallbackField: 'hours_per_week' });
  const usage = fact(form, 'usage_context');
  const guided = fact(form, 'guided_summary');
  const facts = [
    currentGoal, fact(form, 'country'), locality, fact(form, 'timezone'), workHours,
    fact(form, 'study_hours'), fact(form, 'income_urgency'), fact(form, 'income_floor'),
    fact(form, 'mobility'), fact(form, 'transportation'), fact(form, 'work_authorization'),
    fact(form, 'education_status'), fact(form, 'constraints'), usage,
    fact(form, 'delivery_preferences', { systemDefault: 'STATUS_PAGE_DOWNLOAD' }),
    fact(form, 'language'), fact(form, 'accessibility'), guided,
  ];

  if (!currentGoal.value || currentGoal.availability !== 'KNOWN' || currentGoal.value.length < 5) {
    throw new IntakeValidationError('Please describe what you are hoping to figure out.');
  }
  if (!usage.value || !USAGE.includes(usage.value as UsageContext)) throw new IntakeValidationError('Invalid usage_context value.');
  if (workHours.value && workHours.availability === 'KNOWN' && !HOURS.includes(workHours.value as HoursPerWeek)) {
    throw new IntakeValidationError('Invalid work-hours value.');
  }
  const studyHours = facts.find((item) => item.name === 'study_hours')!;
  if (studyHours.value && studyHours.availability === 'KNOWN' && !HOURS.includes(studyHours.value as HoursPerWeek)) {
    throw new IntakeValidationError('Invalid study-hours value.');
  }
  if (!options.resumeProvided && (!guided.value || guided.availability !== 'KNOWN' || guided.value.length < 40)) {
    throw new IntakeValidationError('Without a résumé, provide a guided summary of at least 40 characters.');
  }

  const byName = Object.fromEntries(facts.map((item) => [item.name, item.value]));
  return {
    intake: {
      current_goal: currentGoal.value, country: byName.country, locality: byName.locality,
      timezone: byName.timezone, work_hours: byName.work_hours, study_hours: byName.study_hours,
      income_urgency: byName.income_urgency, income_floor: byName.income_floor,
      mobility: byName.mobility, transportation: byName.transportation,
      work_authorization: byName.work_authorization, education_status: byName.education_status,
      constraints: byName.constraints, usage_context: usage.value as UsageContext,
      delivery_preferences: byName.delivery_preferences!, language: byName.language,
      accessibility: byName.accessibility, guided_summary: byName.guided_summary,
      consent_version: options.consentVersion, consented_at: options.now,
      consent_acknowledged: true, resume_provided: options.resumeProvided,
    },
    facts,
  };
}

export function hasCopiedResumePassage(resumeText: string, output: string): boolean {
  const words = resumeText.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const normalizedOutput = (output.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(' ');
  for (let index = 0; index + 12 <= words.length; index += 1) {
    if (normalizedOutput.includes(words.slice(index, index + 12).join(' '))) return true;
  }
  return false;
}

export function assertSafeGeneratedPersistence(resumeText: string, output: string): void {
  assertNoContactDetails(output);
  if (hasCopiedResumePassage(resumeText, output)) {
    throw new PiiPersistenceError('Generated output reproduced raw résumé content.');
  }
}
