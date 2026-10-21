import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

process.env.ROUTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'));
const { createGateway } = await import('../plugin/gateway/gateway.mjs');
const { dataDir } = await import('../plugin/scripts/lib/paths.mjs');

const policy = {
  tiers: { fast: { model: 'sonnet', effort: 'low' }, deep: { model: 'opus', effort: 'high' } },
  kinds: { chat: 'fast', continue: null },
};
const classify = (t) => ({ kind: /keep going/.test(t) ? 'continue' : 'chat', confidence: 1, reasons: [] });

let seen = [], release, upstream, up, gwServers = [], rejectSonnet = false;
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

before(async () => {
  up = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    seen.push({ headers: req.headers, url: req.url, body });
    if (rejectSonnet && body.includes('sonnet')) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"nope"}'); return; }
    if (req.url === '/stream' || body.includes('"stream":true')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-custom': 'yes' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n');
      await new Promise((r) => (release = r));
      res.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":50}}\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }));
  });
  upstream = `http://127.0.0.1:${await listen(up)}`;
});
after(() => { up.close(); gwServers.forEach((s) => s.close()); });

async function gw(opts = {}) {
  const s = createGateway({ classify, policy, upstream, ...opts });
  gwServers.push(s);
  return `http://127.0.0.1:${await listen(s)}`;
}
const post = (base, body, headers = {}, p = '/v1/messages') =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const lastBody = () => JSON.parse(seen.at(-1).body);
const sys = (s) => [{ type: 'text', text: s, cache_control: { type: 'ephemeral' } }];
const MARK = fs.readFileSync(new URL('../plugin/instructions/router.md', import.meta.url), 'utf8').split('\n')[0];
// Main-session first message: SessionStart marker in a system-reminder block, then the typed prompt.
const main = (t) => [{ type: 'text', text: `<system-reminder>\nSessionStart:startup hook success: ${MARK}\n- more\n</system-reminder>` }, { type: 'text', text: t }];
const turn1 = (s, t = 'hello') => ({ model: 'claude-opus-5-5', system: sys(s), output_config: { effort: 'high' }, messages: [{ role: 'user', content: main(t) }] });
const later = (b, t = 'next') => ({ ...b, messages: [...b.messages, { role: 'assistant', content: 'ok' }, { role: 'user', content: t }] });
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const jsonl = () => fs.readFileSync(path.join(dataDir(), 'gateway.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('rewrites first request, pins later turns, keeps headers and cache_control', async () => {
  const base = await gw();
  await post(base, turn1('conv A'), { 'anthropic-beta': 'x-1,y-2', 'anthropic-version': '2023-06-01', 'x-api-key': 'k' });
  const h = seen.at(-1).headers;
  assert.equal(h['anthropic-beta'], 'x-1,y-2');
  assert.equal(h['anthropic-version'], '2023-06-01');
  assert.equal(h['x-api-key'], 'k');
  assert.equal(h.host, new URL(upstream).host);
  let b = lastBody();
  assert.equal(b.model, 'claude-sonnet-5-5');
  assert.equal(b.output_config.effort, 'low');
  assert.deepEqual(b.system[0].cache_control, { type: 'ephemeral' });

  // later turn: asks for opus again, and a "continue"-looking prompt cannot change the pin
  await post(base, later(turn1('conv A'), 'keep going'));
  assert.equal(lastBody().model, 'claude-sonnet-5-5');
  await settle();
  assert.ok(fs.existsSync(path.join(dataDir(), 'gateway-pins.json')));
});

test('continue kind keeps requested model; later turns stay on it', async () => {
  const base = await gw();
  await post(base, turn1('conv B', 'keep going'));
  assert.equal(lastBody().model, 'claude-opus-5-5');
  await post(base, later(turn1('conv B', 'keep going'), 'more'));
  assert.equal(lastBody().model, 'claude-opus-5-5');
});

test('mid-conversation (no pin) is never rewritten; haiku/sonnet/count_tokens untouched', async () => {
  const base = await gw();
  const mid = later(turn1('conv C'), 'c');
  await post(base, mid);
  assert.equal(lastBody().model, 'claude-opus-5-5');
  await post(base, { ...turn1('conv D'), model: 'claude-haiku-5-5' });
  assert.equal(lastBody().model, 'claude-haiku-5-5');
  await post(base, { ...turn1('conv E'), model: 'claude-sonnet-5-5' });
  assert.equal(lastBody().model, 'claude-sonnet-5-5');
  await post(base, turn1('conv F'), {}, '/v1/messages/count_tokens');
  assert.equal(lastBody().model, 'claude-opus-5-5');
});

test('never upgrades', async () => {
  const base = await gw({ policy: { tiers: { deep: { model: 'opus', effort: 'high' } }, kinds: { chat: 'deep' } } });
  await post(base, { ...turn1('conv G'), model: 'claude-sonnet-5-5' });
  assert.equal(lastBody().model, 'claude-sonnet-5-5');
});

test('dry-run forwards unchanged but logs the decision', async () => {
  const base = await gw({ dryRun: true });
  const r = await post(base, turn1('conv H'));
  await r.text();
  assert.equal(lastBody().model, 'claude-opus-5-5');
  assert.equal(lastBody().output_config.effort, 'high');
  const l = jsonl().filter((x) => x.dryRun).at(-1);
  assert.equal(l.requested, 'claude-opus-5-5');
  assert.equal(l.sent, 'claude-opus-5-5');
  assert.equal(l.would, 'claude-sonnet-5-5');
});

test('streams unbuffered and logs usage + cost', async () => {
  const base = await gw();
  const r = await post(base, { ...turn1('conv S'), stream: true });
  assert.equal(r.headers.get('x-custom'), 'yes');
  const reader = r.body.getReader();
  const first = await reader.read(); // upstream has not ended yet
  assert.match(new TextDecoder().decode(first.value), /message_start/);
  release();
  while (!(await reader.read()).done);
  await new Promise((r) => setTimeout(r, 50));
  const l = jsonl().filter((x) => x.usage?.input_tokens === 100).at(-1);
  assert.equal(l.usage.output_tokens, 50);
  assert.ok(l.cost > 0);
});

test('logs usage for messages to gateway.jsonl', async () => {
  const base = await gw();
  const r = await post(base, turn1('conv I'));
  await r.text();
  await new Promise((r) => setTimeout(r, 50));
  const l = jsonl().filter((x) => x.requested && !x.dryRun).at(-1);
  assert.equal(l.sent, 'claude-sonnet-5-5');
  assert.equal(l.kind, 'chat');
  assert.equal(l.usage.output_tokens, 5);
  assert.ok(l.cost > 0);
  assert.equal(l.key8.length, 8);
});

test('client aborting mid-body does not crash the gateway', async () => {
  const base = await gw();
  const port = Number(new URL(base).port);
  const s = net.connect(port, '127.0.0.1');
  await new Promise((r) => s.on('connect', r));
  s.write('POST /v1/messages HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n{"model":');
  await settle(50);
  s.destroy();
  await settle(150);
  const r = await post(base, turn1('conv abort'));
  assert.equal(r.status, 200);
  await r.text();
});

test('dry-run pins never leak into a later real run', async () => {
  const d = await gw({ dryRun: true });
  await (await post(d, turn1('conv DR'))).text();
  assert.equal(lastBody().model, 'claude-opus-5-5');
  await settle();
  const real = await gw(); // reads the pins file the dry-run wrote
  await (await post(real, later(turn1('conv DR')))).text();
  assert.equal(lastBody().model, 'claude-opus-5-5');
});

test('no marker (subagent) passes through, logged as no-marker', async () => {
  const base = await gw();
  const sub1 = { ...turn1('conv SUB'), messages: [{ role: 'user', content: 'find the root cause of the race' }] };
  await (await post(base, sub1)).text();
  assert.equal(lastBody().model, 'claude-opus-5-5');
  await (await post(base, later(sub1))).text();
  assert.equal(lastBody().model, 'claude-opus-5-5');
  await settle(50);
  assert.ok(jsonl().some((x) => x.reason === 'no-marker'));
});

test('classifier sees only the typed prompt, not system-reminders', async () => {
  const got = [];
  const base = await gw({ classify: (t) => { got.push(t); return { kind: 'chat' }; } });
  const b = turn1('conv SR');
  b.messages[0].content = [
    { type: 'text', text: '<system-reminder>\nCLAUDE.md: never deploy to prod\n</system-reminder>' },
    { type: 'text', text: `<system-reminder>\nSessionStart:startup hook success: ${MARK}\n</system-reminder>` },
    { type: 'text', text: 'the login page randomly logs users out' },
  ];
  await (await post(base, b)).text();
  assert.deepEqual(got, ['the login page randomly logs users out']);
  assert.equal(lastBody().model, 'claude-sonnet-5-5');
});

test('4xx on a rewritten first request: resent unchanged and re-pinned to requested', async () => {
  const base = await gw();
  rejectSonnet = true;
  try {
    const n = seen.length;
    const r = await post(base, turn1('conv 4XX'));
    assert.equal(r.status, 200);
    await r.text();
    assert.equal(seen.length - n, 2);
    assert.equal(JSON.parse(seen[n].body).model, 'claude-sonnet-5-5');
    assert.equal(lastBody().model, 'claude-opus-5-5');
  } finally { rejectSonnet = false; }
  await (await post(base, later(turn1('conv 4XX')))).text();
  assert.equal(lastBody().model, 'claude-opus-5-5');
  await settle(50);
  assert.ok(jsonl().some((x) => x.reason === 'fallback-4xx'));
});

test('user model switch re-pins to the new model and is not rewritten', async () => {
  const base = await gw();
  await (await post(base, turn1('conv SW'))).text();
  assert.equal(lastBody().model, 'claude-sonnet-5-5');
  const sw = later({ ...turn1('conv SW'), model: 'claude-opus-4-1' });
  await (await post(base, sw)).text();
  assert.equal(lastBody().model, 'claude-opus-4-1');
  await (await post(base, later(sw, 'again'))).text();
  assert.equal(lastBody().model, 'claude-opus-4-1');
});

test('key change mid-conversation: user_id pin applies; otherwise unpinned-midstream', async () => {
  const base = await gw();
  const t1 = { ...turn1('conv UID'), metadata: { user_id: 'sess-123' } };
  await (await post(base, t1)).text();
  assert.equal(lastBody().model, 'claude-sonnet-5-5');
  // compaction: first user message is now a summary, same system and user_id
  const compacted = { ...t1, messages: [{ role: 'user', content: 'This session is being continued...' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'go on' }] };
  await (await post(base, compacted)).text();
  assert.equal(lastBody().model, 'claude-sonnet-5-5');
  // different system prompt (e.g. a subagent sharing the session id): left alone
  await (await post(base, { ...compacted, system: sys('other agent') })).text();
  assert.equal(lastBody().model, 'claude-opus-5-5');
  // no user_id at all
  await (await post(base, { ...compacted, metadata: undefined, system: sys('conv UID2') })).text();
  assert.equal(lastBody().model, 'claude-opus-5-5');
  await settle(50);
  assert.ok(jsonl().some((x) => x.reason === 'unpinned-midstream'));
});

const plain = (t, brief) => ({ model: 'claude-opus-5-5', system: sys('sub'), messages: [{ role: 'user', content: [{ type: 'text', text: brief }, { type: 'text', text: t }] }] });

test('real then dry-run: an existing cheaper pin is still applied', async () => {
  const real = await gw();
  await post(real, turn1('conv R1'));
  assert.equal(lastBody().model, 'claude-sonnet-5-5');
  await settle();
  const dry = await gw({ dryRun: true });
  await post(dry, later(turn1('conv R1')));
  assert.equal(lastBody().model, 'claude-sonnet-5-5');
});

test('marker quoted in plain text is not rewritten and never writes a uid pin', async () => {
  const base = await gw();
  const uid = { user_id: 'sess-spoof' };
  await post(base, { ...plain('hi', `quote: ${MARK}`), metadata: uid });
  assert.equal(lastBody().model, 'claude-opus-5-5');
  // a reminder without SessionStart does not count either
  await post(base, { ...plain('hi', `<system-reminder>${MARK}</system-reminder>`), metadata: uid });
  assert.equal(lastBody().model, 'claude-opus-5-5');
  await settle();
  const pins = JSON.parse(fs.readFileSync(path.join(dataDir(), 'gateway-pins.json'), 'utf8'));
  assert.equal(Object.keys(pins).filter((k) => k.startsWith('u:sess-spoof')).length, 0);
});

test('unmarked model-switch does not overwrite the uid pin', async () => {
  const base = await gw();
  const uid = { user_id: 'sess-keep' };
  await post(base, { ...turn1('conv U'), metadata: uid });
  assert.equal(lastBody().model, 'claude-sonnet-5-5');
  await post(base, { ...plain('x', 'brief'), system: sys('conv U'), model: 'claude-fable-5-5', metadata: uid });
  await settle();
  const pins = JSON.parse(fs.readFileSync(path.join(dataDir(), 'gateway-pins.json'), 'utf8'));
  assert.equal(pins['u:sess-keep'].model, 'claude-sonnet-5-5');
});

test('legacy pin without requested is not flipped and gets backfilled', async () => {
  const b = turn1('conv LEG');
  const file = path.join(dataDir(), 'gateway-pins.json');
  const { conversationKey } = await import('../plugin/gateway/gateway.mjs');
  const pins = JSON.parse(fs.readFileSync(file, 'utf8'));
  pins[conversationKey(b)] = { model: 'claude-sonnet-5-5', effort: 'low', kind: 'chat', sys: 'x' };
  fs.writeFileSync(file, JSON.stringify(pins));
  const base = await gw();
  await post(base, later(b));
  assert.equal(lastBody().model, 'claude-sonnet-5-5');
  await settle();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[conversationKey(b)].requested, 'claude-opus-5-5');
});
