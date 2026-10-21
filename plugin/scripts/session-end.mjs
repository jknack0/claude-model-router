// SessionEnd hook: ingest this session's transcript. Hook payloads arrive on stdin, so this wraps ingestSession.
import { runHook } from './lib/hook.mjs';

await runHook('session-end', async (input) => {
  if (!input.transcript_path) return;
  const { ingestSession } = await import('./lib/ingest.mjs');
  await ingestSession(input.transcript_path);
});
