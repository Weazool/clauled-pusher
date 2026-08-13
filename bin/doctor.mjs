#!/usr/bin/env node
// Diagnose the link between this machine and the Clauled device.
//
//   node bin/doctor.mjs
//
// Checks port discovery, a round-trip status probe, and both push paths.
// Run this before blaming Claude Code - it isolates "device not reachable"
// from "the hook never fired", which are very different problems.

import { findPort, probeStatus, push, loadConfig, readCachedQuota } from './clauled.mjs';

let failures = 0;
const ok  = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };

console.log('\nclauled-pusher doctor\n');

// 1. Discovery
console.log('device');
const cfg = loadConfig();
if (cfg.port) console.log(`  port override set: ${cfg.port}`);
const port = findPort(true);   // force a fresh scan
if (port) ok(`found at ${port}`);
else {
  bad('no Clauled device found');
  console.log('        looked for a USB device with Espressif vendor ID 303A');
  console.log('        check the cable carries data (charge-only cables will not work)');
}

// 2. Round trip
if (port) {
  console.log('\nstatus probe');
  const r = probeStatus();
  if (r.ok && r.status) {
    ok('device replied');
    const s = r.status;
    console.log(`        version=${s.version} display_ok=${s.display_ok} uptime=${s.uptime}s last_push_age=${s.last_push_age}`);
    if (s.display_ok === false) {
      console.log('        note: I2C display not detected - device runs headless, pushes still work');
    }
  } else if (r.ok) {
    ok(`write succeeded (${r.note ?? 'no round trip on this platform'})`);
  } else {
    bad(`no reply (${r.reason})`);
    console.log('        another program may be holding the port - close any serial monitor');
  }

  // 3. Push paths
  console.log('\npush');
  const display = push({
    v: 3,
    title: 'doctor',
    gauge1: { label: '5h session', pct: 23 },
    gauge2: { label: 'Context', pct: 42 },
    row: { left: '1h21m', right: '420k/1M' },
    footer: { left: '$0.00' },
  });
  if (display.ok) ok('display push written'); else bad(`display push failed (${display.reason})`);

  const event = push({ v: 3, busy: '', events: [{ type: 'attention', text: 'doctor test' }] });
  if (event.ok) ok('event push written'); else bad(`event push failed (${event.reason})`);

  if (display.ok && event.ok) {
    console.log('        the screen should show two gauges and a test banner');
  }

  // 4. Quota feed - optional, and its absence must not read as a failure.
  console.log('\n5h quota feed');
  const q = readCachedQuota();
  if (q) {
    ok(`cached: ${q.pct.toFixed(1)}%${q.stale ? ' (stale, refreshing)' : ''}`);
  } else {
    console.log('  --    not configured - gauge 1 shows "--"');
    console.log('        needs an OAuth token; see the README. Everything else works without it.');
  }
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
