#!/usr/bin/env node
// Claude Code hook command: pushes an attention banner to the Clauled device.
//
//   node event.mjs stop           - Claude finished its turn, your move
//   node event.mjs notification   - Claude wants permission or input
//
// The banner is inverted on the device - the loudest thing on the screen - and
// supersedes the spinner. Both events also clear the busy state, since the turn
// is over either way.

import { readStdin, debugLog, push, buildDisplay } from './clauled.mjs';

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
  stop: 'Your turn',
  notification: 'Claude needs input',
};

let text = DEFAULTS[kind] ?? 'Claude event';

// Notification payloads may carry their own message; prefer it when present.
if (typeof payload.message === 'string' && payload.message.trim()) {
  text = payload.message.trim().slice(0, 21);
}

// Every push recomputes the FULL display, same as busy.mjs - session, model,
// effort, both gauges, not just the banner. This is also where the quota
// gauge previously went missing entirely: this hook only ever sent gauge2, so
// a Stop banner never carried the 5h figure even when a cached reading
// existed. buildDisplay() closes that gap the same way it closes busy.mjs's.
//
// Context specifically benefits from firing here too: the statusline renders
// before the turn's usage block is written to the transcript, so its reading
// always trails by one message. The transcript is current by the time Stop
// fires, which is what closes that particular gap.
const body = { ...buildDisplay(payload), v: 3, busy: '', events: [{ type: kind, text }] };

await push(body);

// Hooks must exit 0. A failed push is not a reason to disrupt the session.
process.exit(0);
