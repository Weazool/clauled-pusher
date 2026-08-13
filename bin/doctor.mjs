#!/usr/bin/env node
// Diagnose the link between this machine and the Clauled device.
//
//   node bin/doctor.mjs
//
// Checks configuration, port discovery, a round-trip status probe, both push
// paths, and how the statusline is wired. Run this before blaming Claude Code -
// it isolates "device not reachable" from "the hook never fired", which are
// very different problems.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findPort, probeStatus, push, sleepSync, loadConfig, readCachedQuota, fmtUntil, isQuietHours, tokenSourceHint } from './clauled.mjs';

// A dedicated, fake session id - so the test push lands in its OWN roster
// slot on the device (v3.7.0+) rather than colliding with a real session or
// the shared "" fallback slot a single-session setup might be using.
const DOCTOR_SID = 'doctor00';

let failures = 0;
const ok   = (m) => console.log(`  ok    ${m}`);
const bad  = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const warn = (m) => console.log(`  warn  ${m}`);
const note = (m) => console.log(`        ${m}`);

const OS = platform() === 'win32' ? 'Windows' : platform() === 'darwin' ? 'macOS' : platform();

console.log(`\nclauled-pusher doctor  (${OS}, node ${process.version})\n`);

// 1. Configuration
console.log('config');
const cfg = loadConfig();
const CONFIG_PATH = join(homedir(), '.clauled.json');
if (cfg.configError) {
  // Previously this was swallowed and every setting silently reverted to its
  // default, with nothing anywhere saying why.
  bad(`${CONFIG_PATH} is not valid JSON`);
  note(cfg.configError);
  note('every setting in it is being ignored until this is fixed');
} else if (existsSync(CONFIG_PATH)) {
  ok('~/.clauled.json parsed');
  if (cfg.port) note(`port override: ${cfg.port}`);
  if (cfg.debug) warn('debug capture is on - ~/.clauled-debug.log records prompts and paths');
  if (cfg.token && platform() !== 'win32') {
    try {
      if (statSync(CONFIG_PATH).mode & 0o077) {
        warn('~/.clauled.json holds a token and is readable by other users');
        note('chmod 600 ~/.clauled.json');
      }
    } catch { /* stat is best effort */ }
  }
} else {
  ok('no ~/.clauled.json - using defaults (this is the normal case)');
}
const quiet = isQuietHours(cfg);
note(`quiet hours: ${cfg.quietStart ?? 0}:00-${cfg.quietEnd ?? 6}:00 local - currently ${quiet ? 'ON' : 'off'}`);

// 2. Discovery
console.log('\ndevice');
const port = findPort(true);   // force a fresh scan
if (port) {
  ok(`found at ${port}`);
  if (platform() === 'darwin' && !port.includes('/cu.')) {
    warn('this is not a cu.* node; only callout devices are safe to open');
  }
} else {
  bad('no Clauled device found');
  note(`looked for a USB device with Espressif vendor ID 303A (${OS} enumeration)`);
  note('check the cable carries data - charge-only cables will not work');
  if (platform() === 'darwin') note('manual check: ls /dev/cu.usbmodem*');
  if (platform() === 'win32') note('manual check: the device appears as VID_303A in Device Manager');
}

// 3. Round trip
if (port) {
  console.log('\nstatus probe');
  const r = probeStatus();
  if (r.ok && r.status) {
    ok('device replied');
    const s = r.status;
    note(`version=${s.version} display_ok=${s.display_ok} uptime=${s.uptime}s last_push_age=${s.last_push_age}`);
    if (typeof s.sessions === 'number') {
      note(`sessions in the roster right now: ${s.sessions}${s.sessions > 1 ? ' - rotating every 6s' : ''}`);
    }
    if (Array.isArray(s.roster) && s.roster.length) {
      for (const r of s.roster) {
        const bits = [r.sid || '(no sid)', r.name ? `"${r.name}"` : '(no name)', `pushed ${r.age}s ago`];
        if (r.event) bits.push(`event: "${r.event}"`);
        if (r.busy) bits.push(`busy: "${r.busy}"`);
        note(`  - ${bits.join('  ')}`);
      }
    }
    if (s.display_ok === false) {
      note('note: display not detected - device runs headless, pushes still work');
    }
    if (s.quiet_sleep) {
      note('panel is currently OFF - quiet hours, idle past the threshold. This is');
      note('correct behaviour, not a fault; the device wakes on the next push.');
    }
  } else if (r.ok) {
    ok(`write succeeded (${r.note ?? 'no round trip on this platform'})`);
  } else {
    bad(`no reply (${r.reason})`);
    note('another program may be holding the port - close any serial monitor');
  }

  // 4. Push paths
  //
  // Pushes are paced with sleepSync() between them - see push()'s doc comment
  // in clauled.mjs. Firing this many in immediate succession reliably lost
  // the tail of the burst on real hardware: the device parses JSON and
  // redraws the whole panel before it reads more serial, and a normal hook
  // only ever sends one push at a time, so nothing else exercises this.
  console.log('\npush');
  const display = push({
    v: 3,
    sid: DOCTOR_SID,
    session: 'doctor',
    title: 'test',
    quiet,   // the real value - never fake this, it is a live state flag
    gauge1: { label: '5h', pct: 23 },
    gauge3: { label: '1w', pct: 61, reset: '3d4h' },
    gauge2: { label: 'ctx', pct: 42 },
    row: { left: '1h21m', right: '420k/1M' },
    footer: { right: 'xhigh' },
  });
  if (display.ok) ok('display push written'); else bad(`display push failed (${display.reason})`);

  sleepSync(150);
  const event = push({ v: 3, sid: DOCTOR_SID, busy: '', events: [{ type: 'attention', text: 'doctor test' }] });
  if (event.ok) ok('event push written'); else bad(`event push failed (${event.reason})`);

  if (display.ok && event.ok) {
    note('the screen should show two gauges (5h alternating with 1w) and a test banner');
  }

  // RESTORE. gauge1/gauge3 are ACCOUNT-LEVEL on the device (v3.7.0+) - the
  // same row every session shares - so a fake 23% here does not just sit in
  // doctor's own slot, it is what EVERY session would show until something
  // overwrites it. That can be minutes; restore the real cached reading
  // immediately rather than leave it wrong in the meantime.
  if (display.ok) {
    const restore = {
      v: 3, sid: DOCTOR_SID, busy: '',
      events: [{ type: 'clear', text: '' }],
      session: '', title: '',   // doctor was never a real session - nothing to restore this TO
      quiet: isQuietHours(cfg),
    };

    const q = readCachedQuota();
    if (q) {
      restore.gauge1 = { label: '5h', pct: Math.round(q.pct * 10) / 10 };
      if (q.resetAt) restore.row = { left: fmtUntil(q.resetAt) };
    }
    // gauge3 (the weekly reading) has no token fallback, so there may be
    // nothing real cached to restore it TO. pct:-1 tells the device to hide
    // the weekly row again (hasWeek goes false on the device) rather than
    // leaving doctor's fake 61%/"3d4h" on screen with no real value to
    // correct it - previously that stuck around until a live payload
    // happened to carry rate_limits.seven_day again, which in a session
    // whose statusline never renders may be a very long time.
    if (q?.week != null) {
      restore.gauge3 = { label: '1w', pct: Math.round(q.week * 10) / 10 };
      if (q.weekResetAt) restore.gauge3.reset = fmtUntil(q.weekResetAt);
    } else {
      restore.gauge3 = { pct: -1 };
    }
    sleepSync(150);
    const restored = push(restore);

    // Remove doctor's own slot immediately rather than leaving it to age out
    // over SESSION_GONE_S (15 min) - otherwise every doctor run inflates the
    // session count for a quarter of an hour after the fact.
    sleepSync(150);
    const forgotten = push({ v: 3, cmd: 'forget', sid: DOCTOR_SID });

    console.log('');
    if (!restored.ok) {
      bad(`restore push failed (${restored.reason}) - the test values are still on screen`);
    } else if (q && q.week != null) {
      ok('test values cleared; both quota gauges are real again');
    } else if (q) {
      ok('test values cleared; 5h is real again');
      note('1w has no cached reading yet, so its test value was hidden rather than restored');
    } else {
      warn('test values cleared, but there is no cached quota to restore');
    }
    note('the context gauge and effort corner still hold doctor\'s values —');
    note('the next statusline render or hook corrects them');
    if (forgotten.ok) note('doctor\'s own "doctor" session has been removed from the roster');
    else bad(`could not remove doctor's session from the roster (${forgotten.reason}) - it will age out on its own within SESSION_GONE_S (15 min)`);
  }
}

// 5. Quota feed - optional, and its absence must not read as a failure.
console.log('\nquota feed');
const q = readCachedQuota();
if (q) {
  ok(`5h: ${q.pct.toFixed(1)}%${q.stale ? ' (stale, refreshing)' : ''}${q.source === 'payload' ? ' - from the statusline payload, no token needed' : ''}`);
  if (q.week != null) ok(`1w: ${q.week.toFixed(1)}% - alternates with the 5h row on the device every few seconds`);
  else note('1w: not seen yet - only arrives via the payload\'s rate_limits block, no token fallback for it');
} else {
  console.log('  --    no reading yet');
  note('Claude Code sends rate_limits on some statusline payloads; one will populate this');
  note(`a token is only a fallback for the 5h figure - ${tokenSourceHint()}`);
}

// 6. How the statusline is wired
console.log('\nstatusline wiring');
const SETTINGS = join(homedir(), '.claude', 'settings.json');
let settings = null;
try { settings = JSON.parse(readFileSync(SETTINGS, 'utf8')); } catch { /* absent or unparseable */ }
const cmd = typeof settings?.statusLine?.command === 'string' ? settings.statusLine.command : '';

if (!cmd) {
  warn('no statusLine configured - gauges will only update on hooks');
  note('run: node bin/install.mjs');
} else if (!cmd.includes('clauled')) {
  warn('a different statusLine is configured; Clauled is not driving it');
  note(cmd);
} else {
  ok('statusLine configured');
  note(cmd);

  // The interpreter must exist. Baking an absolute path is what makes this
  // work from a GUI launch, but it also means a node upgrade can strip it out.
  const exe = (cmd.match(/^"([^"]+)"/) ?? cmd.match(/^(\S+)/))?.[1] ?? '';
  if (exe && exe !== 'node' && !existsSync(exe)) {
    bad(`the interpreter it names no longer exists: ${exe}`);
    note('re-run: node bin/install.mjs');
  }

  // Pointing at a plugin-managed path is the failure that looks like nothing
  // at all: it works until an update moves or sweeps the directory.
  if (/plugins[\/\\](cache|marketplaces)[\/\\]/.test(cmd)) {
    warn('it points inside Claude Code\'s plugin directories');
    note('cache paths are version-pinned and swept ~14 days after an update;');
    note('marketplace clones track branch HEAD and drift from the installed version');
    note('re-run `node bin/install.mjs` to point it at a stable shim instead');
  }
}

// 7. Can a hook find node at all? This is the macOS failure mode: a GUI launch
// inherits launchd's PATH, not the one a shell would build.
console.log('\nhook interpreter');
try {
  const probe = platform() === 'win32'
    ? execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'node --version'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    : execFileSync('/bin/sh', ['-c', 'command -v node && node --version'], { encoding: 'utf8', timeout: 5000 });
  ok(`a shell resolves node: ${probe.trim().split('\n').pop()}`);
  note('note: this shell inherited THIS terminal\'s PATH.');
  if (platform() === 'darwin') {
    note('if Claude Code was launched from Finder or the Dock it may have a smaller PATH,');
    note('in which case hooks cannot start. The statusline is immune - install.mjs');
    note('bakes an absolute interpreter path into it.');
  }
} catch {
  bad('a shell cannot resolve `node`');
  note('hooks are launched through a shell and will silently do nothing');
  note(platform() === 'darwin'
    ? 'add your node to the PATH that GUI apps inherit, or launch Claude Code from a terminal'
    : 'add node to PATH');
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
