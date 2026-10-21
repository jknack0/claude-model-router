import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ROUTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cls-'));
const { classify, loadPolicy, tierFor, isCorrection, TIERS } = await import('../plugin/scripts/lib/classify.mjs');

const cases = [
  ['ok', 'continue'],
  ['2', 'continue'],
  ['do it', 'continue'],
  ['Explain how the session ingest dedupes messages', 'question'],
  ['find where the retry logic lives', 'recon'],
  ['rename foo to bar in utils', 'small-edit'],
  ['add a new endpoint for exporting reports', 'feature'],
  ['the build is failing with a type error', 'debug'],
  ['how should we architect the cache layer', 'design'],
  ['review this diff for security issues', 'review'],
  ['deploy the api to staging', 'ops'],
  ['the weather is nice today friends', 'chat'],
];
for (const [prompt, kind] of cases) {
  test(`classify: ${prompt}`, () => assert.equal(classify(prompt).kind, kind));
}

test('stack trace and big code blocks are debug', () => {
  assert.equal(classify('look\n  at foo (/a/b.js:10:5)\n  at bar (/a/c.js:2:1)').kind, 'debug');
  const big = '```\n' + 'x\n'.repeat(40) + '```\nthoughts?';
  assert.equal(classify(big).kind, 'debug');
});

test('tier mapping, long prompt bumps up, quick/just lowers, clamped', () => {
  const p = loadPolicy();
  assert.equal(tierFor(classify('add a new endpoint for exports'), p), 'standard');
  assert.equal(tierFor(classify('add a new endpoint for exports. ' + 'x '.repeat(800)), p), 'deep');
  assert.equal(tierFor(classify('just add a new endpoint for exports'), p), 'fast');
  assert.equal(tierFor(classify('explain this to me, just briefly'), p), 'fast');
  assert.equal(tierFor(classify('ok'), p), null);
  assert.equal(tierFor(classify('the build is failing ' + 'x '.repeat(800)), p), 'deep');
});

test('policy is seeded and the user copy wins', () => {
  const file = path.join(process.env.ROUTER_DATA_DIR, 'policy.json');
  assert.ok(fs.existsSync(file));
  const mod = JSON.parse(fs.readFileSync(file, 'utf8'));
  mod.kinds.question = 'deep';
  fs.writeFileSync(file, JSON.stringify(mod));
  assert.equal(tierFor(classify('explain this module'), loadPolicy()), 'deep');
});

const probes = [
  ['Why does the payment webhook double-charge customers under load?', 'deep'],
  ['Find out why the integration tests are flaky on CI', 'deep'],
  ['Where is the memory leak in the worker coming from?', 'deep'],
  ['look at the checkout page, the totals are wrong after applying a coupon', 'deep'],
  ['Is it safe to drop the users_old table in prod?', 'deep'],
  ['How does the scheduler avoid running the same job twice ... is there a race?', 'deep'],
  ['What is the best way to restructure the data layer for multi-tenancy?', 'deep'],
  ['change the auth flow to use OAuth PKCE across all services', 'standard'],
];
for (const [prompt, min] of probes) {
  test(`tier at least ${min}: ${prompt}`, () => {
    const t = tierFor(classify(prompt), loadPolicy());
    assert.ok(TIERS.indexOf(t) >= TIERS.indexOf(min), `${prompt} -> ${t}`);
  });
}

test('long change-to is not a small edit; short one is', () => {
  const long = 'change the auth flow to use OAuth PKCE instead of server sessions for every service we run today';
  assert.notEqual(classify(long).kind, 'small-edit');
  assert.equal(classify('change the port to 8080').kind, 'small-edit');
});

const DEFAULT = { kinds: { question: 'fast', recon: 'fast', feature: 'standard', 'small-edit': 'standard' } };
test('question floors: long question standard, risky question deep, short plain question fast', () => {
  const p = DEFAULT;
  assert.equal(tierFor(classify('explain this module'), p), 'fast');
  assert.equal(tierFor(classify('explain ' + 'the module '.repeat(13)), p), 'standard');
  assert.equal(tierFor(classify('explain the billing module'), p), 'deep');
  assert.equal(tierFor(classify('find where the payment code lives'), p), 'standard');
});

test('just/quick only lowers when it is the first word', () => {
  const p = DEFAULT;
  assert.equal(tierFor(classify('add a new endpoint, just for exports'), p), 'standard');
  assert.equal(tierFor(classify('Just add a new endpoint for exports'), p), 'fast');
});

test('tierFor falls back to standard for an unknown tier name', () => {
  assert.equal(tierFor({ kind: 'x', bump: 0 }, { kinds: { x: 'bogus' } }), 'standard');
});

test('isCorrection', () => {
  assert.ok(isCorrection('no, that is wrong'));
  assert.ok(isCorrection('still broken'));
  assert.ok(!isCorrection('add a new endpoint for exports'));
});
