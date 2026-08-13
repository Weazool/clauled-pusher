// Shared helpers for the Clauled pusher scripts.
//
// Transport is USB serial. The device is found by its Espressif USB vendor ID
// (303A), so moving it to a different port just works - no configuration.
//
// Nothing here may throw or hang: these run inside Claude Code's statusline and
// hook paths, where a slow script is felt as UI lag on every turn.

import { readFileSync, writeFileSync, appendFileSync, openSync, writeSync, readSync, closeSync, fstatSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_PATH = join(homedir(), '.clauled.json');
const CACHE_PATH  = join(homedir(), '.clauled-port');
const MODEL_CACHE = join(homedir(), '.clauled-model');
const DEBUG_PATH  = join(homedir(), '.clauled-debug.log');
const ESP_VID     = '303A';          // Espressif
const CACHE_TTL_MS = 5 * 60 * 1000;  // re-scan at most every 5 minutes

/** Optional. Only needed to override auto-detection or turn on debug capture. */
export function loadConfig() {
  const cfg = { port: '', debug: false, token: '' };
  try {
    Object.assign(cfg, JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));
  } catch { /* absent is the normal case */ }
  if (process.env.CLAULED_PORT) cfg.port = process.env.CLAULED_PORT;
  return cfg;
}

export function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    // If nothing is piped in, don't hang the host process waiting for EOF.
    const guard = setTimeout(() => resolve(buf), 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => { clearTimeout(guard); resolve(buf); });
    process.stdin.on('error', () => { clearTimeout(guard); resolve(buf); });
  });
}

/**
 * Capture raw payloads to ~/.clauled-debug.log.
 *
 * Enabled by CLAULED_DEBUG=1 OR by "debug": true in ~/.clauled.json. The config
 * flag matters: an environment variable has to be set on the process that
 * launches Claude Code, which means restarting it. The file is re-read on every
 * invocation, so toggling it takes effect on the very next render.
 */
export function debugLog(tag, data) {
  let on = !!process.env.CLAULED_DEBUG;
  if (!on) {
    try { on = !!loadConfig().debug; } catch { /* never break the caller */ }
  }
  if (!on) return;
  try {
    appendFileSync(DEBUG_PATH, `\n=== ${tag} ${new Date().toISOString()}\n${data}\n`);
  } catch { /* debug logging must never break the caller */ }
}

// ── Port discovery ────────────────────────────────────────────

/** Windows device path for a COM port: \\.\COM12 (needed above COM9). */
function winPath(com) {
  const B = String.fromCharCode(92);
  return B + B + '.' + B + com;
}

function detectWindows() {
  // PowerShell rather than a native module: no dependency, no build step.
  const ps =
    "Get-CimInstance Win32_PnPEntity | " +
    `Where-Object { $_.PNPDeviceID -like '*VID_${ESP_VID}*' -and $_.Name -match 'COM\\d+' } | ` +
    "ForEach-Object { if ($_.Name -match '(COM\\d+)') { $Matches[1] } }";
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  const com = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return com ? winPath(com) : '';
}

function detectUnix() {
  // by-id carries the VID and is stable across reboots; fall back to raw nodes.
  const byId = '/dev/serial/by-id';
  if (existsSync(byId)) {
    const hit = readdirSync(byId).find((f) => f.toLowerCase().includes(ESP_VID.toLowerCase()));
    if (hit) return join(byId, hit);
  }
  for (const dir of ['/dev']) {
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find(
      (f) => f.startsWith('ttyACM') || f.startsWith('cu.usbmodem') || f.startsWith('tty.usbmodem'),
    );
    if (hit) return join(dir, hit);
  }
  return '';
}

/**
 * Resolve the device path. Detection is cached because the statusline runs
 * often and spawning PowerShell every render would be felt as lag.
 * Pass force=true to bypass the cache after a failed write.
 */
export function findPort(force = false) {
  const cfg = loadConfig();
  if (cfg.port) {
    return platform() === 'win32' && /^COM\d+$/i.test(cfg.port) ? winPath(cfg.port) : cfg.port;
  }

  if (!force) {
    try {
      const { path, at } = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
      if (path && Date.now() - at < CACHE_TTL_MS) return path;
    } catch { /* no usable cache */ }
  }

  let path = '';
  try {
    path = platform() === 'win32' ? detectWindows() : detectUnix();
  } catch { path = ''; }

  if (path) {
    try { writeFileSync(CACHE_PATH, JSON.stringify({ path, at: Date.now() })); } catch {}
  }
  return path;
}

// ── Transport ─────────────────────────────────────────────────

function writeLine(path, line) {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

/**
 * Send one JSON object as a line. Always resolves - never throws, never hangs.
 * On failure it re-detects the port once, so unplugging and replugging into a
 * different USB socket recovers by itself.
 */
export function push(body) {
  const line = JSON.stringify(body) + '\n';

  for (const force of [false, true]) {
    const path = findPort(force);
    if (!path) continue;
    try {
      writeLine(path, line);
      return { ok: true, port: path };
    } catch (err) {
      debugLog('push-error', `${path}: ${err?.code ?? err?.message}`);
      // fall through and retry with fresh detection
    }
  }
  return { ok: false, reason: 'device not found' };
}

/**
 * Round-trip status probe. Needs to read as well as write, which the plain
 * file API cannot do on a COM port, so Windows shells out to .NET SerialPort.
 * Used by the doctor; the hot paths stay write-only.
 */
export function probeStatus() {
  const path = findPort();
  if (!path) return { ok: false, reason: 'device not found' };

  if (platform() !== 'win32') {
    // Reading a tty from Node without a native module is unreliable; a
    // successful write is the best signal available here.
    const r = push({ v: 3, cmd: 'status' });
    return r.ok ? { ok: true, port: path, note: 'write-only probe' } : r;
  }

  const com = path.replace(/^\\\\\.\\/, '');
  const ps = `
$ErrorActionPreference='Stop'
$p = New-Object System.IO.Ports.SerialPort '${com}',115200,'None',8,'one'
# Do NOT assert DTR/RTS. .NET raises them on Open() by default, which resets
# the ESP32-C3 and wipes the very state we are trying to read - the probe
# would report last_push_age=-1 no matter what had just been pushed.
$p.DtrEnable = $false
$p.RtsEnable = $false
$p.NewLine = "\`n"
$p.ReadTimeout = 2500
$p.Open()
Start-Sleep -Milliseconds 400
$p.DiscardInBuffer()
$p.WriteLine('{"v":3,"cmd":"status"}')
Start-Sleep -Milliseconds 700
$out = $p.ReadExisting()
$p.Close()
foreach ($l in ($out -split "\`r?\`n")) { if ($l.Trim().StartsWith('{')) { Write-Output $l.Trim() } }
`;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      timeout: 12000,
      windowsHide: true,
    });
    const line = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith('{')).pop();
    if (!line) return { ok: false, port: path, reason: 'no reply' };
    return { ok: true, port: path, status: JSON.parse(line) };
  } catch (err) {
    return { ok: false, port: path, reason: err?.message?.split('\n')[0] ?? 'probe failed' };
  }
}

// ── 5h subscription quota ─────────────────────────────────────
//
// Claude Code does not expose subscription limits anywhere locally - not in the
// statusline payload, not in the transcript. The only source is the
// anthropic-ratelimit-unified-5h-* response headers, which need an
// authenticated call.
//
// The token is read from the credentials file Claude Code already maintains and
// refreshes. Nothing is created, copied or stored, and it never reaches the
// device.

const QUOTA_CACHE  = join(homedir(), '.clauled-quota.json');
const CREDS_PATH   = join(homedir(), '.claude', '.credentials.json');
const QUOTA_TTL_MS = 5 * 60 * 1000;

function readToken() {
  // An explicit token wins. On some setups Claude Code no longer keeps the
  // real token in the credentials file - it leaves the keys present but empty -
  // so the file is a fallback, not the primary source.
  const cfg = loadConfig();
  if (cfg.token) return cfg.token;
  if (process.env.CLAULED_TOKEN) return process.env.CLAULED_TOKEN;
  try {
    const j = JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
    const o = j.claudeAiOauth || j;
    return o.accessToken || '';
  } catch {
    return '';
  }
}

/** Whatever is on disk, however old. Never blocks. */
export function readCachedQuota() {
  try {
    const c = JSON.parse(readFileSync(QUOTA_CACHE, 'utf8'));
    return { ...c.data, ageMs: Date.now() - c.at, stale: Date.now() - c.at > QUOTA_TTL_MS };
  } catch {
    return null;
  }
}

/** Does the actual API call. Run from refresh-quota.mjs, never inline. */
export async function refreshQuota() {
  const token = readToken();
  if (!token) return { ok: false, reason: 'no token in ~/.claude/.credentials.json' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${token}`,
      },
      // Smallest possible request: the body is irrelevant, only the headers matter.
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: '.' }],
      }),
      signal: ctrl.signal,
    });

    const util = parseFloat(res.headers.get('anthropic-ratelimit-unified-5h-utilization') ?? '');
    const reset = parseInt(res.headers.get('anthropic-ratelimit-unified-5h-reset') ?? '', 10);

    if (!Number.isFinite(util)) {
      return { ok: false, reason: `no rate-limit headers (HTTP ${res.status})`, status: res.status };
    }

    const data = {
      pct: Math.max(0, Math.min(100, util * 100)),
      resetAt: Number.isFinite(reset) ? reset : null,
    };
    try { writeFileSync(QUOTA_CACHE, JSON.stringify({ at: Date.now(), data })); } catch {}
    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : (err?.message ?? 'error') };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kick off a refresh in a detached child if the cache is stale, and return
 * immediately. The statusline must never wait on a network call.
 */
export function maybeRefreshQuota() {
  const cached = readCachedQuota();
  if (cached && !cached.stale) return;
  try {
    const script = join(dirname(fileURLToPath(import.meta.url)), 'refresh-quota.mjs');
    const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch { /* a failed refresh just leaves the gauge showing the old value */ }
}

// ── Building the display payload ──────────────────────────────
//
// Claude Code's statusline payload does NOT carry subscription rate limits -
// verified against v2.1.231, and they are absent from the transcript too. The
// context_window figures in the payload are also always zero. What IS real is
// the per-message usage block written to the transcript, so context occupancy
// is computed from there.

/**
 * Read the newest usage block from a transcript. Only the tail is read - these
 * files reach multiple megabytes and this runs on every statusline render.
 */
export function readTranscriptUsage(path) {
  if (!path) return null;
  let text = '';
  try {
    const fd = openSync(path, 'r');
    try {
      const { size } = fstatSync(fd);
      const want = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(want);
      readSync(fd, buf, 0, want, Math.max(0, size - want));
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = text.split('\n');
  // Walk backwards: the first line may be a partial record, which simply fails
  // to parse and is skipped.
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith('{')) continue;
    let u;
    try { u = JSON.parse(l)?.message?.usage; } catch { continue; }
    if (!u) continue;
    const used =
      (u.input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);
    if (used > 0) return { used, output: u.output_tokens || 0 };
  }
  return null;
}

export function fmtTokens(n) {
  if (n >= 1e6) return (Math.round(n / 1e5) / 10).toString().replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
}

export function fmtDuration(ms) {
  const s = Math.floor((ms || 0) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// Unknown levels fall back to the raw value in buildTitle rather than being
// dropped - that silently lost "ultra" until it was noticed on the glass.
const EFFORT_SHORT = {
  low: 'low',
  medium: 'med',
  high: 'high',
  xhigh: 'xhi',
  ultra: 'ult',
  max: 'max',
};

/**
 * Header right-hand side: model plus effort, e.g. "Opus 5 med".
 *
 * The header has 14 characters to the right of "Claude". Truncating the joined
 * string would silently drop the effort on longer model names - "Claude Opus 5
 * (1M context)" became "Claude Opus 5 " with the effort gone. Reserve the
 * effort's room first and shorten the model instead.
 */
export function buildTitle(d) {
  const MAX = 14;
  let model = (d?.model?.display_name || d?.model?.id || '')
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/^Claude\s+/i, '')     // the header already says "Claude"
    .trim();

  // Only the statusline payload carries the model; hook payloads carry effort
  // but not model. Cache it from whoever has it so hooks can still render a
  // complete header instead of wiping the model down to just the effort.
  if (model) {
    try { writeFileSync(MODEL_CACHE, model); } catch {}
  } else {
    try { model = readFileSync(MODEL_CACHE, 'utf8').trim(); } catch { model = ''; }
  }

  // An unrecognised level is still worth showing, trimmed, rather than dropped.
  const raw = d?.effort?.level;
  const effort = raw ? (EFFORT_SHORT[raw] ?? String(raw).slice(0, 4)) : '';

  if (!effort) return model.slice(0, MAX);
  const room = MAX - effort.length - 1;
  return `${model.slice(0, Math.max(0, room))} ${effort}`.trim();
}

/** "1h21m" until an absolute epoch, for the 5h reset countdown. */
export function fmtUntil(epochSec) {
  if (!epochSec) return '';
  const s = Math.max(0, Math.round(epochSec - Date.now() / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m`;
  return 'now';
}

/**
 * Turn a Claude Code statusline payload into the device's display schema.
 *
 * Gauge 1 is the 5h subscription quota, which only exists behind an
 * authenticated API call, so it comes from a cache refreshed in the background.
 * Gauge 2 is context occupancy, computed from the transcript on every render.
 * One feed failing must never blank the other.
 */
export function buildDisplay(d) {
  const out = { v: 3 };

  const title = buildTitle(d);
  if (title) out.title = title;

  // Gauge 1 - 5h quota (cached; refreshed detached when stale)
  maybeRefreshQuota();
  const quota = readCachedQuota();
  out.gauge1 = { label: '5h session', pct: quota ? Math.round(quota.pct * 10) / 10 : -1 };

  // Gauge 2 - context window (live from the transcript)
  const size = d?.context_window?.context_window_size || 0;
  const usage = readTranscriptUsage(d?.transcript_path);
  const ctxPct = usage && size ? Math.min(100, (usage.used / size) * 100) : -1;
  out.gauge2 = { label: 'Context', pct: ctxPct >= 0 ? Math.round(ctxPct * 10) / 10 : -1 };

  // Detail row pairs each gauge with its most useful companion number.
  out.row = {
    left: quota ? fmtUntil(quota.resetAt) : '',
    right: usage && size ? `${fmtTokens(usage.used)}/${fmtTokens(size)}` : '',
  };

  const cost = d?.cost || {};
  out.footer = {
    left: typeof cost.total_cost_usd === 'number' ? '$' + cost.total_cost_usd.toFixed(2) : '',
  };

  return out;
}
