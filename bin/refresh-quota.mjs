#!/usr/bin/env node
// Refresh the 5h subscription quota cache.
//
// Spawned detached by the statusline when the cache goes stale, so the
// statusline itself never waits on a network call. Also runnable by hand:
//
//   node bin/refresh-quota.mjs
//
// Makes one minimal API request and keeps only the rate-limit response
// headers. The token comes from ~/.claude/.credentials.json, which Claude Code
// already maintains - nothing is created, copied, or sent to the device.

import { refreshQuota } from './clauled.mjs';

const r = await refreshQuota();

if (process.stdout.isTTY) {
  if (r.ok) console.log(`5h quota: ${r.data.pct.toFixed(1)}%  resets at ${r.data.resetAt ?? 'unknown'}`);
  else console.log(`refresh failed: ${r.reason}`);
}

process.exit(r.ok ? 0 : 1);
