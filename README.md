# clauled-pusher

A Claude Code plugin that pushes your subscription usage and "Claude needs you" events to a [Clauled](https://github.com/Weazool/clauled) ESP32 desk display over USB.

```
Claude Code ──statusline──▶ usage %       ┐
            ──Stop/Notification hooks──▶ events  ├──▶ JSON lines over USB ──▶ Clauled ──▶ OLED
```

No credentials anywhere in the system. The device holds none, and this plugin holds none — usage comes from data Claude Code already hands its statusline.

## Requirements

- A Clauled device on USB, running v2.0.0 or later
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

The statusline prints `5h 23%  7d 41%` back to Claude Code, so it replaces whatever status line you currently have. If you already have one, merge the two rather than overwriting.

Events need no manual step — the `Stop` and `Notification` hooks ship inside the plugin.

## Plug and play

The device is found by its Espressif USB vendor ID (`303A`), not by a hardcoded port. **Move it to a different USB socket and it keeps working** — no configuration to update.

Discovery is cached for five minutes so the statusline does not pay for a scan on every render. If a write fails, the port is re-detected immediately and the push retried once, so replugging recovers by itself without waiting for the cache to expire.

You only need `~/.clauled.json` if you want to override detection:

```json
{ "port": "COM8" }
```

`CLAULED_PORT` in the environment overrides both.

## What gets pushed

| Source | Trigger | Payload |
|---|---|---|
| statusline | Every statusline render | `usage` — 5h / 7d percentages and reset countdowns |
| `Stop` hook | Claude finished its turn | `{"type":"attention","text":"Claude finished - your turn"}` |
| `Notification` hook | Claude wants permission or input | `{"type":"attention","text":"Claude needs input"}` |

`Stop` and `Notification` are the two events that mean "Claude is asking me something". `UserPromptSubmit` would be wrong — it fires when *you* submit, i.e. when you are already at the keyboard.

The device merges pushes, so an events-only push never wipes the usage bars.

## Testing without the device

```bash
node bin/selftest.mjs
```

Points `CLAULED_PORT` at a temp file, runs the real scripts, and asserts on the exact bytes they write. Verifies the `resets_at` → `resets_in` conversion, the alternate field-name handling, and that an unrecognised payload pushes nothing.

## Known caveat: the statusline schema is unverified

Usage extraction reads the `rate_limits` object Claude Code passes to the statusline. **The exact field names have not been confirmed against a live payload** — they come from documentation, not observation.

`extractUsage()` in `bin/clauled.mjs` therefore accepts several plausible spellings (`used_percentage`, `usedPercentage`, `utilization`, `pct`) and handles `resets_at` as epoch seconds, epoch milliseconds, or an ISO string. If the real shape differs from all of them, nothing is pushed and the statusline prints `clauled: no usage data`.

To capture the real payload:

```bash
CLAULED_DEBUG=1 claude
```

Every statusline and hook invocation appends its raw stdin to `~/.clauled-debug.log`. Read that, then tighten `extractUsage()` to match. **The log contains whatever Claude Code sends — check it before sharing.**

Also note `rate_limits` is documented as appearing only for Pro/Max subscribers, and only after the first API response in a session.

## Why Node rather than shell scripts

On Windows, Claude Code runs hook commands through **CMD.exe**. `.sh` files don't execute, `$VAR` doesn't expand, and `bash` isn't on PATH even with Git installed — which is why some plugins ship polyglot `.cmd` wrappers.

`node` is on PATH on every platform, and `${CLAUDE_PLUGIN_ROOT}` is substituted by Claude Code before the shell sees the command. So a Node entry point is cross-platform with no wrapper.

## Troubleshooting

**`doctor` says no device found.** Check the cable carries data, and that the board enumerates — it should appear as a USB serial device with vendor ID `303A`.

**`no reply` from the status probe.** Another program is probably holding the port. Close `pio device monitor` or any serial terminal; only one process can own a COM port.

**Statusline shows `clauled: no usage data`.** Either the payload has no `rate_limits` yet (it appears after the first API response), or the field names differ. Capture the payload with `CLAULED_DEBUG=1`.

**Hooks never fire.** Confirm the plugin is enabled, then test the script directly:

```bash
echo "{}" | node bin/event.mjs stop
```

If that pushes successfully, the script is fine and the problem is hook registration.

## License

MIT.
