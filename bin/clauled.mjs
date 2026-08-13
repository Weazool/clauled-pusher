// Shared helpers for the Clauled pusher scripts.
//
// Transport is USB serial. The device is found by its Espressif USB vendor ID
// (303A), so moving it to a different port just works - no configuration.
//
// Nothing here may throw or hang: these run inside Claude Code's statusline and
// hook paths, where a slow script is felt as UI lag on every turn.

import { readFileSync, writeFileSync, appendFileSync, openSync, writeSync, readSync, closeSync, fstatSync, existsSync, readdirSync, constants as C } from 'node:fs';
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
const MISS_TTL_MS  = 30 * 1000;      // ...but retry a miss sooner than that

/** Optional. Only needed to override auto-detection or turn on debug capture. */
export function loadConfig() {
  const cfg = { port: '', debug: false, token: '', configError: '' };
  let text = null;
  try { text = readFileSync(CONFIG_PATH, 'utf8'); } catch { /* absent is normal */ }
  if (text !== null) {
    // Absent and malformed are different problems. Treating them the same threw
    // away the port override, the debug flag and the token in silence - easy to
    // hit on Windows, where the natural thing to paste is a backslash path that
    // is not valid JSON.
    try { Object.assign(cfg, JSON.parse(text)); }
    catch (e) { cfg.configError = e?.message ?? 'invalid JSON'; }
  }
  if (process.env.CLAULED_PORT) cfg.port = process.env.CLAULED_PORT;
  return cfg;
}

export function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    // If nothing is piped in, don't hang the host process waiting for EOF.
    // Resolving is not enough on its own: a stdin in flowing mode keeps a
    // ref'd handle alive, so the event loop would never drain and the process
    // would sit there after its work was finished. Release it explicitly.
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      try { process.stdin.pause(); process.stdin.unref(); } catch { /* already gone */ }
      resolve(buf);
    };
    const guard = setTimeout(finish, 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
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
//
// Every platform matches on the Espressif vendor ID. That matters: a machine
// typically has several USB serial devices - this one has a Logitech receiver
// on COM7 - and "the first serial port" is not a device identity.

/** Windows device path for a COM port: \\.\COM12 (needed above COM9). */
function winPath(com) {
  const B = String.fromCharCode(92);
  return B + B + '.' + B + com;
}

/**
 * Absolute path to PowerShell. Resolving via PATH means a trimmed or reordered
 * PATH turns into a bare ENOENT that gets swallowed as "device not found".
 *
 * pwsh is fine for discovery but NOT for the status probe: PowerShell 7 dropped
 * System.IO.Ports from the box, so the probe needs Windows PowerShell 5.1.
 */
function psExe({ needSerialPort = false } = {}) {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const wps = join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (existsSync(wps)) return wps;
  return needSerialPort ? '' : 'pwsh';
}

function detectWindows() {
  // PowerShell rather than a native module: no dependency, no build step.
  const exe = psExe();
  if (!exe) return '';
  const ps =
    "Get-CimInstance Win32_PnPEntity | " +
    `Where-Object { $_.PNPDeviceID -like '*VID_${ESP_VID}*' -and $_.Name -match 'COM\\d+' } | ` +
    "ForEach-Object { if ($_.Name -match '(COM\\d+)') { $Matches[1] } }";
  const out = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const com = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return com ? winPath(com) : '';
}

/**
 * macOS. `ioreg` is in /usr/sbin on every install and exposes the USB tree with
 * both the vendor ID and the BSD callout name, so no native module is needed.
 *
 * Only /dev/cu.* is ever returned. The matching /dev/tty.* is the dial-in node,
 * and open(2) on it BLOCKS until carrier is asserted - which for a hook running
 * on the UI path means a hang, not an error.
 */
function detectDarwin() {
  const vid = parseInt(ESP_VID, 16);           // 0x303A -> 12346
  let out = '';
  try {
    out = execFileSync('/usr/sbin/ioreg', ['-r', '-c', 'IOUSBHostDevice', '-l'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    out = '';
  }

  // ioreg prints one indented subtree per USB device. Walk it linearly and
  // remember whether the device we are inside matched the vendor, then take the
  // first callout beneath it.
  if (out) {
    let inMatch = false;
    for (const line of out.split('\n')) {
      if (/^\s*\+\-o /.test(line)) inMatch = false;          // a new device subtree
      const v = line.match(/"idVendor"\s*=\s*(\d+)/);
      if (v) inMatch = parseInt(v[1], 10) === vid;
      if (inMatch) {
        const c = line.match(/"IOCalloutDevice"\s*=\s*"([^"]+)"/);
        if (c && c[1].includes('/cu.')) return c[1];
      }
    }
  }

  // Fallback: cu nodes only, sorted so the choice is at least deterministic.
  // This cannot confirm the vendor, so it is a last resort rather than the
  // normal path - see the doctor output, which says so plainly.
  try {
    const hit = readdirSync('/dev')
      .filter((f) => f.startsWith('cu.usbmodem'))
      .sort()[0];
    if (hit) return join('/dev', hit);
  } catch { /* no /dev listing */ }
  return '';
}

/** Linux. sysfs carries the vendor ID next to each tty, so match on it. */
function detectLinux() {
  const byId = '/dev/serial/by-id';
  try {
    if (existsSync(byId)) {
      // by-id names carry the product string, not the numeric VID, so this is
      // a convenience match only - the sysfs check below is the real one.
      const hit = readdirSync(byId).find((f) => /esp|jtag|serial/i.test(f));
      if (hit) return join(byId, hit);
    }
  } catch { /* fall through */ }

  const matches = (name) => {
    try {
      const v = readFileSync(`/sys/class/tty/${name}/device/../idVendor`, 'utf8');
      return v.trim().toLowerCase() === ESP_VID.toLowerCase();
    } catch { return false; }
  };
  try {
    const hit = readdirSync('/dev').filter((f) => f.startsWith('ttyACM')).sort().find(matches);
    if (hit) return join('/dev', hit);
  } catch { /* no /dev listing */ }
  return '';
}

/** Accept "COM8", "\\.\COM8" or a POSIX device path, whatever the platform. */
function normalizePort(p) {
  return platform() === 'win32' && /^COM\d+$/i.test(p) ? winPath(p) : p;
}

/**
 * Resolve the device path. Detection is cached because the statusline runs
 * often and a scan costs over a second - measured at 1.2-1.4 s on Windows.
 * Pass force=true to bypass the cache after a failed write.
 */
export function findPort(force = false) {
  const cfg = loadConfig();
  if (cfg.port) return normalizePort(cfg.port);

  if (!force) {
    try {
      const { path, at, miss } = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
      if (Date.now() - at < (miss ? MISS_TTL_MS : CACHE_TTL_MS)) return miss ? '' : (path || '');
    } catch { /* no usable cache */ }
  }

  let path = '';
  try {
    path = platform() === 'win32' ? detectWindows()
         : platform() === 'darwin' ? detectDarwin()
         : detectLinux();
  } catch { path = ''; }

  // MISSES ARE CACHED TOO. Without this, an unplugged device meant every hook
  // paid for a full enumeration - more than once - before every single tool
  // call, which reads as Claude Code itself having gone slow.
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(
      path ? { path, at: Date.now() } : { miss: true, at: Date.now() },
    ));
  } catch { /* an uncacheable miss is slow, not wrong */ }
  return path;
}

// ── Transport ─────────────────────────────────────────────────

function writeLine(path, line) {
  const buf = Buffer.from(line, 'utf8');

  // Deliberately NOT 'w'. That flag is O_WRONLY|O_CREAT|O_TRUNC, so a wrong or
  // stale path does not fail - it CREATES A REGULAR FILE there, every push
  // then "succeeds" into it, and doctor reports a healthy device that is not
  // plugged in. Without O_CREAT a missing device is an honest ENOENT.
  //
  // O_NOCTTY: never let a serial device become this process's controlling
  // terminal. O_NONBLOCK: only cu.* is ever opened, but a hook runs on the UI
  // path and must not be able to block in open() under any circumstances.
  const flags = platform() === 'win32'
    ? C.O_WRONLY
    : (C.O_WRONLY | C.O_NOCTTY | C.O_NONBLOCK);

  const fd = openSync(path, flags);
  try {
    let off = 0;
    let spins = 0;
    while (off < buf.length) {
      let n;
      try {
        n = writeSync(fd, buf, off, buf.length - off);
      } catch (err) {
        // O_NONBLOCK means a momentarily full CDC transmit buffer surfaces as
        // EAGAIN rather than a wait. Spin briefly, but bounded - 100 ms.
        if ((err?.code === 'EAGAIN' || err?.code === 'EWOULDBLOCK') && spins++ < 20) {
          sleepSync(5);
          continue;
        }
        throw err;
      }
      // A short write is legal on a character device. Ignoring the return value
      // would silently drop the tail, and the device would see a truncated line
      // that fails to parse - an intermittent fault that looks like corruption.
      if (n <= 0) throw Object.assign(new Error('short write'), { code: 'EIO' });
      off += n;
    }
  } finally {
    closeSync(fd);
  }
}

/** Block briefly without pulling in a timer. Only used on a port collision. */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* best effort */ }
}

/**
 * Send one JSON object as a line. Always resolves - never throws, never hangs.
 *
 * Two failure classes need different remedies:
 *   EPERM/EBUSY/EACCES - another process holds the port for an instant. In
 *     practice that is two hooks firing together, or a serial monitor left
 *     open. Re-detecting returns the same port, so it does nothing; a short
 *     wait is what actually helps.
 *   anything else - the device probably moved to a different port, so
 *     re-detect and try again. This is what makes replugging self-heal.
 */
export function push(body) {
  const line = JSON.stringify(body) + '\n';
  const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
  let reason = 'device not found';
  let rescanned = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    // Re-detect AT MOST ONCE per push. A scan costs over a second, and this
    // runs before every tool call - paying for it repeatedly turns an unplugged
    // device into what feels like Claude Code itself hanging.
    const force = attempt > 0 && !rescanned && !BUSY.has(reason);
    if (force) rescanned = true;

    const path = findPort(force);
    if (!path) {
      reason = 'device not found';
      if (rescanned) break;      // already looked again; nothing more to try
      continue;
    }
    try {
      writeLine(path, line);
      return { ok: true, port: path };
    } catch (err) {
      reason = err?.code ?? err?.message ?? 'write failed';
      debugLog('push-error', `${path}: ${reason} (attempt ${attempt + 1})`);
      if (BUSY.has(reason)) sleepSync(25 + attempt * 25);   // 75 ms worst case
    }
  }
  return { ok: false, reason };
}

/**
 * Round-trip probe on POSIX. `stty` puts the line in raw mode so the tty layer
 * does not echo our own write back or buffer the reply by line; the fd is
 * non-blocking so a silent device times out instead of hanging.
 *
 * NOT VERIFIED ON REAL macOS HARDWARE - it is written to fail into the
 * write-only path rather than to hang or to report a false negative.
 */
function probeUnix(path) {
  // BSD stty takes -f, GNU takes -F. CDC ignores line coding, so a failure
  // here is not fatal; try both and carry on regardless.
  for (const flag of ['-f', '-F']) {
    try {
      execFileSync('/bin/stty', [flag, path, 'raw', '-echo'], { timeout: 3000, stdio: 'ignore' });
      break;
    } catch { /* try the other spelling */ }
  }

  let fd;
  try {
    fd = openSync(path, C.O_RDWR | C.O_NOCTTY | C.O_NONBLOCK);
  } catch (err) {
    return { ok: false, port: path, reason: err?.code ?? 'open failed' };
  }

  try {
    const line = Buffer.from(JSON.stringify({ v: 3, cmd: 'status' }) + '\n', 'utf8');
    for (let off = 0, spins = 0; off < line.length; ) {
      try {
        off += writeSync(fd, line, off, line.length - off);
      } catch (err) {
        if (err?.code === 'EAGAIN' && spins++ < 20) { sleepSync(5); continue; }
        throw err;
      }
    }

    const buf = Buffer.alloc(4096);
    let text = '';
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      let n = 0;
      try {
        n = readSync(fd, buf, 0, buf.length, null);
      } catch (err) {
        if (err?.code === 'EAGAIN') { sleepSync(25); continue; }
        throw err;
      }
      if (n <= 0) { sleepSync(25); continue; }
      text += buf.subarray(0, n).toString('utf8');
      for (const l of text.split(/\r?\n/).map((s) => s.trim())) {
        if (!l.startsWith('{')) continue;
        let j;
        try { j = JSON.parse(l); } catch { continue; }
        // Insist on the status shape: a stray {"ok":true} from an earlier push
        // must not be mistaken for a reply to this probe.
        if (j.version !== undefined) return { ok: true, port: path, status: j };
      }
    }
    return { ok: false, port: path, reason: 'no reply within 2.5s' };
  } catch (err) {
    return { ok: false, port: path, reason: err?.code ?? err?.message ?? 'probe failed' };
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
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
    const r = probeUnix(path);
    if (r.ok) return r;
    // A real round trip is preferred, but never let its failure masquerade as
    // an unreachable device - fall back to the write-only signal and say so.
    const w = push({ v: 3, cmd: 'status' });
    return w.ok
      ? { ok: true, port: path, note: `write-only probe (round trip: ${r.reason})` }
      : w;
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
  // System.IO.Ports was dropped from PowerShell 7, so this needs 5.1.
  const exe = psExe({ needSerialPort: true });
  if (!exe) return { ok: false, port: path, reason: 'Windows PowerShell 5.1 not found' };

  try {
    const out = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      timeout: 12000,
      windowsHide: true,
      // Inheriting stderr dumped a raw .NET stack trace into the user's
      // terminal, which doctor then misdiagnosed as "another program is
      // holding the port". Capture it and report the first line instead.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith('{')).pop();
    if (!line) return { ok: false, port: path, reason: 'no reply' };
    return { ok: true, port: path, status: JSON.parse(line) };
  } catch (err) {
    const detail = String(err?.stderr ?? '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
    return { ok: false, port: path, reason: detail || err?.message?.split('\n')[0] || 'probe failed' };
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
    if (o.accessToken) return o.accessToken;
  } catch { /* fall through to the platform store */ }

  // macOS keeps Claude Code's credentials in the login Keychain, not in a
  // file, so the check above finds nothing there however the app is set up.
  // This prompts for Keychain access the first time and is skipped silently if
  // the user declines - the gauge simply stays unavailable.
  if (platform() === 'darwin') {
    try {
      const out = execFileSync(
        '/usr/bin/security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const j = JSON.parse(out.trim());
      return (j.claudeAiOauth || j).accessToken || '';
    } catch { /* not present, or access declined */ }
  }
  return '';
}

/** Where a token would come from on this platform, for diagnostics. */
export function tokenSourceHint() {
  return platform() === 'darwin'
    ? 'the login Keychain ("Claude Code-credentials") or "token" in ~/.clauled.json'
    : '~/.claude/.credentials.json or "token" in ~/.clauled.json';
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

function cacheQuota(data) {
  try { writeFileSync(QUOTA_CACHE, JSON.stringify({ at: Date.now(), data })); } catch {}
}

const pct100 = (n) => Math.max(0, Math.min(100, n));

/**
 * The 5h figure, preferring the statusline payload's own `rate_limits`.
 *
 * Claude Code DOES send rate_limits - contrary to what this file used to
 * claim. It just does not send it on every invocation, so a sampling pass that
 * happened to catch only the reduced payloads concluded it never did. When the
 * block is present it is authoritative and free; the reading is cached so hooks
 * and reduced payloads can still render it, and so the authenticated API call
 * becomes a fallback rather than the only source.
 *
 * Verified: a payload's `five_hour.resets_at` matched the epoch returned by the
 * API's anthropic-ratelimit-unified-5h-reset header exactly.
 */
export function readQuota(d) {
  const rl = d?.rate_limits;
  const five = rl?.five_hour;
  if (five && Number.isFinite(five.used_percentage)) {
    const week = rl?.seven_day;
    const data = {
      pct: pct100(five.used_percentage),
      resetAt: Number.isFinite(five.resets_at) ? five.resets_at : null,
      // Recorded because it costs nothing; the device has no third gauge yet.
      week: week && Number.isFinite(week.used_percentage) ? pct100(week.used_percentage) : null,
      weekResetAt: Number.isFinite(week?.resets_at) ? week.resets_at : null,
      source: 'payload',
    };
    cacheQuota(data);
    return data;
  }
  return readCachedQuota();
}

/**
 * Context occupancy, as {used, size}.
 *
 * The payload's `context_window` block is authoritative when present - it also
 * used to be documented here as always zero, and it is not. The transcript is
 * the fallback, which is what hooks and reduced payloads rely on.
 */
export function readContext(d) {
  const cw = d?.context_window;
  const size = cw?.context_window_size || 0;

  if (size) {
    const cu = cw.current_usage;
    const used = cu
      ? (cu.input_tokens || 0) + (cu.cache_read_input_tokens || 0) + (cu.cache_creation_input_tokens || 0)
      : (cw.total_input_tokens || 0);
    if (used > 0) return { used, size };
  }

  const u = readTranscriptUsage(d?.transcript_path);
  // Without a stated window, 1M is the current default across Claude 5 models.
  if (u) return { used: u.used, size: size || 1_000_000 };
  return null;
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
  // Without a token the refresh cannot succeed, so it never writes a cache, so
  // the cache stays stale, so we would spawn a doomed child process on EVERY
  // statusline render. Check first.
  if (!readToken()) return;
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
// Only `medium` is abbreviated. The device's bottom row has 14 characters for
// the model and effort together, and every real combination fits with the
// level spelled out - "Sonnet 5 xhigh" is exactly 14.
const EFFORT_SHORT = {
  low: 'low',
  medium: 'med',
  high: 'high',
  xhigh: 'xhigh',
  ultra: 'ultra',
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

  // NOTHING BELOW IS EMITTED UNLESS IT WAS ACTUALLY COMPUTED.
  //
  // Claude Code does not send the same payload every time - some invocations
  // arrive with only {model, effort}. Emitting pct:-1 for the missing feeds
  // meant one of those reduced payloads actively overwrote good readings with
  // "--", which is exactly what it looked like on the glass. The device merges,
  // so staying silent leaves the last good value in place; a stale number is
  // far better than a blank one, and the footer already shows staleness.
  const round1 = (n) => Math.round(n * 10) / 10;

  // Labels are short because the device composes them into a single 21-char
  // line with the detail and the percentage: "5h reset 4h33m 55%".
  const quota = readQuota(d);
  if (quota) out.gauge1 = { label: '5h reset', pct: round1(quota.pct) };
  else maybeRefreshQuota();   // only pay for the API when nothing cheaper has it

  const ctx = readContext(d);
  if (ctx) out.gauge2 = { label: 'ctx', pct: round1(Math.min(100, (ctx.used / ctx.size) * 100)) };

  // Detail row pairs each gauge with its most useful companion number. Each
  // side is independent - one feed being unavailable must not blank the other.
  const row = {};
  if (quota?.resetAt) row.left = fmtUntil(quota.resetAt);
  if (ctx) row.right = `${fmtTokens(ctx.used)}/${fmtTokens(ctx.size)}`;
  if (Object.keys(row).length) out.row = row;

  const cost = d?.cost?.total_cost_usd;
  if (typeof cost === 'number') out.footer = { left: '$' + cost.toFixed(2) };

  return out;
}
