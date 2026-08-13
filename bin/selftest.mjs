#!/usr/bin/env node
// Verify the transform and wire format without needing the device.
//
//   node bin/selftest.mjs
//
// Points CLAULED_PORT at a temp file, runs the real statusline and event
// scripts, and asserts on the exact bytes they write. Use this when the device
// is unplugged, or to check a change to extractUsage() before flashing.

import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const BIN = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'clauled-selftest-'));
const FAKE_PORT = join(TMP, 'fake-port');

function run(script, args, stdin) {
  return new Promise((resolve) => {
    writeFileSync(FAKE_PORT, '');
    const p = spawn(process.execPath, [join(BIN, script), ...args], {
      env: { ...process.env, CLAULED_PORT: FAKE_PORT },
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

const nowSec = Math.floor(Date.now() / 1000);
console.log('\nclauled-pusher selftest (serial transport)\n');

// --- documented shape: used_percentage + resets_at as epoch seconds ---
console.log('statusline, documented schema');
let r = await run('statusline.mjs', [], JSON.stringify({
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: nowSec + 4920 },
    seven_day: { used_percentage: 41.2, resets_at: nowSec + 340000 },
  },
}));
check('wrote a line to the port', r.raw.endsWith('\n'), JSON.stringify(r.raw.slice(-3)));
check('payload is valid JSON', r.sent !== null);
check('schema version tagged', r.sent?.v === 1);
check('5h pct preserved', r.sent?.usage?.five_hour?.pct === 23.5);
check('5h resets_at -> seconds remaining',
  Math.abs((r.sent?.usage?.five_hour?.resets_in ?? 0) - 4920) <= 2,
  `got ${r.sent?.usage?.five_hour?.resets_in}`);
check('7d present', r.sent?.usage?.seven_day?.pct === 41.2);
check('statusline printed something', r.stdout.trim().length > 0, JSON.stringify(r.stdout));

// --- alternate spellings: utilization + ISO timestamp ---
console.log('\nstatusline, alternate spellings');
r = await run('statusline.mjs', [], JSON.stringify({
  rateLimits: { fiveHour: { utilization: 77, resetsAt: new Date(Date.now() + 600_000).toISOString() } },
}));
check('utilization accepted as pct', r.sent?.usage?.five_hour?.pct === 77);
check('ISO resetsAt converted',
  Math.abs((r.sent?.usage?.five_hour?.resets_in ?? 0) - 600) <= 3,
  `got ${r.sent?.usage?.five_hour?.resets_in}`);

// --- unrecognised payload must not push garbage ---
console.log('\nstatusline, unrecognised payload');
r = await run('statusline.mjs', [], JSON.stringify({ something: 'else' }));
check('nothing written', r.raw.length === 0, `${r.raw.length} bytes`);
check('still printed a statusline', r.stdout.trim().length > 0, JSON.stringify(r.stdout));

// --- events ---
console.log('\nevents');
r = await run('event.mjs', ['stop'], '{}');
check('stop pushed an event', Array.isArray(r.sent?.events));
check('stop has attention type', r.sent?.events?.[0]?.type === 'attention');
check('stop carries no usage key', r.sent?.usage === undefined);

r = await run('event.mjs', ['notification'], JSON.stringify({ message: 'Permission needed for Bash' }));
check('notification uses its own message',
  r.sent?.events?.[0]?.text === 'Permission needed for Bash',
  r.sent?.events?.[0]?.text);

try { unlinkSync(FAKE_PORT); } catch {}
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
