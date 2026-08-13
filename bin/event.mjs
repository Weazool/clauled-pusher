#!/usr/bin/env node
// Claude Code hook command: pushes an attention banner to the Clauled device.
//
//   node event.mjs stop           - Claude finished its turn, your move
//   node event.mjs notification   - Claude wants permission or input
//
// The banner is inverted on the device - the loudest thing on the screen - and
// supersedes the spinner. Both events also clear the busy state, since the turn
// is over either way.

import { readStdin, debugLog, push, readContext, fmtTokens, buildTitle, buildSession, buildEffort } from './clauled.mjs';

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

// busy:"" ends the spinner in the same push that raises the banner.
const body = { v: 3, busy: '', events: [{ type: kind, text }] };

const title = buildTitle(payload);
if (title) body.title = title;
const session = buildSession(payload);
if (session) body.session = session;
const effort = buildEffort(payload);
if (effort) body.footer = { right: effort };

// Refresh context here too. The statusline renders before the turn's usage
// block is written, so its reading always trails by one message. By the time
// Stop fires the transcript is current, which closes that gap.
//
// Omitted entirely when it cannot be computed - the device merges, so silence
// preserves the last good reading instead of blanking the gauge to "--".
const ctx = readContext(payload);
if (ctx) {
  body.gauge2 = { label: 'ctx', pct: Math.round(Math.min(100, (ctx.used / ctx.size) * 100) * 10) / 10 };
  body.row = { right: `${fmtTokens(ctx.used)}/${fmtTokens(ctx.size)}` };
}

await push(body);

// Hooks must exit 0. A failed push is not a reason to disrupt the session.
process.exit(0);
