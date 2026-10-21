// Does an agent definition pin a model? Fails closed: an agent we can't find is left alone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sub } from './paths.mjs';

const claudeDir = () => process.env.ROUTER_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..');
// general-purpose has no definition, so the router re-tiers it without looking. router:* agents pin their tier on purpose
// (picking router:deep is how Claude escalates), so they are left alone like any other pinned agent.
const ALWAYS_ROUTED = new Set(['general-purpose']);

const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return -1; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** {name, model} from an agent file's frontmatter (BOM stripped); null when unreadable or it has none. */
function parseAgent(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { return null; }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const get = (k) => {
    const line = new RegExp(`^${k}:\\s*(.+?)\\s*$`, 'm').exec(m[1]);
    return line ? line[1].replace(/^["']|["']$/g, '') : null;
  };
  return { name: get('name'), model: get('model') };
}

/** .md files under a file-or-directory path. */
function mdFiles(p) {
  try {
    if (fs.statSync(p).isFile()) return p.endsWith('.md') ? [p] : [];
    return fs.readdirSync(p, { recursive: true }).filter((f) => f.endsWith('.md')).map((f) => path.join(p, f));
  } catch { return []; }
}

/** First file under `paths` whose frontmatter name (else its filename) is `name`. */
function findIn(paths, name) {
  for (const p of paths) {
    for (const f of mdFiles(p)) {
      const a = parseAgent(f);
      if ((a?.name ?? path.basename(f, '.md')) === name) return { file: f, model: a?.model ?? null };
    }
  }
  return null;
}

const installedPlugins = () => path.join(claudeDir(), 'plugins', 'installed_plugins.json');

/** Agent paths of an installed plugin: its plugin.json `agents` entries, else agents/. */
function pluginAgentPaths(root) {
  const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'));
  const custom = manifest?.agents;
  const list = typeof custom === 'string' ? [custom] : Array.isArray(custom) ? custom.filter((x) => typeof x === 'string') : [];
  return [path.join(root, 'agents'), ...list.map((p) => path.resolve(root, p))];
}

/** Where a type's definition lives, in Claude Code's priority order: project, user, plugins. */
function locate(type, cwd) {
  const [plugin, name] = type.includes(':') ? type.split(':') : [null, type];
  if (plugin === 'router') return findIn([path.join(PLUGIN_ROOT, 'agents')], name);
  if (!plugin) {
    return findIn(cwd ? [path.join(cwd, '.claude', 'agents')] : [], name) ?? findIn([path.join(claudeDir(), 'agents')], name);
  }
  const installed = readJson(installedPlugins())?.plugins ?? {};
  for (const [key, entries] of Object.entries(installed)) {
    if (key.split('@')[0] !== plugin || !Array.isArray(entries)) continue;
    for (const e of entries) {
      if (typeof e?.installPath !== 'string') continue;
      const hit = findIn(pluginAgentPaths(e.installPath), name);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Should the router leave this agent's model alone? Re-tier only general-purpose, types in
 * `overrides`, and agents whose definition is found with no `model:` (or inherit). Everything else, including built-ins
 * and agents we can't find, is left alone.
 * Lookups are cached in state/agents.json against the mtimes of installed_plugins.json, the agent dirs and the matched file.
 */
export function pinned(type, cwd, overrides = []) {
  if (!type || overrides.includes(type) || ALWAYS_ROUTED.has(type)) return false; // no type means general-purpose
  const dirs = [installedPlugins(), path.join(claudeDir(), 'agents'), cwd ? path.join(cwd, '.claude', 'agents') : ''];
  const sig = dirs.map((d) => (d ? mtime(d) : 0)).join(',');
  const cacheFile = sub('state', 'agents.json');
  const cache = readJson(cacheFile) ?? {};
  const key = `${type}\t${cwd ?? ''}`;
  const hit = cache[key];
  if (hit && hit.sig === sig && (!hit.file || mtime(hit.file) === hit.mtime)) return hit.pinned;
  const found = locate(type, cwd);
  const isPinned = !found || (found.model != null && found.model !== 'inherit');
  cache[key] = { sig, file: found?.file ?? null, mtime: found ? mtime(found.file) : null, pinned: isPinned };
  try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch { /* cache is optional */ }
  return isPinned;
}
