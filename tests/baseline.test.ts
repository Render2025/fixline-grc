import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { json, notFound } from '../src/lib/http.ts';

test('synthetic baseline freezes health/not-found responses and public route set', async () => {
  const health = json({ ok: true, service: 'fixline-grc' });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: 'fixline-grc' });
  const missing = notFound();
  assert.equal(missing.status, 404);
  const source = readFileSync('src/index.ts', 'utf8');
  for (const marker of ["pathname === '/api/intake'", 'handleStatusApi', 'handleDownload', 'handleStatusPage', 'handleReviewList', "pathname === '/health'"]) {
    assert.ok(source.includes(marker), `missing frozen route marker ${marker}`);
  }
});
