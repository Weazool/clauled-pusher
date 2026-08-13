#!/usr/bin/env node
// Diagnose the link between this machine and the Clauled device.
//
//   node bin/doctor.mjs
//
// Checks port discovery, a round-trip status probe, and both push paths.
// Run this before blaming Claude Code - it isolates "device not reachable"
// from "the hook never fired", which are very different problems.

import { findPort, probeStatus, push, loadConfig } from './clauled.mjs';

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
  const usage = push({ v: 1, usage: { five_hour: { pct: 42, resets_in: 3600 } } });
  if (usage.ok) ok('usage push written'); else bad(`usage push failed (${usage.reason})`);

  const event = push({ v: 1, events: [{ type: 'attention', text: 'doctor test event' }] });
  if (event.ok) ok('event push written'); else bad(`event push failed (${event.reason})`);

  if (usage.ok && event.ok) {
    console.log('        the display should now show 42% on the session bar');
  }
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
