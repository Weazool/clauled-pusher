#!/usr/bin/env node
// Verify the transform and wire format without needing the device.
//
//   node bin/selftest.mjs
//
// Points CLAULED_PORT at a temp file, runs the real scripts against a synthetic
// transcript, and asserts on the exact bytes they write.

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const BIN = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'clauled-selftest-'));
const FAKE_PORT = join(TMP, 'fake-port');
const TRANSCRIPT = join(TMP, 'transcript.jsonl');

// Every file the scripts touch lives under homedir(), so the suite has to own
// a home of its own. Without this it reads the developer's real ~/.clauled.json
// and ~/.clauled-quota.json, and the results depend on whether that machine
// happens to have a token configured - which is how "gauge1 is -1 with no
// token" passed for months on a machine that had one.
//
// Node resolves homedir() from USERPROFILE on Windows and HOME elsewhere, so
// both are set.
const HOME = join(TMP, 'home');
mkdirSync(HOME);

const QUOTA_CACHE = join(HOME, '.clauled-quota.json');
const clearQuota = () => { try { rmSync(QUOTA_CACHE); } catch { /* already absent */ } };

// A transcript whose newest usage block puts context at 70%.
writeFileSync(TRANSCRIPT, [
  JSON.stringify({ message: { usage: { input_tokens: 1, cache_read_input_tokens: 100_000 } } }),
  JSON.stringify({ message: { role: 'user' } }),
  JSON.stringify({ message: { usage: { input_tokens: 2, cache_creation_input_tokens: 1_390, cache_read_input_tokens: 698_608, output_tokens: 1_760 } } }),
].join('\n') + '\n');

function run(script, args, stdin) {
  return new Promise((resolve) => {
    writeFileSync(FAKE_PORT, '');
    const p = spawn(process.execPath, [join(BIN, script), ...args], {
      env: {
        ...process.env,
        HOME, USERPROFILE: HOME,
        CLAULED_PORT: FAKE_PORT, CLAULED_DEBUG: '', CLAULED_TOKEN: '',
      },
    });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.on('close', () => {
      let written = '';
      try { written = readFileSync(FAKE_PORT, 'utf8'); } catch {}
      let parsed = null;
      try { parsed = JSON.parse(written.trim()); } catch {}
      resolve({ stdout: out, raw: written, sent: parsed });
    });
    p.stdin.write(stdin);
    p.stdin.end();
  });
}

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
  if (!cond) failures++;
};

console.log('\nclauled-pusher selftest\n');

const payload = {
  transcript_path: TRANSCRIPT,
  model: { display_name: 'Opus 5 (1M context)' },
  effort: { level: 'medium' },
  context_window: { context_window_size: 1_000_000 },
  cost: { total_cost_usd: 0 },
};

console.log('statusline');
clearQuota();
let r = await run('statusline.mjs', [], JSON.stringify(payload));
check('wrote a line to the port', r.raw.endsWith('\n'));
check('schema v3', r.sent?.v === 3);
check('header carries model and effort', r.sent?.title === 'Opus 5 med', r.sent?.title);
check('gauge1 omitted when no quota source', r.sent?.gauge1 === undefined, JSON.stringify(r.sent?.gauge1));
check('gauge2 labelled ctx', r.sent?.gauge2?.label === 'ctx');
check('gauge2 pct from transcript ~70', Math.abs((r.sent?.gauge2?.pct ?? 0) - 70) < 0.5, String(r.sent?.gauge2?.pct));
check('row right is tokens', r.sent?.row?.right === '700k/1M', r.sent?.row?.right);
const ctxLine = `${r.sent?.gauge2?.label} ${r.sent?.row?.right} 100%`;
check('context line fits 21 chars at 100%', ctxLine.length <= 21, `${ctxLine.length} - "${ctxLine}"`);
check('footer is cost', r.sent?.footer?.left === '$0.00', r.sent?.footer?.left);
check('statusline printed context', /ctx 70%/.test(r.stdout), JSON.stringify(r.stdout));

console.log('\n5h quota from the payload, no token needed');
clearQuota();
const soon = Math.floor(Date.now() / 1000) + 5_000;
r = await run('statusline.mjs', [], JSON.stringify({
  ...payload,
  rate_limits: {
    five_hour: { used_percentage: 26, resets_at: soon },
    seven_day: { used_percentage: 21, resets_at: soon + 86_400 },
  },
}));
check('gauge1 labelled 5h reset', r.sent?.gauge1?.label === '5h reset');
check('gauge1 comes from rate_limits', r.sent?.gauge1?.pct === 26, String(r.sent?.gauge1?.pct));
check('row left counts down to the reset', /^(\d+h\d+m|\d+m|now)$/.test(r.sent?.row?.left ?? ''), r.sent?.row?.left);
check('reading is cached for later invocations', existsSync(QUOTA_CACHE));
check('seven_day is captured too', JSON.parse(readFileSync(QUOTA_CACHE, 'utf8')).data.week === 21);

// The device composes "<label> <detail> <pct>%" into ONE 21-character row, so
// what is sent here decides whether that row fits. Check the worst case: 100%
// is a character wider than every other value, and it is precisely when the
// row most needs to be readable.
const quotaLine = `${r.sent?.gauge1?.label} ${r.sent?.row?.left} 100%`;
check('quota line fits 21 chars at 100%', quotaLine.length <= 21, `${quotaLine.length} - "${quotaLine}"`);

console.log('\ncontext_window in the payload beats the transcript');
r = await run('statusline.mjs', [], JSON.stringify({
  ...payload,
  context_window: {
    context_window_size: 1_000_000,
    current_usage: { input_tokens: 2, cache_creation_input_tokens: 9_596, cache_read_input_tokens: 27_040 },
  },
}));
check('gauge2 from context_window ~3.7', Math.abs((r.sent?.gauge2?.pct ?? 0) - 3.7) < 0.15, String(r.sent?.gauge2?.pct));

console.log('\na reduced payload never blanks a gauge');
// Claude Code does not send the same keys every time - some invocations carry
// only {model, effort}. Emitting pct:-1 for the missing feeds overwrote good
// readings with "--" on the device, because the device merges and -1 is data.
r = await run('statusline.mjs', [], JSON.stringify({ model: { display_name: 'Opus 5' }, effort: { level: 'medium' } }));
check('gauge2 omitted, not blanked', r.sent?.gauge2 === undefined, JSON.stringify(r.sent?.gauge2));
check('gauge1 still served from the cache', r.sent?.gauge1?.pct === 26, String(r.sent?.gauge1?.pct));

console.log('\nstatusline degrades safely');
r = await run('statusline.mjs', [], JSON.stringify({ ...payload, transcript_path: '/nonexistent' }));
check('gauge2 omitted with no transcript', r.sent?.gauge2 === undefined, JSON.stringify(r.sent?.gauge2));
check('still printed something', r.stdout.trim().length > 0, JSON.stringify(r.stdout));

r = await run('statusline.mjs', [], 'not json at all');
check('garbage payload still emits a statusline', r.stdout.trim().length > 0, JSON.stringify(r.stdout));

console.log('\nbusy states');
r = await run('busy.mjs', ['prompt'], '{}');
check('prompt sets a gerund', typeof r.sent?.busy === 'string' && r.sent.busy.length > 3, r.sent?.busy);
check('busy push carries no gauges', r.sent?.gauge1 === undefined);

r = await run('busy.mjs', ['tool'], JSON.stringify({ tool_name: 'Bash' }));
check('tool name becomes an activity', r.sent?.busy === 'Running Bash', r.sent?.busy);

r = await run('busy.mjs', ['tool'], JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'C:/x/main.cpp' } }));
check('file basename appended when it fits', r.sent?.busy === 'Editing main.cpp', r.sent?.busy);

r = await run('busy.mjs', ['tool'], JSON.stringify({ tool_name: 'SomeUnknownTool' }));
check('unknown tool falls back', /^Running /.test(r.sent?.busy ?? ''), r.sent?.busy);

check('busy text fits one line', (r.sent?.busy ?? '').length <= 19, String((r.sent?.busy ?? '').length));

console.log('\nevents');
r = await run('event.mjs', ['stop'], '{}');
check('stop raises a banner', r.sent?.events?.[0]?.text === 'Your turn', r.sent?.events?.[0]?.text);
check('stop clears the spinner', r.sent?.busy === '', JSON.stringify(r.sent?.busy));

r = await run('event.mjs', ['notification'], JSON.stringify({ message: 'Permission needed for Bash' }));
const noteText = r.sent?.events?.[0]?.text ?? '';
check('notification uses its own message', noteText.startsWith('Permission needed'), noteText);
check('notification trimmed to one screen line', noteText.length <= 21, String(noteText.length));

r = await run('event.mjs', ['notification'], '{}');
check('notification without a message has a default', r.sent?.events?.[0]?.text === 'Claude needs input', r.sent?.events?.[0]?.text);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
