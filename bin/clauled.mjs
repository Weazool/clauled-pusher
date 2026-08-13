// Shared helpers for the Clauled pusher scripts.
//
// Nothing here may throw or hang: these run inside Claude Code's statusline and
// hook paths, where a slow script is felt as UI lag on every turn.

import { readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_PATH = join(homedir(), '.clauled.json');
const DEBUG_PATH = join(homedir(), '.clauled-debug.log');

/** Env wins over the config file, so you can override per-shell. */
export function loadConfig() {
  const cfg = { url: 'http://clauled.local', key: '', timeoutMs: 1000 };
  try {
    Object.assign(cfg, JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));
  } catch {
    /* no config file is fine as long as env vars are set */
  }
  if (process.env.CLAULED_URL) cfg.url = process.env.CLAULED_URL;
  if (process.env.CLAULED_KEY) cfg.key = process.env.CLAULED_KEY;
  cfg.url = String(cfg.url).replace(/\/+$/, '');
  return cfg;
}

export function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    // If nothing is piped in, don't hang the host process waiting for EOF.
    const guard = setTimeout(() => resolve(buf), 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => {
      clearTimeout(guard);
      resolve(buf);
    });
    process.stdin.on('error', () => {
      clearTimeout(guard);
      resolve(buf);
    });
  });
}

/**
 * Append the raw payload to ~/.clauled-debug.log when CLAULED_DEBUG=1.
 * This is how you discover the real statusline schema - see README.
 */
export function debugLog(tag, data) {
  if (!process.env.CLAULED_DEBUG) return;
  try {
    appendFileSync(DEBUG_PATH, `\n=== ${tag} ${new Date().toISOString()}\n${data}\n`);
  } catch {
    /* debug logging must never break the caller */
  }
}

function num(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * Accepts epoch seconds, epoch milliseconds, or an ISO-8601 string, and returns
 * seconds remaining. The device has no wall clock, so the contract wants a
 * duration rather than a timestamp - that conversion happens here.
 */
export function toSecondsRemaining(v) {
  if (v == null) return null;
  let ms = null;
  if (typeof v === 'number') {
    ms = v > 1e12 ? v : v * 1000;
  } else if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) ms = n > 1e12 ? n : n * 1000;
    else {
      const parsed = Date.parse(v);
      ms = Number.isNaN(parsed) ? null : parsed;
    }
  }
  if (ms == null) return null;
  const secs = Math.round((ms - Date.now()) / 1000);
  return secs > 0 ? secs : 0;
}

/**
 * Pull usage out of a statusline payload.
 *
 * NOTE: the exact field names Claude Code emits are not confirmed. This reads
 * several plausible spellings so it keeps working if they differ from what the
 * docs describe. Run with CLAULED_DEBUG=1 to capture the real shape, then
 * tighten this if you like.
 */
export function extractUsage(d) {
  const rl = d?.rate_limits ?? d?.rateLimits ?? d?.usage ?? null;
  if (!rl || typeof rl !== 'object') return null;

  const pick = (o) => {
    if (!o || typeof o !== 'object') return null;
    const pct = num(o.used_percentage ?? o.usedPercentage ?? o.utilization ?? o.pct);
    const resetsIn = toSecondsRemaining(
      o.resets_at ?? o.resetsAt ?? o.reset_at ?? o.resets_in ?? null,
    );
    if (pct == null && resetsIn == null) return null;
    const m = {};
    if (pct != null) m.pct = Math.max(0, Math.min(100, pct));
    if (resetsIn != null) m.resets_in = resetsIn;
    return m;
  };

  const usage = {};
  const fh = pick(rl.five_hour ?? rl.fiveHour ?? rl['5h']);
  const sd = pick(rl.seven_day ?? rl.sevenDay ?? rl['7d']);
  const sn = pick(rl.seven_day_sonnet ?? rl.sevenDaySonnet ?? rl['7d_sonnet']);
  if (fh) usage.five_hour = fh;
  if (sd) usage.seven_day = sd;
  if (sn) usage.seven_day_sonnet = sn;

  return Object.keys(usage).length ? usage : null;
}

/** POST to the device. Always resolves - never throws, never hangs. */
export async function push(body) {
  const cfg = loadConfig();
  if (!cfg.key) return { ok: false, reason: 'no key configured' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.url}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Clauled-Key': cfg.key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, reason: err?.name ?? 'error' };
  } finally {
    clearTimeout(timer);
  }
}
