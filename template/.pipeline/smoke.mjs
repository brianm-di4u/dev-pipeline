#!/usr/bin/env node
// Fetches the deployed app and checks that it answers with what it should. A failure
// reports through the same red-main issue as post-merge. Configure it in
// pipeline.config.json: "smoke": { "url": "https://...", "contains": "<title>My App" }
import { loadConfig } from './lib/config.mjs';

export async function check({ url, contains }, fetcher = fetch) {
  const response = await fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!response.ok) return { ok: false, reason: `${url} returned HTTP ${response.status}` };
  if (contains) {
    const body = await response.text();
    if (!body.includes(contains)) return { ok: false, reason: `${url} no longer contains the expected text` };
  }
  return { ok: true };
}

if (process.argv[1]?.endsWith('smoke.mjs')) {
  const config = loadConfig();
  if (!config.smoke?.url) {
    console.log('No smoke.url set in pipeline.config.json. Nothing to check.');
  } else {
    const result = await check(config.smoke).catch((error) => ({ ok: false, reason: error.message }));
    console.log(result.ok ? `${config.smoke.url} is healthy.` : result.reason);
    if (!result.ok) {
      process.argv.splice(2, process.argv.length, 'post-merge', '--result', 'smoke-failure');
      await import('./monitor.mjs').then((monitor) => monitor.main());
    }
  }
}
