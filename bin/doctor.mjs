#!/usr/bin/env node
// Diagnose the connection between this machine and the Clauled device.
//
//   node bin/doctor.mjs
//
// Checks config, reachability, and both push paths. Run this before blaming
// Claude Code - it isolates "the device is unreachable" from "the hook never
// fired", which are very different problems.

import { loadConfig, push } from './clauled.mjs';

const cfg = loadConfig();
let failures = 0;

const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};

console.log('\nclauled-pusher doctor\n');

// 1. Config - never print the key itself, only whether it exists.
console.log('config');
console.log(`  url   ${cfg.url}`);
if (cfg.key) ok(`key   set (${cfg.key.length} chars)`);
else bad('key   NOT set - create ~/.clauled.json or set CLAULED_KEY');
console.log(`  timeout ${cfg.timeoutMs}ms`);

// 2. Reachability.
console.log('\nreachability');
let health = null;
try {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  const res = await fetch(`${cfg.url}/health`, { signal: ctrl.signal });
  clearTimeout(t);
  health = await res.json();
  ok(`GET /health -> ${res.status}`);
  console.log(`        version=${health.version} display_ok=${health.display_ok} last_push_age=${health.last_push_age}`);
  if (health.display_ok === false) {
    console.log('        note: OLED not detected - device runs headless, pushes still work');
  }
} catch (err) {
  bad(`GET ${cfg.url}/health failed (${err?.name ?? 'error'})`);
  console.log('        try the raw IP if mDNS is blocked on your network');
}

// 3. Push paths.
if (cfg.key && health) {
  console.log('\npush');

  const usage = await push({
    v: 1,
    usage: { five_hour: { pct: 42, resets_in: 3600 } },
  });
  if (usage.ok) ok('usage push accepted (200)');
  else bad(`usage push rejected (${usage.status ?? usage.reason})`);

  const event = await push({
    v: 1,
    events: [{ type: 'attention', text: 'doctor test event' }],
  });
  if (event.ok) ok('event push accepted (200)');
  else bad(`event push rejected (${event.status ?? event.reason})`);

  if (usage.status === 401 || event.status === 401) {
    console.log('        401 means the key does not match CLAULED_PUSH_KEY in the firmware.');
    console.log('        Changing it on the device requires a reflash.');
  }
}

console.log(
  failures === 0
    ? '\nAll checks passed.\n'
    : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
