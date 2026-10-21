#!/usr/bin/env node
// CLI: node ingest.mjs [--days 30] | --session <transcript path>   (SessionEnd hook uses --session)
import fs from 'node:fs';
import { sub } from './lib/paths.mjs';
import { ingestAll, ingestSession } from './lib/ingest.mjs';

const a = process.argv.slice(2);
const val = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
try {
  const one = val('--session');
  if (one) ingestSession(one);
  else {
    const r = ingestAll({ days: Number(val('--days') ?? 30) });
    console.log(`ingested ${r.ingested} of ${r.sessionIds.length} sessions`);
  }
} catch (err) {
  try { fs.appendFileSync(sub('errors.log'), `${new Date().toISOString()} ingest.mjs: ${err.stack}\n`); } catch { /* ignore */ }
  if (!val('--session')) console.error(err.message); // hook use stays silent
}
process.exit(0);
