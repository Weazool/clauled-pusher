// Shared helpers for the Clauled pusher scripts.
//
// Transport is USB serial. The device is found by its Espressif USB vendor ID
// (303A), so moving it to a different port just works - no configuration.
//
// Nothing here may throw or hang: these run inside Claude Code's statusline and
// hook paths, where a slow script is felt as UI lag on every turn.

import { readFileSync, writeFileSync, appendFileSync, openSync, writeSync, closeSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const CONFIG_PATH = join(homedir(), '.clauled.json');
const CACHE_PATH  = join(homedir(), '.clauled-port');
const DEBUG_PATH  = join(homedir(), '.clauled-debug.log');
const ESP_VID     = '303A';          // Espressif
const CACHE_TTL_MS = 5 * 60 * 1000;  // re-scan at most every 5 minutes

/** Optional. Only needed to override auto-detection. */
export function loadConfig() {
  const cfg = { port: '' };
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

export function debugLog(tag, data) {
  if (!process.env.CLAULED_DEBUG) return;
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
    const r = push({ v: 1, cmd: 'status' });
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
$p.WriteLine('{"v":1,"cmd":"status"}')
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

// ── Usage extraction (unchanged by the transport switch) ──────

function num(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * Accepts epoch seconds, epoch milliseconds, or an ISO-8601 string, and returns
 * seconds remaining. The device has no clock, so the contract wants a duration.
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
 * docs describe. Run with CLAULED_DEBUG=1 to capture the real shape.
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
