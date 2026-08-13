# clauled-pusher

A Claude Code plugin that pushes your subscription usage and "Claude needs you" events to a [Clauled](https://github.com/Weazool/clauled) ESP32 desk display over USB.

```
Claude Code ──statusline──▶ usage %                  ┐
            ──hooks──────▶ activity + events        ├──▶ JSON lines over USB ──▶ Clauled ──▶ OLED
```

The device holds no credentials of any kind, and neither does the plugin.

## Requirements

- A Clauled device on USB, running **v3.3.0** or later
- Claude Code (Node 18+ is already a requirement of it)
- A **data** USB cable — charge-only cables power the board but never enumerate it

Windows, macOS and Linux. No npm dependencies: serial writes go through Node's built-in `fs`, and the device is located with tools already present on each platform — PowerShell CIM on Windows, `ioreg` on macOS, sysfs on Linux. There is no native `serialport` module to build.

## Install

Install the plugin, then run the one setup step:

```bash
node bin/install.mjs
```

That writes a small shim to `~/.clauled/` and points `statusLine` at it in `~/.claude/settings.json`. It backs the file up first, refuses to clobber a status line that is not ours without `--force`, and then **runs the command through the same shells Claude Code uses** to prove it works rather than assuming it will.

| Flag | Effect |
|---|---|
| `--print` | show the JSON, write nothing |
| `--force` | replace a `statusLine` that is not ours |
| `--uninstall` | remove ours, leave everything else alone |

Then check the device:

```bash
node bin/doctor.mjs
```

`doctor` isolates "device not reachable" from "the hook never fired", which are very different problems. Run it before debugging anything else.

**Hooks need no setup** — they ship inside the plugin.

### Why the statusline needs a step at all

A plugin cannot ship a `statusLine`. Plugin `settings.json` is validated against a schema that keeps only `agent` and `subagentStatusLine`; every other key, `statusLine` included, is silently discarded. So the entry has to live in your own settings.

### Why a shim rather than a direct path

Because there is no directory that is both current and stable:

| Path | Problem |
|---|---|
| `plugins/cache/<market>/<plugin>/<version>/` | version-pinned in the path, and swept roughly 14 days after being superseded |
| `plugins/marketplaces/<name>/` | stable path, but tracks branch HEAD — so it drifts ahead of the version your hooks actually run |

Point `settings.json` at either and you get a status line that works until abruptly it does not — or, worse, one running different code from your hooks. The shim lives at a path this project owns and resolves the installed plugin at run time, preferring exactly what the hooks use. `doctor` warns if your `statusLine` points into a plugin directory.

The installer also bakes the **absolute** path of your Node interpreter into the command. That is not fussiness: on macOS, launching Claude Code from Finder or the Dock gives it launchd's environment rather than the one your shell builds, so a Homebrew or nvm `node` is not on `PATH` and a bare `node` fails silently. Claude Code exports no variable pointing at an interpreter, so recording the one that ran the installer is the only reliable answer. After a Node upgrade, re-run `install.mjs`; `doctor` checks that the path still exists.

## Plug and play

The device is found by its Espressif USB vendor ID (`303A`) on every platform, not by a hardcoded port. **Move it to a different USB socket and it keeps working.** That matters more than it sounds: a typical machine has several USB serial devices, so "the first serial port" is not a device identity.

Discovery is cached for five minutes, because a scan costs over a second. Misses are cached too, for thirty seconds — without that, an unplugged device made every hook pay for a full enumeration before every tool call, which reads as Claude Code itself having gone slow. A failed write re-detects once and retries, so replugging recovers by itself.

You only need `~/.clauled.json` to override detection or enable optional behaviour:

```json
{ "port": "", "debug": false, "token": "" }
```

`CLAULED_PORT`, `CLAULED_DEBUG` and `CLAULED_TOKEN` override the file. A malformed config is reported by `doctor` rather than silently ignored.

### macOS notes

The board is class-compliant USB CDC, so no driver is needed. The manual check is:

```bash
ls /dev/cu.usbmodem*
```

Always the `cu.*` node, never `tty.*`. The `tty.*` device is the dial-in side, and `open()` on it **blocks until carrier is asserted** — in a hook, that is a hang rather than an error. The pusher only ever opens `cu.*`, and opens it with `O_NOCTTY | O_NONBLOCK` so it cannot block under any circumstances.

## What gets pushed

| Source | Trigger | Shows on the device |
|---|---|---|
| statusline | every render | both gauges, header, detail row, cost |
| `UserPromptSubmit` | you hit enter | spinner with a gerund — `Discombobulating` |
| `PreToolUse` | before each tool | the activity — `Running Bash`, `Editing main.cpp` |
| `Stop` | Claude finished | inverted banner — `Your turn` |
| `Notification` | needs permission or input | inverted banner — `Claude needs input` |

The device merges pushes, so a hook sending only `busy` never wipes the gauges. It lays out each gauge row itself in three columns — label left, paired detail centred, percentage right — which is why the labels sent here are short (`5h reset`, `ctx`).

The four identity fields go to four corners: `session` top-left, `title` (the model) top-right, `footer.left` (cost) bottom-left, `footer.right` (effort) bottom-right. `session_name` is rarely sent by Claude Code, so the workspace directory name is used instead — which is usually what you want anyway, since it names the project.

**A field that could not be computed is omitted, never sent as "no data".** Claude Code does not send the same payload on every invocation — some carry only `{model, effort}`. Emitting a placeholder for the missing feeds meant one of those reduced payloads actively overwrote good readings with `--`. Staying silent leaves the last good value on the glass.

**The gerunds are ours, not Claude Code's.** Its real spinner vocabulary is not exposed to hooks, so these are in the same spirit but will not match your terminal.

## The two gauges

They come from different places and fail independently.

**Context** — from the payload's `context_window` block when present, computed from the session transcript otherwise. The transcript path matters because the statusline renders *before* the turn's usage block is written, so the `Stop` hook recomputes it. Only the last 256 KB is read, so it stays fast on multi-megabyte transcripts.

**5h subscription quota** — from the payload's `rate_limits` block. Free, no credentials, and it carries `seven_day` too.

Claude Code sends `rate_limits` on some statusline invocations but not all, so the reading is cached and carried forward. If your setup never sends it, an OAuth token is available as a **fallback**:

```bash
claude setup-token
```

```json
{ "token": "sk-ant-oat01-..." }
```

Be clear-eyed about that trade: it is a real credential with `user:inference` scope, valid for a year, in a plaintext file in your home directory. `chmod 600` it, and prefer going without — the payload path needs no secret at all. On macOS the plugin also reads Claude Code's own credentials from the login Keychain, since there is no credentials file there.

## Testing without the device

```bash
node bin/selftest.mjs
```

Points `CLAULED_PORT` at a temp file, runs the real scripts against a synthetic transcript, and asserts on the exact bytes they write. It runs against **its own throwaway home directory** — otherwise the results depend on whether the machine happens to have a token configured, which is how one assertion passed for months while testing nothing.

## What Claude Code actually sends

Captured live. Worth recording, because two earlier conclusions here were wrong and shaped the design badly:

- **`rate_limits` does exist**, with `five_hour` and `seven_day`, each carrying `used_percentage` and `resets_at`. It was previously documented as absent — a conclusion drawn from sampling only the reduced payloads. A payload's `resets_at` matches the epoch from the API's rate-limit headers exactly.
- **`context_window` does populate**, with `context_window_size`, `total_input_tokens` and a `current_usage` breakdown. Also previously documented as always zero.
- **The payload shape varies per invocation.** Anywhere from 16 keys down to `{model, effort}`. Nothing may assume a field is present.
- Hook payloads carry `effort` but **not** `model`, so the model is cached from whoever has it.

To capture payloads yourself, set `"debug": true` in `~/.clauled.json` — effective on the next render, nothing to restart. **That log contains whatever Claude Code sends, including file paths and prompts. Check it before sharing.**

## Why Node rather than shell scripts

Claude Code runs hook and statusline commands through a shell — `/bin/sh` on macOS, Git Bash on Windows with PowerShell as a fallback. A Node entry point is the one form that works identically under all three, with no polyglot wrapper and no `.cmd` shim.

It also avoids a quoting trap. `"C:/Program Files/nodejs/node.exe" script.mjs` runs under sh, Git Bash and cmd — but PowerShell treats a leading quoted token as a *string literal* and prints it instead, producing no status line and no error. The installer sidesteps this by emitting an unquoted, space-free path, using the DOS 8.3 alias on Windows when necessary, and verifies the result under every shell it can find.

## Troubleshooting

**`doctor` says no device found.** Check the cable carries data, and that the board enumerates with vendor ID `303A`.

**`no reply` from the status probe.** Another program is probably holding the port. Close `pio device monitor` or any serial terminal; only one process can own it.

**Gauge 1 shows `--`.** No `rate_limits` seen yet. One will arrive on a later render; a token is only needed if it never does.

**Gauge 2 shows `--`.** No transcript and no `context_window` yet — normal in the first seconds of a session.

**Hooks never fire on macOS.** Most likely `node` is not on the `PATH` Claude Code inherited. `doctor` checks this. Launching Claude Code from a terminal is the quickest confirmation.

**Hooks never fire otherwise.** Confirm the plugin is enabled, then test the script directly:

```bash
echo "{}" | node bin/event.mjs stop
```

If that pushes successfully, the script is fine and the problem is hook registration. Hooks register at app **startup**, so a plugin update needs a restart, not just a new chat.

## License

MIT.
