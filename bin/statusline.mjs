#!/usr/bin/env node
// Claude Code statusline command.
//
// Builds the device's display from the statusline payload and pushes it over
// USB serial, then prints a short status string back to Claude Code.
//
// Two independent feeds:
//   5h quota  - from a background-refreshed cache (needs an API call)
//   context   - computed live from the session transcript
//
// Neither blocks: the quota refresh runs detached, and a missing feed leaves
// its gauge at "--" rather than blanking the screen.

import { readStdin, debugLog, buildDisplay, push } from './clauled.mjs';

const raw = await readStdin();
debugLog('statusline', raw);

let payload = {};
try {
  payload = JSON.parse(raw);
} catch {
  /* a malformed payload still has to print a statusline */
}

const display = buildDisplay(payload);

const hasSomething =
  display.title || (display.gauge1?.pct >= 0) || (display.gauge2?.pct >= 0);
if (hasSomething) await push(display);

const q = display.gauge1?.pct;
const c = display.gauge2?.pct;

const parts = [];
if (q >= 0) parts.push(`5h ${Math.round(q)}%`);
if (c >= 0) parts.push(`ctx ${Math.round(c)}%`);

// Printing nothing would blank the user's statusline, so always emit something.
process.stdout.write(parts.length ? parts.join('  ') : 'clauled');
