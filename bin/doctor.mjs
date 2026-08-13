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
import { findPort, probeStatus, push, loadConfig, readCachedQuota, fmtUntil, buildTitle, tokenSourceHint } from './clauled.mjs';

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
    if (s.display_ok === false) {
      note('note: display not detected - device runs headless, pushes still work');
    }
  } else if (r.ok) {
    ok(`write succeeded (${r.note ?? 'no round trip on this platform'})`);
  } else {
    bad(`no reply (${r.reason})`);
    note('another program may be holding the port - close any serial monitor');
  }

  // 4. Push paths
  console.log('\npush');
  const display = push({
    v: 3,
    session: 'doctor',
    title: 'test',
    gauge1: { label: '5h reset', pct: 23 },
    gauge2: { label: 'ctx', pct: 42 },
    row: { left: '1h21m', right: '420k/1M' },
    footer: { right: 'xhigh' },
  });
  if (display.ok) ok('display push written'); else bad(`display push failed (${display.reason})`);

  const event = push({ v: 3, busy: '', events: [{ type: 'attention', text: 'doctor test' }] });
  if (event.ok) ok('event push written'); else bad(`event push failed (${event.reason})`);

  if (display.ok && event.ok) {
    note('the screen should show two gauges and a test banner');
  }

  // RESTORE. The values above are synthetic but entirely plausible - 23% with
  // a 1h21m countdown reads exactly like a real quota - and the device merges,
  // so they sit on the glass until something overwrites them. That can be
  // minutes, and in the meantime the device looks simply wrong.
  if (display.ok) {
    const restore = { v: 3, busy: '', events: [{ type: 'clear', text: '' }], session: '' };

    // The model has a real cache of its own (~/.clauled-model), written by
    // whichever push last carried a real one. Restoring from it beats leaving
    // "test" on the glass - though it can only ever be as fresh as the last
    // statusline render, since hooks never carry the model at all.
    restore.title = buildTitle({});

    const q = readCachedQuota();
    if (q) {
      restore.gauge1 = { label: '5h reset', pct: Math.round(q.pct * 10) / 10 };
      if (q.resetAt) restore.row = { left: fmtUntil(q.resetAt) };
    }
    push(restore);
    console.log('');
    if (q) ok('test values cleared; the quota gauge is real again');
    else   warn('test values cleared, but there is no cached quota to restore');
    note('the context gauge and the effort corner still hold doctor\'s values —');
    note('the next statusline render or hook corrects them');
  }
}

// 5. Quota feed - optional, and its absence must not read as a failure.
console.log('\n5h quota feed');
const q = readCachedQuota();
if (q) {
  ok(`cached: ${q.pct.toFixed(1)}%${q.stale ? ' (stale, refreshing)' : ''}${q.source === 'payload' ? ' - from the statusline payload, no token needed' : ''}`);
  if (q.week != null) note(`7-day: ${q.week.toFixed(1)}% (recorded; the device has no third gauge)`);
} else {
  console.log('  --    no reading yet');
  note('Claude Code sends rate_limits on some statusline payloads; one will populate this');
  note(`a token is only a fallback - ${tokenSourceHint()}`);
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
