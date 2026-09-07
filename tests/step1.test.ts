import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertNoContactDetails, assertSafeGeneratedPersistence, parseV2Intake } from '../src/lib/intake-v2.ts';
import { requireHumanPilot } from '../src/lib/pilot.ts';
import { handleIntake } from '../src/routes/intake.ts';
import { handleStatusApi } from '../src/routes/status.ts';
import { isArtifactDue, runRetentionPurge } from '../src/lib/retention.ts';
import { SqlD1 } from './support/d1.ts';

function formWithConsent() {
  const form = new FormData();
  form.set('college', 'Green River College');
  form.set('current_goal', 'Find a sustainable next job');
  form.set('work_location', 'Auburn, WA');
  form.set('hours_per_week', '10-20');
  form.set('usage_context', 'self');
  form.set('consent_acknowledged', 'true');
  form.set('consent_version', 'fixline-v2-step1');
  return form;
}

function environment(pilotMode: unknown = 'human') {
  const db = new SqlD1();
  const objects = new Map<string, unknown>();
  const sent: unknown[] = [];
  return {
    db, objects, sent,
    env: {
      DB: db,
      RESUME_BUCKET: {
        put: async (key: string, body: unknown) => { objects.set(key, body); },
        delete: async (key: string) => { objects.delete(key); },
      },
      GENERATE_QUEUE: { send: async (message: unknown) => { sent.push(message); } },
      RATE_LIMIT_SALT: 'synthetic-test-salt', PUBLIC_BASE_URL: 'https://fixline.test',
      PILOT_MODE: pilotMode,
    } as never,
  };
}

test('synthetic baseline E2E preserves legacy intake, D1, R2, Queue, and token status flow', async () => {
  const form = formWithConsent();
  form.delete('consent_acknowledged');
  form.delete('consent_version');
  form.set('resume', new File(['Experienced student with customer service and scheduling skills.'], 'Jane-Doe-555-1212.txt', { type: 'text/plain' }));
  const ctx = environment();
  const response = await handleIntake(new Request('https://fixline.test/api/intake', { method: 'POST', body: form }), ctx.env);
  assert.equal(response.status, 200);
  const redirect = new URL((await response.json() as { redirect_url: string }).redirect_url);
  const caseId = redirect.pathname.split('/').at(-1)!;
  assert.deepEqual(Object.keys(ctx.sent[0] as object).sort(), ['attemptNumber', 'caseId', 'reason']);
  assert.ok([...ctx.objects.keys()][0].endsWith('/resume.txt'));
  const stored = JSON.stringify(ctx.db.sqlite.prepare('SELECT * FROM cases JOIN v2_intake ON cases.id=v2_intake.case_id').all());
  assert.doesNotMatch(stored, /Jane-Doe-555-1212/);
  const status = await handleStatusApi(new Request(`https://fixline.test/api/status/${caseId}?t=${redirect.searchParams.get('t')}`), ctx.env, caseId);
  assert.equal(status.status, 200);
  assert.equal((await status.json() as { status: string }).status, 'QUEUED');
});

test('no-resume intake is human-only, persists guided-summary provenance, and does not enqueue', async () => {
  const form = formWithConsent();
  form.set('guided_summary', 'I have retail and peer mentoring experience and want a stable role.');
  const ctx = environment();
  const response = await handleIntake(new Request('https://fixline.test/api/intake', { method: 'POST', body: form }), ctx.env);
  assert.equal(response.status, 200);
  assert.equal(ctx.objects.size, 0);
  assert.equal(ctx.sent.length, 0);
  const storedCase = ctx.db.sqlite.prepare('SELECT state,processing_mode FROM v2_case').get() as { state: string; processing_mode: string };
  assert.equal(storedCase.state, 'HUMAN_REVIEW_REQUIRED');
  assert.equal(storedCase.processing_mode, 'HUMAN_PROCESSING');
  const summaryFact = ctx.db.sqlite.prepare("SELECT provenance,availability_status FROM v2_user_fact WHERE fact_name='guided_summary'").get() as { provenance: string; availability_status: string };
  assert.equal(summaryFact.provenance, 'DIRECT_USER');
  assert.equal(summaryFact.availability_status, 'KNOWN');
  assert.equal((ctx.db.sqlite.prepare('SELECT count(*) AS count FROM v2_resume_fact').get() as { count: number }).count, 0);
});

test('UNKNOWN, WITHHELD, omitted, legacy mapping, and system defaults remain distinct', () => {
  const form = formWithConsent();
  form.set('country', 'UNKNOWN');
  form.set('study_hours', 'WITHHELD');
  const { facts } = parseV2Intake(form, { resumeProvided: true, now: '2026-09-07T00:00:00.000Z', consentVersion: 'fixline-v2-step1' });
  assert.deepEqual(facts.find(f => f.name === 'country'), { name: 'country', value: 'UNKNOWN', availability: 'UNKNOWN', provenance: 'DIRECT_USER', sourceField: 'country' });
  assert.equal(facts.find(f => f.name === 'study_hours')?.availability, 'WITHHELD');
  assert.equal(facts.find(f => f.name === 'timezone')?.availability, 'OMITTED');
  assert.equal(facts.find(f => f.name === 'locality')?.provenance, 'LEGACY_MAPPING');
  assert.equal(facts.find(f => f.name === 'delivery_preferences')?.provenance, 'SYSTEM_DEFAULT');
});

test('consent must be affirmative and match the server-resolved active version', () => {
  const missing = formWithConsent(); missing.delete('consent_acknowledged');
  assert.throws(() => parseV2Intake(missing, { resumeProvided: false, now: '', consentVersion: 'fixline-v2-step1' }), /Affirmative consent/);
  const stale = formWithConsent(); stale.set('consent_version', 'old');
  assert.throws(() => parseV2Intake(stale, { resumeProvided: false, now: '', consentVersion: 'fixline-v2-step1' }), /stale or invalid/);
});

test('intake fails closed when the consent policy is inactive', async () => {
  const ctx = environment();
  ctx.db.sqlite.exec("UPDATE policy_version SET active=0 WHERE policy_name='intake_consent'");
  const response = await handleIntake(new Request('https://fixline.test/api/intake', { method: 'POST', body: formWithConsent() }), ctx.env);
  assert.equal(response.status, 503);
});

test('PII and copied raw-resume passages fail closed before D1 persistence', () => {
  for (const pii of ['me@example.com', '+44 20 7946 0958', '123 Main Street', 'linkedin.com/in/person']) {
    assert.throws(() => assertNoContactDetails(pii));
  }
  const resume = 'one two three four five six seven eight nine ten eleven twelve thirteen';
  assert.throws(() => assertSafeGeneratedPersistence(resume, `Summary: ${resume}`), /reproduced raw/);
});

test('all queue enqueue sites use the identifier-only contract', () => {
  const files = ['src/routes/intake.ts', 'src/routes/review.ts', 'src/pipeline/generate.ts'];
  let enqueueSites = 0;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/GENERATE_QUEUE\.send\(\{([\s\S]*?)\}\)/g)) {
      enqueueSites += 1;
      const keys = [...match[1].matchAll(/\b(caseId|attemptNumber|reason|resumeText|guided_summary|email|phone)\b\s*[:,]/g)].map(item => item[1]);
      assert.ok(keys.every(key => ['caseId', 'attemptNumber', 'reason'].includes(key)), `${file} contains prohibited queue data`);
    }
  }
  assert.equal(enqueueSites, 4);
});

test('human processing fails closed when PILOT_MODE is missing or invalid', async () => {
  assert.doesNotThrow(() => requireHumanPilot(environment('human').env));
  const missing = environment();
  delete (missing.env as { PILOT_MODE?: unknown }).PILOT_MODE;
  assert.throws(() => requireHumanPilot(missing.env), /HUMAN_PROCESSING/);
  assert.throws(() => requireHumanPilot(environment('auto').env), /HUMAN_PROCESSING/);
  const response = await handleIntake(new Request('https://fixline.test/api/intake', { method: 'POST', body: formWithConsent() }), missing.env);
  assert.equal(response.status, 503);
});

test('retention binds current time directly and reconciles FAILED deletion rows', async () => {
  const ctx = environment();
  const now = new Date().toISOString();
  ctx.db.sqlite.prepare("INSERT INTO cases (id,college,current_goal,work_location,hours_per_week,usage_context,status,access_token_hash,resume_r2_key,attempt_count,created_at,updated_at) VALUES ('case-1','Green River College','goal','Auburn','10-20','self','QUEUED','hash','temp/case-1/resume.txt',0,?,?)").run(now, now);
  ctx.db.sqlite.prepare("INSERT INTO v2_case VALUES ('case-1','case-1','2.0','QUEUED','HUMAN_PROCESSING',?,?)").run(now, now);
  ctx.db.sqlite.prepare("INSERT INTO artifact_metadata (id,case_id,object_key,artifact_type,content_type,byte_size,storage_class,stored_at,delete_by) VALUES ('artifact-1','case-1','temp/case-1/resume.txt','RAW_RESUME','text/plain',3,'ACTIVE_TEMPORARY',?,?)").run(now, now);
  ctx.db.sqlite.prepare("INSERT INTO v2_deletion_index (artifact_id,case_id,object_key,delete_by,status) VALUES ('artifact-1','case-1','temp/case-1/resume.txt',?,'FAILED')").run(now);
  ctx.objects.set('temp/case-1/resume.txt', 'raw');
  const before = Date.now();
  assert.deepEqual(await runRetentionPurge(ctx.env), { scanned: 1, deleted: 1 });
  const deleted = ctx.db.sqlite.prepare("SELECT status,deleted_at FROM v2_deletion_index WHERE artifact_id='artifact-1'").get() as { status: string; deleted_at: string };
  assert.equal(deleted.status, 'DELETED');
  assert.ok(Math.abs(Date.parse(deleted.deleted_at) - before) < 5000);
  assert.equal(ctx.objects.size, 0);
});

test('raw-artifact processing gate blocks missing, invalid, due, and overdue deadlines', () => {
  const now = Date.parse('2026-09-07T23:00:00.000Z');
  assert.equal(isArtifactDue(null, now), true);
  assert.equal(isArtifactDue('invalid', now), true);
  assert.equal(isArtifactDue('2026-09-07T23:00:00.000Z', now), true);
  assert.equal(isArtifactDue('2026-09-07T22:59:59.999Z', now), true);
  assert.equal(isArtifactDue('2026-09-07T23:00:00.001Z', now), false);
});
