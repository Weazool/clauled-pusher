#!/usr/bin/env node
// Claude Code hook command: shows what Claude is doing right now.
//
//   node busy.mjs prompt   - UserPromptSubmit, a turn is starting
//   node busy.mjs tool     - PreToolUse, a tool is about to run
//
// The device animates the spinner itself, so a long turn keeps moving with no
// further pushes. The busy state also self-expires, so a missed Stop hook
// cannot leave it spinning forever.

import { readStdin, debugLog, push, buildDisplay } from './clauled.mjs';

// Our own list. Claude Code's real spinner vocabulary is not exposed to hooks,
// so these are in the same spirit but will not match your terminal.
const GERUNDS = [
  'Discombobulating', 'Percolating', 'Ruminating', 'Noodling',
  'Cogitating', 'Marinating', 'Wibbling', 'Schlepping',
  'Pondering', 'Simmering', 'Conjuring', 'Untangling',
  'Deliberating', 'Finagling', 'Concocting', 'Mulling',
];

// Tool names are the raw class names; make them read like activities.
const TOOL_VERBS = {
  Bash: 'Running Bash',
  Read: 'Reading',
  Edit: 'Editing',
  Write: 'Writing',
  Glob: 'Searching',
  Grep: 'Searching',
  WebFetch: 'Fetching',
  WebSearch: 'Searching web',
  Task: 'Delegating',
  Agent: 'Delegating',
  TodoWrite: 'Planning',
  NotebookEdit: 'Editing notebook',
};

const kind = (process.argv[2] || 'prompt').toLowerCase();

const raw = await readStdin();
debugLog(`busy:${kind}`, raw);

let payload = {};
try {
  payload = JSON.parse(raw);
} catch {
  /* fall through to a generic gerund */
}

let text;
if (kind === 'tool' && payload.tool_name) {
  const verb = TOOL_VERBS[payload.tool_name] ?? `Running ${payload.tool_name}`;
  // A file path is more useful than the bare verb when there is room.
  const file = payload.tool_input?.file_path ?? payload.tool_input?.path ?? '';
  const base = file ? String(file).split(/[\\/]/).pop() : '';
  text = base && verb.length + base.length + 1 <= 19 ? `${verb} ${base}` : verb;
} else {
  text = GERUNDS[Math.floor(Math.random() * GERUNDS.length)];
}

// Every push recomputes the FULL display from whatever this payload can tell
// us - session, model, effort, both gauges - not just the spinner. Previously
// this hook only sent title/session/effort and left the gauges untouched, so
// a fast burst of tool calls carried a stale context reading the whole time.
// Model is the one field hook payloads never carry (only the statusline gets
// it), so it still falls back to whatever was last cached - there is no
// fresher source available from inside a hook.
const body = { ...buildDisplay(payload), v: 3, busy: text.slice(0, 19) };

await push(body);

// Hooks must exit 0. A failed push is not a reason to disrupt the session.
process.exit(0);
