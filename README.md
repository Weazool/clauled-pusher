# clauled-pusher

A Claude Code plugin that pushes your subscription usage and "Claude needs you" events to a [Clauled](https://github.com/Weazool/clauled) ESP32 desk display over USB.

```
Claude Code ──statusline──▶ usage %                  ┐
            ──hooks──────▶ activity + events        ├──▶ JSON lines over USB ──▶ Clauled ──▶ OLED
```

The device holds no credentials of any kind, and neither does the plugin.

## Requirements

- A Clauled device on USB, running **v4.0.0** or later
- Claude Code (Node 18+ is already a requirement of it)
- A **data** USB cable — charge-only cables power the board but never enumerate it

**Firmware v4.0.0 is required, not merely recommended.** This plugin speaks wire schema v4, and the device accepts exactly one schema — older firmware rejects every push with `unsupported schema version` and shows nothing. Both move together, which is why their major versions match the schema they speak.

Windows, macOS and Linux, no npm dependencies. Serial writes go through Node's built-in `fs`, and the device is located with tools already present on each platform — PowerShell CIM on Windows, `ioreg` on macOS, sysfs on Linux.

## Install

```bash
node bin/install.mjs
```

Writes a shim to `~/.clauled/` and points `statusLine` at it in `~/.claude/settings.json` — a plugin can't ship `statusLine` itself, so this one step is unavoidable. The shim resolves whichever copy of the plugin is currently installed, so it survives updates without needing a version-pinned path. Backs up your settings first; refuses to clobber a different `statusLine` without `--force`.

| Flag | Effect |
|---|---|
| `--print` | show the JSON, write nothing |
| `--force` | replace a `statusLine` that is not ours |
| `--uninstall` | remove ours, leave everything else alone |

```bash
node bin/doctor.mjs
```

Run this before debugging anything else — it isolates "device not reachable" from "the hook never fired." Hooks need no setup; they ship inside the plugin.

## Plug and play

Found by Espressif USB vendor ID (`303A`), not a fixed port — move it to a different socket and it keeps working. Discovery is cached 5 minutes; a failed write re-detects once and retries.

`~/.clauled.json` overrides detection or enables optional behaviour, all fields optional:

```json
{ "port": "", "debug": false, "token": "", "quietStart": 0, "quietEnd": 6 }
```

`CLAULED_PORT`, `CLAULED_DEBUG`, `CLAULED_TOKEN` override the file.

**macOS:** class-compliant USB CDC, no driver needed. Check with `ls /dev/cu.usbmodem*` — always `cu.*`, never `tty.*` (the latter blocks on open).

## Quiet hours

The device has no clock, so this plugin computes "is it currently quiet hours" from local time and sends it on every push; the device only tracks idle duration. Default midnight–6am, 15 min idle threshold, panel powers fully off once both are true.

```json
{ "quietStart": 23, "quietEnd": 7 }
```

`quietEnd` is exclusive; an end at or before start wraps past midnight (`23`/`7` = 11pm–7am). Any push wakes the device immediately.

## What gets pushed

| Source | Trigger | Adds |
|---|---|---|
| statusline | every render | — (the only source with the model) |
| `UserPromptSubmit` | you hit enter | spinner with a gerund — `Discombobulating` |
| `PreToolUse` | before each tool | the activity — `Running Bash`, `Editing main.cpp` |
| `PreToolUse` | a tool that waits for *you* | inverted banner — `Review plan`, `Answer question` |
| `Stop` | Claude finished | inverted banner — `Your turn` |
| `Notification` | needs permission or input | inverted banner — `Claude needs input` |

Most tools mean Claude is working, so they get a spinner. A few — `ExitPlanMode`, `AskUserQuestion` — mean the opposite: the tool's execution *is* the prompt, so `PreToolUse` fires exactly when your attention starts being needed. Those raise a banner instead, and clear when your next turn starts.

Every trigger pushes the **full display** — session, model, effort, both quota readings, context, quiet-hours state — not just the field it exists to add, so nothing goes stale between renders. The one exception is the model: hook payloads never carry it, so it's recovered from the transcript or a per-session cache instead (see **Multiple sessions** below).

Labels stay short (`5h`, `1w`, `ctx`) — the device composes each into one line with its detail and percentage. Note the label is not the field name: the weekly quota is sent as `quota7d`, which is what every upstream source calls it, and labelled `1w`, which is what fits in two characters. A field that can't be computed is omitted, never sent as a placeholder; the device merges, so an omitted field just keeps its last value.

## Multiple sessions

Every push is tagged with `sid`, an 8-character key derived from Claude Code's own `session_id`. The device tracks up to 8 concurrent sessions from that tag alone — no coordination needed on this side — and cycles through all of them in turn, every 6 seconds. See the firmware's [API.md](https://github.com/Weazool/clauled/blob/main/API.md) for the exact rotation and roster rules.

The one thing this plugin does own per session: the **model cache**. Hook payloads never carry the model, only the statusline's do, so each session's last-known model is cached separately, keyed by its own `sid` — otherwise session A's model would leak into session B's display the moment they run different ones. If a session's statusline never renders at all — some environments never invoke it — the model instead falls back to whatever the session transcript last recorded, so the footer still isn't left blank.

## The two account quotas

Both are the same value for every session under this login — sent globally, not per-session.

**5h and weekly (1w) quota** — from the payload's `rate_limits` block (`five_hour` and `seven_day`), no credential needed. Sent on some renders, not all, so the reading is cached.

But only the **statusline** payload carries `rate_limits`, and some setups never invoke the statusline at all — in which case a token is the only way either figure ever appears. It covers **both**: the `anthropic-ratelimit-unified-5h-*` and `-7d-*` headers come back in the same response. A stale reading is refreshed in the background on any push, so the numbers keep tracking reality rather than freezing at whatever arrived first.

```bash
claude setup-token
```
```json
{ "token": "sk-ant-oat01-..." }
```

A real credential, `user:inference` scope, valid a year — `chmod 600` the file. Prefer going without **if** your statusline actually renders; if it doesn't, this is the only source of either reading.

**Context** — per-session, from the payload's `context_window` when present, else the session transcript.

**Model** — per-session, from the payload when present, else the newest assistant message in the session transcript, else this session's own cached value. In that order: the transcript beats the cache so that switching models mid-session is picked up rather than pinned to whatever was seen first.

## Files this creates

| File | Keep or delete |
|---|---|
| `~/.clauled.json` | **Keep** — your config (token, port, quiet hours) |
| `~/.clauled/statusline.mjs` | **Keep** — the installed shim; `settings.json` points at it |
| `~/.clauled-port`, `~/.clauled-quota.json`, `~/.clauled-models.json` | Caches — safe to delete, regenerate within seconds |
| `~/.clauled-quota-refreshing` | A lock file, self-expires in 15s — safe to delete anytime |
| `~/.clauled-debug.log` | Only exists when `"debug": true` — delete freely, **check contents before sharing** (prompts, file paths) |
| `~/.claude/settings.json.clauled-backup` | A one-time safety backup from `install.mjs` — harmless to keep or delete |

## Testing without the device

```bash
node bin/selftest.mjs
```

Runs the real scripts against a synthetic transcript and a throwaway home directory, asserting on the exact bytes written.

## Troubleshooting

**`doctor` says no device found.** Check the cable carries data.

**`no reply` from the status probe.** Another program is holding the port — close any serial monitor.

**The 5h row shows `--`.** No `rate_limits` seen yet; arrives on a later render, or configure a token.

**The context row shows `--`.** No transcript yet — normal in the first seconds of a session.

**Screen is completely dark.** Run `doctor` — reports whether it's quiet-hours power-down (`quiet_sleep: true`) rather than unreachable. Any push wakes it.

**Hooks never fire on macOS.** Likely `node` isn't on the `PATH` Claude Code inherited (a Finder/Dock launch uses launchd's, not your shell's). `doctor` checks this; launching from a terminal is the quickest confirmation.

**Hooks never fire otherwise.** Test directly: `echo "{}" | node bin/event.mjs stop`. If that pushes successfully, the problem is hook registration — restart Claude Code after a plugin update, a new chat isn't enough.

## License

MIT.
