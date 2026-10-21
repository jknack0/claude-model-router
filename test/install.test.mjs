import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const plugin = path.join(repo, 'plugin');
const run = path.join(plugin, 'bin/run');
const installSh = path.join(repo, 'install.sh');
const nodeDir = path.dirname(process.execPath);
const mk = (p = 'router-inst-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const read = (f) => fs.readFileSync(f, 'utf8');
const SYS = '/usr/bin:/bin';

// ---------- bin/run ----------
function fakeNode(file, version, body = 'echo "fake-node ran: $*"') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\n${body}\n`, { mode: 0o755 });
}
// A HOME with spaces, an empty data dir, and a PATH without any node unless given.
function env(home, extra = {}) {
  const data = path.join(home, 'data');
  return { PATH: SYS, HOME: home, ROUTER_NO_SYSTEM_NODE: '1', ROUTER_DATA_DIR: data, CLAUDE_PLUGIN_ROOT: plugin, ...extra };
}
const runLauncher = (e, script = 'x.mjs', input = '') => spawnSync('/bin/sh', [run, script], { env: e, input, encoding: 'utf8' });

test('bin/run finds node on PATH and passes stdin through', () => {
  const home = mk('router home ');
  fs.writeFileSync(path.join(home, 'echo.mjs'), '');
  const scripts = path.join(home, 'root/scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'cat.mjs'), "process.stdout.write((await import('node:fs')).readFileSync(0,'utf8').toUpperCase())");
  const r = runLauncher(env(home, { PATH: `${nodeDir}:${SYS}`, CLAUDE_PLUGIN_ROOT: path.join(home, 'root') }), 'cat.mjs', 'hello stdin');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'HELLO STDIN');
  assert.equal(read(path.join(home, 'data/node-path')).trim(), path.join(nodeDir, 'node'));
});

test('bin/run finds the newest node 22+ in a fake nvm dir under a HOME with spaces', () => {
  const home = mk('router home ');
  const nvm = path.join(home, '.nvm/versions/node');
  fakeNode(path.join(nvm, 'v18.0.0/bin/node'), 'v18.0.0');
  fakeNode(path.join(nvm, 'v22.3.0/bin/node'), 'v22.3.0', 'echo old');
  fakeNode(path.join(nvm, 'v22.10.1/bin/node'), 'v22.10.1', 'echo "new $*"');
  const r = runLauncher(env(home), 'a.mjs');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `new ${plugin}/scripts/a.mjs`);
  assert.equal(r.stderr, '');
  // cached, and the cache is re-validated: removing the binary falls back to the search
  assert.equal(read(path.join(home, 'data/node-path')).trim(), path.join(nvm, 'v22.10.1/bin/node'));
  fs.rmSync(path.join(nvm, 'v22.10.1'), { recursive: true });
  assert.equal(runLauncher(env(home), 'a.mjs').stdout.trim(), `old`);
});

test('ROUTER_NODE wins; find-node ignores a too-old one', () => {
  const home = mk();
  const a = path.join(home, 'a/node');
  fakeNode(a, 'v24.0.0', 'echo pinned');
  assert.equal(runLauncher(env(home, { ROUTER_NODE: a })).stdout.trim(), 'pinned');
  const old = path.join(home, 'old/node');
  fakeNode(old, 'v20.1.0', 'echo old');
  const r = spawnSync('/bin/sh', [path.join(plugin, 'bin/find-node')], { env: env(home, { ROUTER_NODE: old }), encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
});

test('bin/run exits 0 silently and logs when only node < 22 exists', () => {
  const home = mk();
  fakeNode(path.join(home, 'bin/node'), 'v18.0.0');
  fakeNode(path.join(home, '.nvm/versions/node/v16.1.0/bin/node'), 'v16.1.0');
  const r = runLauncher(env(home, { PATH: `${path.join(home, 'bin')}:${SYS}` }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.match(read(path.join(home, 'data/errors.log')), /no Node 22\+ found/);
  assert.equal(fs.existsSync(path.join(home, 'data/node-path')), false);
});

test('bin/find-node says nothing and exits 1 with no node 22+', () => {
  const home = mk();
  fakeNode(path.join(home, '.nvm/versions/node/v16.1.0/bin/node'), 'v16.1.0');
  const r = spawnSync('/bin/sh', [path.join(plugin, 'bin/find-node')], { env: { PATH: SYS, HOME: home, ROUTER_NO_SYSTEM_NODE: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
});

test('hooks.json commands all go through bin/run', () => {
  const h = JSON.parse(read(path.join(plugin, 'hooks/hooks.json')));
  const cmds = Object.values(h.hooks).flat().flatMap((g) => g.hooks.map((x) => x.command));
  assert.equal(cmds.length, 4);
  for (const c of cmds) assert.match(c, /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/run" [a-z-]+\.mjs$/);
});

test('a hook runs end to end through bin/run', () => {
  const home = mk();
  const r = runLauncher(env(home, { PATH: `${nodeDir}:${SYS}` }), 'session-end.mjs', '{}');
  assert.equal(r.status, 0, r.stderr);
});

// ---------- install.sh ----------
// A fake claude that logs its argv and keeps marketplace/plugin state under HOME/.claude/plugins.
function setup() {
  const home = mk('router home ');
  const bin = path.join(home, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs'), path = require('path');
const home = process.env.HOME, a = process.argv.slice(2);
fs.appendFileSync(path.join(home, 'claude.log'), a.join(' ') + '\\n');
const dir = path.join(home, '.claude/plugins'); fs.mkdirSync(dir, { recursive: true });
const kf = path.join(dir, 'known_marketplaces.json'), pf = path.join(dir, 'installed_plugins.json');
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const known = rd(kf, {}), inst = rd(pf, { version: 2, plugins: {} });
const [g, sub, arg] = a;
if (g === 'plugin' && sub === 'marketplace') {
  const [, , verb, x] = a;
  if (verb === 'add') { known['claude-model-router'] = { source: x.startsWith('/') ? { source: 'directory', path: x } : { source: 'github', repo: x } }; fs.writeFileSync(kf, JSON.stringify(known)); }
  if (verb === 'remove') { delete known['claude-model-router']; fs.writeFileSync(kf, JSON.stringify(known)); }
} else if (g === 'plugin' && sub === 'install') {
  inst.plugins[arg] = [{ scope: 'user', installPath: ${JSON.stringify(plugin)}, version: '0.1.0' }]; fs.writeFileSync(pf, JSON.stringify(inst));
} else if (g === 'plugin' && sub === 'uninstall') {
  delete inst.plugins[arg]; fs.writeFileSync(pf, JSON.stringify(inst));
} else if (g === 'plugin' && sub === 'list') {
  for (const k of Object.keys(inst.plugins)) console.log('  ' + k);
}
`, { mode: 0o755 });
  const e = { PATH: `${bin}:${nodeDir}:${SYS}`, HOME: home };
  const sh = (...args) => spawnSync('/bin/sh', [installSh, ...args], { env: e, encoding: 'utf8', input: '' });
  const log = () => (fs.existsSync(path.join(home, 'claude.log')) ? read(path.join(home, 'claude.log')).trim().split('\n') : []);
  const clear = () => fs.rmSync(path.join(home, 'claude.log'), { force: true });
  return { home, e, sh, log, clear, settings: path.join(home, '.claude/settings.json') };
}

test('install.sh: fresh GitHub install runs add + install, and a re-run runs update + update', () => {
  const t = setup();
  const r = t.sh('--no-statusline');
  assert.equal(r.status, 0, r.stderr);
  const first = t.log().filter((l) => !l.startsWith('plugin list'));
  assert.match(first[1], / --config data_dir=.*\/\.claude\/router$/); // sets the optional data_dir so claude doesn't warn about it
  assert.deepEqual(first.map((l) => l.replace(/ --config data_dir=.*$/, '')), [
    'plugin marketplace add jknack0/claude-model-router',
    'plugin install router@claude-model-router --scope user',
  ]);
  t.clear();
  const r2 = t.sh('--no-statusline');
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(t.log().filter((l) => !l.startsWith('plugin list')), [
    'plugin marketplace update claude-model-router',
    'plugin update router@claude-model-router',
  ]);
  assert.match(r2.stdout, /router:init/);
  assert.equal(fs.existsSync(t.settings), false);
});

test('install.sh: --local registers the clone folder; switching source removes and re-adds', () => {
  const t = setup();
  t.sh('--no-statusline'); // github first
  t.clear();
  const r = t.sh('--local', '--no-statusline');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /registered from github:jknack0\/claude-model-router; switching it to directory:/);
  assert.deepEqual(t.log().filter((l) => l.includes('marketplace')), [
    'plugin marketplace remove claude-model-router',
    `plugin marketplace add ${fs.realpathSync(repo)}`,
  ]);
  // and back: a folder registration is switched to GitHub by default
  t.clear();
  const r2 = t.sh('--no-statusline');
  assert.match(r2.stdout, /switching it to github:jknack0\/claude-model-router/);
  assert.deepEqual(t.log().filter((l) => l.includes('marketplace')), [
    'plugin marketplace remove claude-model-router',
    'plugin marketplace add jknack0/claude-model-router',
  ]);
});

test('install.sh works piped to bash (no clone), finding Node from the installed plugin', () => {
  const t = setup();
  const r = spawnSync('bash', [], { env: t.e, input: read(installSh) + '\n', encoding: 'utf8' });
  // bash reads the script from stdin; flags can't be passed, so the statusline is skipped (no tty)
  assert.equal(r.status, 0, r.stderr);
  assert.match(t.log().join('\n'), /marketplace add jknack0\/claude-model-router/);
  assert.ok(read(path.join(t.home, '.claude/router/node-path')).trim().endsWith('/node'));
  const l = spawnSync('bash', ['-s', '--', '--local'], { env: t.e, input: read(installSh), encoding: 'utf8' });
  assert.equal(l.status, 1);
  assert.match(l.stderr, /--local needs to run from a clone/);
});

test('install.sh --statusline writes settings with a backup, keeps other keys, and the shim prints', () => {
  const t = setup();
  fs.mkdirSync(path.dirname(t.settings), { recursive: true });
  fs.writeFileSync(t.settings, JSON.stringify({ theme: 'dark' }));
  const r = t.sh('--statusline');
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(read(t.settings));
  assert.equal(s.theme, 'dark');
  assert.deepEqual(s.statusLine, { type: 'command', command: 'sh ~/.claude/router/statusline.sh' });
  assert.deepEqual(JSON.parse(read(t.settings + '.router-bak')), { theme: 'dark' });
  // run the installed statusline.sh (the shim chain) against the repo's plugin dir
  const input = JSON.stringify({ model: { id: 'claude-opus-5-5' }, effort: { level: 'high' }, context_window: { used_percentage: 10, context_window_size: 200000 } });
  const out = spawnSync('/bin/sh', [path.join(t.home, '.claude/router/statusline.sh')], { env: { ...t.e, ROUTER_DATA_DIR: path.join(t.home, 'data') }, input, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /opus·high/);
  // re-running is a no-op
  assert.match(t.sh('--statusline').stdout, /already set up/);
});

test('install.sh leaves a different existing statusLine alone', () => {
  const t = setup();
  fs.mkdirSync(path.dirname(t.settings), { recursive: true });
  const before = JSON.stringify({ statusLine: { type: 'command', command: 'echo mine' } });
  fs.writeFileSync(t.settings, before);
  const r = t.sh('--statusline');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(t.settings), before);
  assert.equal(fs.existsSync(t.settings + '.router-bak'), false);
  assert.match(r.stderr, /different statusLine/);
  assert.match(r.stdout, /statusline\.sh/);
});

test('statusline shim prints nothing when the plugin is not installed', () => {
  const t = setup();
  t.sh('--statusline');
  fs.rmSync(path.join(t.home, '.claude/plugins/installed_plugins.json'));
  const out = spawnSync('/bin/sh', [path.join(t.home, '.claude/router/statusline.sh')], { env: t.e, input: '{}', encoding: 'utf8' });
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '');
});

test('install.sh --uninstall reverses it', () => {
  const t = setup();
  fs.mkdirSync(path.dirname(t.settings), { recursive: true });
  fs.writeFileSync(t.settings, JSON.stringify({ theme: 'dark' }));
  t.sh('--statusline');
  t.clear();
  const r = t.sh('--uninstall');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(t.log(), ['plugin uninstall router@claude-model-router', 'plugin marketplace remove claude-model-router']);
  assert.deepEqual(JSON.parse(read(t.settings)), { theme: 'dark' });
  assert.equal(fs.existsSync(path.join(t.home, '.claude/router/statusline.sh')), false);
  // a foreign statusLine survives uninstall
  fs.writeFileSync(t.settings, JSON.stringify({ statusLine: { type: 'command', command: 'echo mine' } }));
  t.sh('--uninstall');
  assert.equal(JSON.parse(read(t.settings)).statusLine.command, 'echo mine');
});

test('install.sh exits 1 with a message when claude is missing', () => {
  const home = mk();
  const r = spawnSync('/bin/sh', [installSh], { env: { PATH: SYS, HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /'claude'/);
});
