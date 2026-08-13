#!/usr/bin/env node
// Claude Code hook command: pushes an event to the Clauled device.
//
//   node event.mjs stop           - Claude finished its turn, your move
//   node event.mjs notification   - Claude wants permission or input
//
// Hooks block the session while they run, so this must stay fast. push() is
// capped by config.timeoutMs (default 1s) and never throws.

import { readStdin, debugLog, push } from './clauled.mjs';

const kind = (process.argv[2] || 'event').toLowerCase();

const raw = await readStdin();
debugLog(`event:${kind}`, raw);

let payload = {};
try {
  payload = JSON.parse(raw);
} catch {
  /* fall back to the generic text below */
}

const DEFAULTS = {
  stop: { type: 'attention', text: 'Claude finished - your turn' },
  notification: { type: 'attention', text: 'Claude needs input' },
  sessionstart: { type: 'session', text: 'Claude Code session started' },
};

const event = DEFAULTS[kind] ?? { type: kind, text: 'Claude event' };

// Notification payloads may carry their own message; prefer it when present.
// The device truncates to 40 chars anyway, so trim here to keep the wire small.
if (typeof payload.message === 'string' && payload.message.trim()) {
  event.text = payload.message.trim().slice(0, 40);
}

await push({ v: 1, events: [event] });

// Hooks must exit 0. A failed push is not a reason to disrupt the session.
process.exit(0);
