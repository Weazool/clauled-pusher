#!/usr/bin/env node
// Wire the Clauled statusline into ~/.claude/settings.json.
//
//   node bin/install.mjs              wire it up
//   node bin/install.mjs --print      show what would be written, change nothing
//   node bin/install.mjs --force      replace a statusLine that is not ours
//   node bin/install.mjs --uninstall  remove ours, leave everything else alone
//
// Hooks ship inside the plugin and need no setup. A statusLine cannot: plugin
// settings.json accepts only `agent` and `subagentStatusLine`, so the entry has
// to live in the user's own settings. This script is that step, done safely.
//
// WHY A SHIM RATHER THAN A DIRECT PATH
//
// There is no directory Claude Code guarantees to be both current and stable:
//
//   plugins/cache/<market>/<plugin>/<version>/   version-pinned in the path, and
//                                               swept ~14 days after superseding
//   plugins/marketplaces/<name>/                 stable path, but tracks branch
//                                               HEAD - so it drifts ahead of the
//                                               version the hooks actually run
//
// Writing either into settings.json produces a status line that works until it
// abruptly does not. So install a shim at a path this project owns, and let it
// resolve the live plugin at run time - preferring exactly what the hooks use.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, copyFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';

const HOME        = homedir();
const PLUGIN_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const CLAULED_DIR = join(HOME, '.clauled');
const SHIM        = join(CLAULED_DIR, 'statusline.mjs');
const SETTINGS    = join(HOME, '.claude', 'settings.json');
const BACKUP      = join(HOME, '.claude', 'settings.json.clauled-backup');

const args      = process.argv.slice(2);
const isPrint   = args.includes('--print');
const isForce   = args.includes('--force');
const isRemove  = args.includes('--uninstall');

// Forward slashes throughout: valid for node.exe, and unambiguous in Git Bash,
// PowerShell and sh alike. It also needs no escaping inside JSON, which a
// Windows backslash path very much does.
const fwd = (p) => p.replace(/\\/g, '/');

// The ABSOLUTE interpreter, not a bare `node`.
//
// Claude Code runs the statusline through a shell that inherits its own
// environment. On macOS, launching the app from Finder or the Dock gives it
// launchd's PATH - not the one your .zshrc builds - so a Homebrew or nvm node
// is simply not on it, and a bare `node` fails with nothing written anywhere.
// Claude Code exports no variable pointing at an interpreter, so the only
// reliable answer is to record the one that is running right now.
//
// If you later remove or relocate this node, re-run install.mjs; doctor checks
// that this path still exists.
// Quoting is the other half of the problem, and it is genuinely hostile:
//
//   sh / Git Bash / cmd   "C:/Program Files/nodejs/node.exe" arg   works
//   PowerShell            same string                              PRINTS it
//
// PowerShell treats a leading quoted token as a string literal, not a command,
// so a quoted interpreter path silently produces no status line at all. An
// UNQUOTED path is a command in every one of those shells - it just cannot
// contain a space. So prefer a space-free path, using the DOS 8.3 alias on
// Windows when the natural path has a space in it.
function spaceFree(p) {
  if (!p.includes(' ')) return p;
  if (platform() !== 'win32') return '';
  try {
    // execSync, not execFileSync: Node quotes each argv entry on Windows, and
    // cmd.exe then mis-parses the `%I` / `%~sI` tokens. A verbatim command
    // string is the only form cmd handles correctly here.
    const out = execSync(
      'for %I in ("' + p.replace(/\//g, '\\') + '") do @echo %~sI',
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (out && !out.includes(' ') && existsSync(out)) return fwd(out);
  } catch { /* 8.3 names can be disabled per volume */ }
  return '';
}

const NODE_RAW  = fwd(process.execPath);
const NODE_SAFE = spaceFree(NODE_RAW);
const SHIM_SAFE = spaceFree(fwd(SHIM));

// Fall back to quoting only when no space-free form exists. That still works
// under sh, Git Bash and cmd - which is what Claude Code actually prefers - and
// only fails on the PowerShell fallback, which the installer reports below.
const NODE = NODE_SAFE || `"${NODE_RAW}"`;
const SHIM_ARG = SHIM_SAFE || `"${fwd(SHIM)}"`;
const COMMAND = `${NODE} ${SHIM_ARG}`;
const FULLY_PORTABLE = Boolean(NODE_SAFE && SHIM_SAFE);

// Anything carrying this marker is ours and may be repointed without asking.
const MARK = 'clauled';

const say = (m) => console.log(m);

// ── The shim ──────────────────────────────────────────────────

function shimSource() {
  return `// Generated by clauled-pusher: node bin/install.mjs
//
// Resolves whichever copy of the plugin Claude Code currently has installed and
// hands off to its statusline. Do not point settings.json at a plugin path
// directly - those paths are version-pinned or garbage-collected. Safe to
// delete this file; re-run install.mjs to recreate it.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = homedir();

function candidates() {
  const out = [];

  // 1. What Claude Code has installed - the same code the hooks run, so the
  //    status line and the hooks can never disagree about their version.
  try {
    const reg = JSON.parse(readFileSync(join(HOME, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [key, entries] of Object.entries(reg.plugins ?? {})) {
      if (!key.startsWith('clauled-pusher@')) continue;
      for (const e of entries ?? []) if (e?.installPath) out.push(join(e.installPath, 'bin', 'statusline.mjs'));
    }
  } catch { /* not installed as a plugin */ }

  // 2. The checkout install.mjs was run from - covers development, and a
  //    plugin that has been removed but whose statusLine entry survives.
  out.push(${JSON.stringify(fwd(join(PLUGIN_ROOT, 'bin', 'statusline.mjs')))});

  return out;
}

const target = candidates().find(existsSync);

if (!target) {
  // Never print nothing: that would blank the user's status line entirely.
  process.stdout.write('clauled: plugin not found');
  process.exit(0);
}

await import(pathToFileURL(target).href);
`;
}

// ── settings.json ─────────────────────────────────────────────

function readSettings() {
  if (!existsSync(SETTINGS)) return {};
  const text = readFileSync(SETTINGS, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    // Never rewrite a file we could not parse - that is how configuration gets
    // destroyed. Stop and let the user fix it.
    say(`\nERROR  ${SETTINGS} is not valid JSON:`);
    say(`       ${e.message}`);
    say('       Fix it and re-run. Nothing has been written.\n');
    process.exit(1);
  }
}

/** Write via a temp file and rename, so an interrupted run cannot truncate. */
function writeSettings(obj) {
  mkdirSync(dirname(SETTINGS), { recursive: true });
  const tmp = SETTINGS + '.clauled-tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, SETTINGS);
}

// ── Run ───────────────────────────────────────────────────────

say('\nclauled-pusher install\n');

if (isPrint) {
  say('Add this to ' + SETTINGS + ':\n');
  say(JSON.stringify({ statusLine: { type: 'command', command: COMMAND } }, null, 2));
  say('\n(--print writes nothing. Run without it to apply.)\n');
  process.exit(0);
}

const settings = readSettings();
const existing = settings.statusLine;
const existingCmd = typeof existing?.command === 'string' ? existing.command : '';
const isOurs = existingCmd.includes(MARK);

if (isRemove) {
  if (!existing) { say('  --    no statusLine configured; nothing to remove\n'); process.exit(0); }
  if (!isOurs && !isForce) {
    say(`  skip  statusLine is not ours, leaving it alone: ${existingCmd}`);
    say('        use --force if you really want it removed\n');
    process.exit(1);
  }
  if (existsSync(SETTINGS)) copyFileSync(SETTINGS, BACKUP);
  delete settings.statusLine;
  writeSettings(settings);
  say(`  ok    statusLine removed (backup: ${BACKUP})`);
  say('        the shim at ' + SHIM + ' was left in place\n');
  process.exit(0);
}

if (existing && !isOurs && !isForce) {
  say('  FAIL  a different statusLine is already configured:');
  say(`          ${existingCmd}`);
  say('        Clauled prints "5h 23%  ctx 74%", so it would replace what you see.');
  say('        Re-run with --force to replace it, or --print to merge by hand.\n');
  process.exit(1);
}

// 1. shim
mkdirSync(CLAULED_DIR, { recursive: true });
writeFileSync(SHIM, shimSource());
say(`  ok    shim written to ${SHIM}`);

// 2. settings
if (existsSync(SETTINGS)) copyFileSync(SETTINGS, BACKUP);
settings.statusLine = { type: 'command', command: COMMAND };
writeSettings(settings);
say(`  ok    statusLine ${existing ? 'updated' : 'added'} in ${SETTINGS}`);
if (existsSync(BACKUP)) say(`        previous file backed up to ${BACKUP}`);

// 3. Prove the command runs THROUGH A SHELL, rather than asserting it will.
//
// Claude Code hands the string to a shell - /bin/sh on macOS, Git Bash on
// Windows with PowerShell as the fallback - so running the shim directly would
// verify the wrong thing and miss every quoting fault.
function shells() {
  const list = [];
  if (platform() === 'win32') {
    for (const p of [
      process.env.CLAUDE_CODE_GIT_BASH_PATH,
      'C:/Program Files/Git/bin/bash.exe',
      'C:/Program Files/Git/usr/bin/bash.exe',
      join(process.env.LOCALAPPDATA || '', 'Programs/Git/bin/bash.exe'),
    ]) {
      if (p && existsSync(p)) { list.push({ name: 'Git Bash', exe: p, args: ['-c'] }); break; }
    }
    const wps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(wps)) list.push({ name: 'PowerShell', exe: wps, args: ['-NoProfile', '-NonInteractive', '-Command'] });
  } else {
    list.push({ name: '/bin/sh', exe: '/bin/sh', args: ['-c'] });
  }
  return list;
}

const PROBE = JSON.stringify({ model: { display_name: 'Opus 5' }, effort: { level: 'medium' } });
let anyOk = false;

for (const sh of shells()) {
  try {
    const out = execFileSync(sh.exe, [...sh.args, COMMAND], {
      input: PROBE, encoding: 'utf8', timeout: 15000, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // PowerShell echoing the command back is the classic silent failure: it
    // exits 0, so only the content distinguishes it from success.
    if (out && !out.includes(SHIM.replace(/\\/g, '/')) && !out.includes(SHIM)) {
      say(`  ok    runs under ${sh.name}: prints ${JSON.stringify(out)}`);
      anyOk = true;
    } else {
      say(`  warn  ${sh.name} did not execute it (printed it instead)`);
    }
  } catch (e) {
    say(`  warn  ${sh.name} failed: ${String(e?.message ?? '').split('\n')[0]}`);
  }
}

if (!anyOk) {
  say('\n  FAIL  the command did not run under any available shell.');
  say('        settings.json was updated; run `node bin/doctor.mjs` to diagnose,');
  say(`        or restore ${BACKUP}\n`);
  process.exit(1);
}

if (!FULLY_PORTABLE) {
  say('  note  the interpreter path contains a space and has no 8.3 alias, so');
  say('        the command is quoted. That is fine under sh, Git Bash and cmd.');
}

say('\nClaude Code picks settings.json up on its own - no restart needed.');
say('Hooks need no setup; they ship inside the plugin.\n');
