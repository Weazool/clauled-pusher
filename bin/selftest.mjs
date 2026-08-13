#!/usr/bin/env node
// Verify the transform and wire format without needing the device.
//
//   node bin/selftest.mjs
//
// Spins up a local mock endpoint, runs the real statusline and event scripts
// against it, and asserts on what they actually POST. Use this when the device
// is unplugged, or to check a change to extractUsage() before flashing anything.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BIN = dirname(fileURLToPath(import.meta.url));
const PORT = 8787;
const received = [];

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({
      path: req.url,
      key: req.headers['x-clauled-key'] ?? null,
      body: (() => {
        try {
          return JSON.parse(body);
        } catch {
          return body;
        }
      })(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const env = {
  ...process.env,
  CLAULED_URL: `http://127.0.0.1:${PORT}`,
  CLAULED_KEY: 'selftest-key',
};

function run(script, args, stdin) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(BIN, script), ...args], { env });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.on('close', () => resolve(out));
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

console.log('\nclauled-pusher selftest\n');

// --- documented shape: used_percentage + resets_at as epoch seconds ---
console.log('statusline, documented schema');
const line = await run('statusline.mjs', [], JSON.stringify({
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: nowSec + 4920 },
    seven_day: { used_percentage: 41.2, resets_at: nowSec + 340000 },
  },
}));
const usagePush = received.find((r) => r.body?.usage);
check('pushed to /push', usagePush?.path === '/push');
check('sent the key header', usagePush?.key === 'selftest-key');
check('5h pct preserved', usagePush?.body?.usage?.five_hour?.pct === 23.5);
check(
  '5h resets_at converted to seconds remaining',
  Math.abs((usagePush?.body?.usage?.five_hour?.resets_in ?? 0) - 4920) <= 2,
  `got ${usagePush?.body?.usage?.five_hour?.resets_in}`,
);
check('7d present', usagePush?.body?.usage?.seven_day?.pct === 41.2);
check('schema version tagged', usagePush?.body?.v === 1);
check('statusline printed something', line.trim().length > 0, JSON.stringify(line));

// --- alternate spellings: utilization + ISO timestamp ---
console.log('\nstatusline, alternate spellings');
received.length = 0;
await run('statusline.mjs', [], JSON.stringify({
  rateLimits: {
    fiveHour: { utilization: 77, resetsAt: new Date(Date.now() + 600_000).toISOString() },
  },
}));
const alt = received.find((r) => r.body?.usage);
check('utilization accepted as pct', alt?.body?.usage?.five_hour?.pct === 77);
check(
  'ISO resetsAt converted',
  Math.abs((alt?.body?.usage?.five_hour?.resets_in ?? 0) - 600) <= 3,
  `got ${alt?.body?.usage?.five_hour?.resets_in}`,
);

// --- unrecognised payload must not push garbage ---
console.log('\nstatusline, unrecognised payload');
received.length = 0;
const fallback = await run('statusline.mjs', [], JSON.stringify({ something: 'else' }));
check('no push attempted', received.length === 0, `${received.length} request(s)`);
check('still printed a statusline', fallback.trim().length > 0, JSON.stringify(fallback));

// --- events ---
console.log('\nevents');
received.length = 0;
await run('event.mjs', ['stop'], '{}');
const stopEv = received[0];
check('stop pushed an event', Array.isArray(stopEv?.body?.events));
check('stop has attention type', stopEv?.body?.events?.[0]?.type === 'attention');
check('stop carries no usage key', stopEv?.body?.usage === undefined);

received.length = 0;
await run('event.mjs', ['notification'], JSON.stringify({ message: 'Permission needed for Bash' }));
const noteEv = received[0];
check(
  'notification uses its own message',
  noteEv?.body?.events?.[0]?.text === 'Permission needed for Bash',
  noteEv?.body?.events?.[0]?.text,
);

server.close();
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
