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
import { isQuietHours } from './clauled.mjs';

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

// A transcript whose newest usage block puts context at 70% and was produced
// by Sonnet 5 - the raw API id, same shape buildTitle()'s transcript fallback
// has to reshape into "Sonnet 5".
writeFileSync(TRANSCRIPT, [
  JSON.stringify({ message: { usage: { input_tokens: 1, cache_read_input_tokens: 100_000 } } }),
  JSON.stringify({ message: { role: 'user' } }),
  JSON.stringify({ message: { model: 'claude-sonnet-5', usage: { input_tokens: 2, cache_creation_input_tokens: 1_390, cache_read_input_tokens: 698_608, output_tokens: 1_760 } } }),
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

console.log('quiet hours');
// Real wall-clock time would make this test flaky depending on when the suite
// runs, so every case pins an explicit hour rather than relying on the
// default (new Date().getHours()).
check('2am is quiet under the default 0-6 window', isQuietHours({}, 2) === true);
check('6am is NOT quiet - the window is end-exclusive', isQuietHours({}, 6) === false);
check('11pm is not quiet under the default window', isQuietHours({}, 23) === false);
check('midnight is quiet, the start boundary is inclusive', isQuietHours({}, 0) === true);
check(
  'a window that wraps past midnight (23-7) includes 11pm',
  isQuietHours({ quietStart: 23, quietEnd: 7 }, 23) === true,
);
check(
  'the same wrapping window includes 3am',
  isQuietHours({ quietStart: 23, quietEnd: 7 }, 3) === true,
);
check(
  'the same wrapping window excludes noon',
  isQuietHours({ quietStart: 23, quietEnd: 7 }, 12) === false,
);

const payload = {
  session_id: 'aaaa1111-bbbb-2222-cccc-333344445555',
  transcript_path: TRANSCRIPT,
  model: { display_name: 'Opus 5 (1M context)' },
  effort: { level: 'medium' },
  context_window: { context_window_size: 1_000_000 },
  workspace: { current_dir: 'C:/code/proj' },
};

console.log('statusline');
clearQuota();
let r = await run('statusline.mjs', [], JSON.stringify(payload));
check('wrote a line to the port', r.raw.endsWith('\n'));
// Deliberate: a LEADING newline terminates any unterminated fragment already
// sitting in the device's line buffer (a short write, a retried write, or two
// concurrent sessions interleaving on the one port), so this push always
// starts on a clean line instead of being appended to garbage and lost.
check('every push starts with a newline, so a stray fragment cannot swallow it', r.raw.startsWith('\n'), JSON.stringify(r.raw.slice(0, 3)));
check('schema v3', r.sent?.v === 3);
// The actual value depends on the real clock the suite happens to run under,
// so only the SHAPE is checked here - that it is always sent, never omitted,
// which is what lets the device clear a stale "true" once quiet hours end.
check('quiet is always present as a boolean', typeof r.sent?.quiet === 'boolean', JSON.stringify(r.sent?.quiet));
check('sid is the first 8 hex chars of session_id', r.sent?.sid === 'aaaa1111', r.sent?.sid);
check('header carries the model alone', r.sent?.title === 'Opus 5', r.sent?.title);
check('footer carries the effort spelled out', r.sent?.footer?.right === 'medium', r.sent?.footer?.right);
check('header carries the session', r.sent?.session === 'proj', r.sent?.session);
check('gauge1 omitted when no quota source', r.sent?.gauge1 === undefined, JSON.stringify(r.sent?.gauge1));
check('gauge2 labelled ctx', r.sent?.gauge2?.label === 'ctx');
check('gauge2 pct from transcript ~70', Math.abs((r.sent?.gauge2?.pct ?? 0) - 70) < 0.5, String(r.sent?.gauge2?.pct));
check('row right is tokens', r.sent?.row?.right === '700k/1M', r.sent?.row?.right);
const ctxLine = `${r.sent?.gauge2?.label} ${r.sent?.row?.right} 100%`;
check('context line fits 21 chars at 100%', ctxLine.length <= 21, `${ctxLine.length} - "${ctxLine}"`);
check('footer carries no cost', r.sent?.footer?.left === undefined, JSON.stringify(r.sent?.footer));
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
check('gauge1 labelled 5h', r.sent?.gauge1?.label === '5h', r.sent?.gauge1?.label);
check('gauge1 comes from rate_limits', r.sent?.gauge1?.pct === 26, String(r.sent?.gauge1?.pct));
check('row left counts down to the reset', /^(\d+h\d+m|\d+m|now)$/.test(r.sent?.row?.left ?? ''), r.sent?.row?.left);
check('reading is cached for later invocations', existsSync(QUOTA_CACHE));
check('seven_day is captured too', JSON.parse(readFileSync(QUOTA_CACHE, 'utf8')).data.week === 21);

// gauge3 (the weekly reading) rides the same rate_limits block. It is
// entirely new - v3.6.x firmware just ignores an unrecognised field, which is
// what makes it safe to always send once available rather than needing a
// firmware-version check on the host side.
check('gauge3 labelled 1w', r.sent?.gauge3?.label === '1w', r.sent?.gauge3?.label);
check('gauge3 comes from seven_day', r.sent?.gauge3?.pct === 21, String(r.sent?.gauge3?.pct));
check('gauge3 carries its own reset countdown', /^(\d+h\d+m|\d+m|now)$/.test(r.sent?.gauge3?.reset ?? ''), r.sent?.gauge3?.reset);

// The device composes "<label> <detail> <pct>%" into ONE 21-character row, so
// what is sent here decides whether that row fits. Check the worst case: 100%
// is a character wider than every other value, and it is precisely when the
// row most needs to be readable.
const quotaLine = `${r.sent?.gauge1?.label} ${r.sent?.row?.left} 100%`;
check('quota line fits 21 chars at 100%', quotaLine.length <= 21, `${quotaLine.length} - "${quotaLine}"`);
const weekLine = `${r.sent?.gauge3?.label} ${r.sent?.gauge3?.reset} 100%`;
check('weekly line fits 21 chars at 100%', weekLine.length <= 21, `${weekLine.length} - "${weekLine}"`);

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

console.log('\nhooks recompute EVERYTHING, not just their own field');
// The whole point of routing busy.mjs and event.mjs through buildDisplay():
// a hook that only sent its own field (the spinner, or the banner) used to
// leave session/model/effort/gauges stale until the next statusline render,
// which can be minutes away. A model or effort change mid-session would sit
// wrong on the glass for the entire gap. Feed busy.mjs a full-shaped payload
// and confirm session, effort and BOTH gauges come out fresh in one push -
// gauge1 (quota) and the context gauge were never sent by a hook at all
// before this.
r = await run('busy.mjs', ['prompt'], JSON.stringify({
  ...payload,
  effort: { level: 'high' },
  workspace: { current_dir: 'C:/code/other-project' },
}));
check('busy carries the model from cache', r.sent?.title === 'Opus 5', r.sent?.title);
check('busy carries its sid too', r.sent?.sid === 'aaaa1111', r.sent?.sid);
check('busy carries the session from cwd', r.sent?.session === 'other-project', r.sent?.session);
check('busy carries the effort fresh from the payload', r.sent?.footer?.right === 'high', r.sent?.footer?.right);
check('busy carries the cached quota', r.sent?.gauge1?.pct === 26, String(r.sent?.gauge1?.pct));
check('busy carries context from the transcript', Math.abs((r.sent?.gauge2?.pct ?? 0) - 70) < 0.5, String(r.sent?.gauge2?.pct));

console.log('\nthe model cache does not leak across sessions');
// This is the whole reason the model cache became per-sid instead of one
// shared file: two concurrent sessions can genuinely be on different models.
// A hook-only push (no model field) for a session that has NEVER had its own
// statusline render should NOT recover session A's cached "Opus 5" - it
// should come back with no model at all, same as if nothing were cached.
r = await run('busy.mjs', ['tool'], JSON.stringify({
  session_id: 'zzzz9999-0000-1111-2222-333344445555',   // a session never seen before
  tool_name: 'Bash',
}));
check('a different session with no cache of its own gets no model', r.sent?.title === undefined, JSON.stringify(r.sent?.title));
check('but it still gets its own sid', r.sent?.sid === 'zzzz9999', r.sent?.sid);

// Once THAT session's statusline runs, it caches its OWN model - proving the
// two sessions' entries coexist rather than one overwriting the other.
r = await run('statusline.mjs', [], JSON.stringify({
  session_id: 'zzzz9999-0000-1111-2222-333344445555',
  model: { display_name: 'Sonnet 5' },
}));
check('the second session caches its own, different model', r.sent?.title === 'Sonnet 5', r.sent?.title);

r = await run('busy.mjs', ['tool'], JSON.stringify({
  session_id: 'aaaa1111-bbbb-2222-cccc-333344445555',   // back to the first session
  tool_name: 'Bash',
}));
check('the first session still recovers ITS OWN model, unaffected by the second', r.sent?.title === 'Opus 5', r.sent?.title);

console.log('\nmodel falls back to the transcript when neither the payload nor the cache has it');
// Some environments never invoke the statusline at all - the only push that
// ever carries d.model - which would otherwise leave a session's footer
// permanently blank even after real work has happened. The transcript
// already carries the model on every assistant message (same file the
// context gauge reads), so a hook-only session can still recover it.
r = await run('busy.mjs', ['tool'], JSON.stringify({
  session_id: 'ffff7777-0000-1111-2222-333344445555',   // a session never seen before
  transcript_path: TRANSCRIPT,
  tool_name: 'Bash',
}));
check('model recovered from the transcript', r.sent?.title === 'Sonnet 5', r.sent?.title);

r = await run('busy.mjs', ['tool'], JSON.stringify({
  session_id: 'ffff7777-0000-1111-2222-333344445555',
  tool_name: 'Read',
}));
check('and is now cached, so a later push with no transcript still has it', r.sent?.title === 'Sonnet 5', r.sent?.title);

console.log('\na model switched mid-session is picked up, not pinned to the cache');
// The regression this pins: the cache used to be consulted BEFORE the
// transcript, so once a session had any cached model, nothing ever looked
// further and switching models mid-session left the footer naming the old
// one forever. Precedence is payload > transcript > cache, and every
// fresher answer rewrites the cache.
const SWITCHED = 'mmmm2222-0000-1111-2222-333344445555';
r = await run('statusline.mjs', [], JSON.stringify({
  session_id: SWITCHED,
  model: { display_name: 'Haiku 4.5' },
}));
check('cache primed with the first model', r.sent?.title === 'Haiku 4.5', r.sent?.title);

// Same session, but the transcript says a DIFFERENT model produced the newest
// message. The transcript is current; the cache is stale. Transcript wins.
r = await run('busy.mjs', ['tool'], JSON.stringify({
  session_id: SWITCHED,
  transcript_path: TRANSCRIPT,
  tool_name: 'Bash',
}));
check('the switch is picked up from the transcript', r.sent?.title === 'Sonnet 5', r.sent?.title);

r = await run('busy.mjs', ['tool'], JSON.stringify({ session_id: SWITCHED, tool_name: 'Read' }));
check('and the refreshed model is what gets cached', r.sent?.title === 'Sonnet 5', r.sent?.title);

// The payload, when there is one, is still the most authoritative source.
r = await run('statusline.mjs', [], JSON.stringify({
  session_id: SWITCHED,
  transcript_path: TRANSCRIPT,          // says Sonnet 5
  model: { display_name: 'Opus 5' },    // ...but the payload says Opus 5
}));
check('a live payload model still beats the transcript', r.sent?.title === 'Opus 5', r.sent?.title);

r = await run('busy.mjs', ['tool'], JSON.stringify({ tool_name: 'Bash' }));
check('tool name becomes an activity', r.sent?.busy === 'Running Bash', r.sent?.busy);

r = await run('busy.mjs', ['tool'], JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'C:/x/main.cpp' } }));
check('file basename appended when it fits', r.sent?.busy === 'Editing main.cpp', r.sent?.busy);

r = await run('busy.mjs', ['tool'], JSON.stringify({ tool_name: 'SomeUnknownTool' }));
check('unknown tool falls back', /^Running /.test(r.sent?.busy ?? ''), r.sent?.busy);

check('busy text fits one line', (r.sent?.busy ?? '').length <= 19, String((r.sent?.busy ?? '').length));

console.log('\ntools that wait for you raise a banner, not a spinner');
// PreToolUse for these fires exactly when your attention starts being needed -
// the tool's execution IS the prompt. Rendering them as a spinner said
// "Running ExitPlanMode" at the precise moment nothing was happening
// without you.
r = await run('busy.mjs', ['tool'], JSON.stringify({ tool_name: 'ExitPlanMode' }));
check('a proposed plan raises "Review plan"', r.sent?.events?.[0]?.text === 'Review plan', JSON.stringify(r.sent?.events));
check('and clears the spinner rather than setting one', r.sent?.busy === '', JSON.stringify(r.sent?.busy));

r = await run('busy.mjs', ['tool'], JSON.stringify({ tool_name: 'AskUserQuestion' }));
check('a question raises "Answer question"', r.sent?.events?.[0]?.text === 'Answer question', JSON.stringify(r.sent?.events));

// The banner must still be a normal full push - it is not a special-cased
// payload that forgets everything else the display needs.
r = await run('busy.mjs', ['tool'], JSON.stringify({
  ...payload, tool_name: 'ExitPlanMode', effort: { level: 'high' },
}));
check('the plan banner still carries the full display', r.sent?.gauge1?.pct === 26 && r.sent?.footer?.right === 'high', JSON.stringify({ g1: r.sent?.gauge1?.pct, effort: r.sent?.footer?.right }));
check('the plan banner fits one screen line', (r.sent?.events?.[0]?.text ?? '').length <= 21);

console.log('\nevents');
r = await run('event.mjs', ['stop'], '{}');
check('stop raises a banner', r.sent?.events?.[0]?.text === 'Your turn', r.sent?.events?.[0]?.text);
check('stop clears the spinner', r.sent?.busy === '', JSON.stringify(r.sent?.busy));

// Same regression as busy.mjs: event.mjs used to send only gauge2, so a Stop
// banner never carried the 5h figure even with a cached reading sitting right
// there.
r = await run('event.mjs', ['stop'], JSON.stringify({ ...payload, effort: { level: 'low' } }));
check('stop also carries the cached quota', r.sent?.gauge1?.pct === 26, String(r.sent?.gauge1?.pct));
check('stop carries the effort fresh from the payload', r.sent?.footer?.right === 'low', r.sent?.footer?.right);

r = await run('event.mjs', ['notification'], JSON.stringify({ message: 'Permission needed for Bash' }));
const noteText = r.sent?.events?.[0]?.text ?? '';
check('notification uses its own message', noteText.startsWith('Permission needed'), noteText);
check('notification trimmed to one screen line', noteText.length <= 21, String(noteText.length));

r = await run('event.mjs', ['notification'], '{}');
check('notification without a message has a default', r.sent?.events?.[0]?.text === 'Claude needs input', r.sent?.events?.[0]?.text);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
