# clauled-pusher

A Claude Code plugin that pushes your subscription usage and "Claude needs you" events to a [Clauled](https://github.com/Weazool/clauled) ESP32 desk display over USB.

```
Claude Code ──statusline──▶ usage %       ┐
            ──Stop/Notification hooks──▶ events  ├──▶ JSON lines over USB ──▶ Clauled ──▶ OLED
```

The device holds no credentials of any kind. The plugin needs none either, unless you opt into the 5h subscription gauge — see below.

## Requirements

- A Clauled device on USB, running v3.0.0 or later
- Claude Code (Node 18+ is already a requirement of it)
- A **data** USB cable — charge-only cables power the board but never enumerate it

No npm dependencies. Serial writes go through Node's built-in `fs`, and port discovery shells out to PowerShell on Windows — there is no native `serialport` module to build.

## Install

```bash
git clone https://github.com/Weazool/clauled-pusher
```

Add it as a plugin directory in Claude Code, then verify the device:

```bash
node bin/doctor.mjs
```

That checks port discovery, does a round-trip status probe, and sends test pushes. Run it before debugging anything else — it isolates "device not reachable" from "the hook never fired", which are very different problems.

### Wire up the statusline

**This step is manual and unavoidable.** A plugin cannot ship a `statusLine` — plugin `settings.json` supports only the `agent` and `subagentStatusLine` keys. Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/clauled-pusher/bin/statusline.mjs\""
  }
}
```

The statusline prints `5h 23%  ctx 74%` back to Claude Code, so it replaces whatever status line you currently have. If you already have one, merge the two rather than overwriting.

Events need no manual step — the `Stop` and `Notification` hooks ship inside the plugin.

## Plug and play

The device is found by its Espressif USB vendor ID (`303A`), not by a hardcoded port. **Move it to a different USB socket and it keeps working** — no configuration to update.

Discovery is cached for five minutes so the statusline does not pay for a scan on every render. If a write fails, the port is re-detected immediately and the push retried once, so replugging recovers by itself without waiting for the cache to expire.

You only need `~/.clauled.json` to override detection or enable optional features:

```json
{ "port": "COM8", "debug": false, "token": "" }
```

`CLAULED_PORT`, `CLAULED_DEBUG` and `CLAULED_TOKEN` in the environment override the file.

## What gets pushed

| Source | Hook / trigger | Shows on the device |
|---|---|---|
| statusline | every render | both gauges, header, detail row, cost |
| `UserPromptSubmit` | you hit enter | spinner with a gerund — `Discombobulating` |
| `PreToolUse` | before each tool | spinner with the activity — `Running Bash`, `Editing main.cpp` |
| `Stop` | Claude finished | inverted banner — `Your turn` |
| `Notification` | needs permission or input | inverted banner — `Claude needs input` |

`Stop` and `Notification` are the events that mean "Claude is asking me something". `UserPromptSubmit` would be wrong for that — it fires when *you* submit, i.e. when you are already at the keyboard.

The device merges pushes, so a hook sending only `busy` never wipes the gauges, and the statusline never clears the spinner.

**The gerunds are ours, not Claude Code's.** Its real spinner vocabulary is not exposed to hooks, so these are in the same spirit but will not match your terminal.

## The two gauges

They come from different places and fail independently.

**Context** — computed from the session transcript on every render. Sums `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens` from the newest `message.usage` block, over `context_window_size`. Free, live, no credentials. Only the last 256 KB of the transcript is read, so it stays fast on multi-megabyte files.

**5h subscription quota** — needs an authenticated API call, and is **off by default**. Claude Code exposes subscription limits nowhere locally: not in the statusline payload, not in the transcript. The only source is the `anthropic-ratelimit-unified-5h-*` response headers.

Without a token, gauge 1 shows `--` and everything else works normally.

To enable it, create a token and put it in `~/.clauled.json`:

```bash
claude setup-token
```

```json
{ "token": "sk-ant-oat01-..." }
```

Be clear-eyed about that trade: it is a real credential with `user:inference` scope, valid for a year, sitting in a plaintext file in your home directory. It never reaches the device — but it is a genuine secret on your PC, and the device works fine without it.

The quota is cached for five minutes and refreshed by a **detached** child process, so the statusline never waits on the network. One minimal API request per refresh, which consumes a sliver of the very quota it reports.

## Testing without the device

```bash
node bin/selftest.mjs
```

Points `CLAULED_PORT` at a temp file, runs the real scripts against a synthetic transcript, and asserts on the exact bytes they write — context maths, the model-and-effort header, tool-name mapping, and that a garbage payload pushes nothing.

## What Claude Code actually sends

Verified against v2.1.231 by capturing live payloads. Worth recording, because it shaped the design:

- **There is no `rate_limits` object.** Subscription limits are not in the statusline payload, and not in the transcript either — every top-level key was enumerated. They exist only behind an authenticated API call.
- **`context_window` in the payload is always zero.** `total_input_tokens`, `used_percentage` and `remaining_percentage` never populate, even on a session with real activity. The transcript is the usable source.
- What *is* there: `transcript_path`, `model`, `effort`, `cost`, `workspace`, `session_id`, `version`.

To capture payloads yourself, set `"debug": true` in `~/.clauled.json` — it takes effect on the very next render, with nothing to restart. Raw stdin from every statusline and hook invocation is appended to `~/.clauled-debug.log`.

**That log contains whatever Claude Code sends, including file paths and prompts. Check it before sharing.**

## Why Node rather than shell scripts

On Windows, Claude Code runs hook commands through **CMD.exe**. `.sh` files don't execute, `$VAR` doesn't expand, and `bash` isn't on PATH even with Git installed — which is why some plugins ship polyglot `.cmd` wrappers.

`node` is on PATH on every platform, and `${CLAUDE_PLUGIN_ROOT}` is substituted by Claude Code before the shell sees the command. So a Node entry point is cross-platform with no wrapper.

## Troubleshooting

**`doctor` says no device found.** Check the cable carries data, and that the board enumerates — it should appear as a USB serial device with vendor ID `303A`.

**`no reply` from the status probe.** Another program is probably holding the port. Close `pio device monitor` or any serial terminal; only one process can own a COM port.

**Gauge 1 shows `--`.** No token configured, so the 5h figure is unavailable. Expected unless you opted in.

**Gauge 2 shows `--`.** The transcript could not be read, or it has no usage blocks yet — normal in the first seconds of a fresh session.

**Hooks never fire.** Confirm the plugin is enabled, then test the script directly:

```bash
echo "{}" | node bin/event.mjs stop
```

If that pushes successfully, the script is fine and the problem is hook registration.

## License

MIT.
