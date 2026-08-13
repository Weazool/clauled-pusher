#!/usr/bin/env node
// Claude Code statusline command.
//
// Reads the statusline payload on stdin, pushes any rate-limit figures to the
// Clauled device, and prints a short status string back to Claude Code.
//
// The statusline is the ONLY source of rate-limit data that does not require an
// API token - hooks do not receive it. That is why usage lives here and events
// live in event.mjs.

import { readStdin, debugLog, extractUsage, push } from './clauled.mjs';

const raw = await readStdin();
debugLog('statusline', raw);

let payload = {};
try {
  payload = JSON.parse(raw);
} catch {
  /* a malformed payload still has to print a statusline */
}

const usage = extractUsage(payload);

if (usage) {
  // Deliberately not awaited for its result beyond completion: push() already
  // caps itself with a timeout and never rejects.
  await push({ v: 1, usage });
}

const fh = usage?.five_hour?.pct;
const sd = usage?.seven_day?.pct;

const parts = [];
if (fh != null) parts.push(`5h ${Math.round(fh)}%`);
if (sd != null) parts.push(`7d ${Math.round(sd)}%`);

// Printing nothing would blank the user's statusline, so always emit something.
process.stdout.write(parts.length ? parts.join('  ') : 'clauled: no usage data');
