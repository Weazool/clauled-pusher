# clauled-pusher

A Claude Code plugin that pushes your subscription usage and "Claude needs you" events to a [Clauled](https://github.com/Weazool/clauled) ESP32 desk display.

```
Claude Code ──statusline──▶ usage %       ┐
            ──Stop/Notification hooks──▶ events  ├──▶ POST /push ──▶ Clauled ──▶ OLED
```

The device holds no credentials. This plugin holds no Claude token either — usage comes from data Claude Code already hands its statusline.

## Requirements

- A Clauled device on your network, running v1.0.0 or later
- Claude Code (Node 18+ is already a requirement of it)

## Install

```bash
git clone https://github.com/Weazool/clauled-pusher
```

Add it as a plugin directory in Claude Code, then configure the device connection.

### 1. Configure the device

Create `~/.clauled.json`:

```json
{
  "url": "http://clauled.local",
  "key": "your CLAULED_PUSH_KEY from the firmware",
  "timeoutMs": 1000
}
```

`CLAULED_URL` and `CLAULED_KEY` environment variables override the file if set.

The key must match `CLAULED_PUSH_KEY` in the device's `src/secrets.h`. Changing it on the device means reflashing.

### 2. Verify the connection

```bash
node bin/doctor.mjs
```

This checks config, reachability, and both push paths — isolating "device unreachable" from "hook never fired", which are very different problems. Run it before debugging anything else.

### 3. Wire up the statusline

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

## What gets pushed

| Source | Trigger | Payload |
|---|---|---|
| statusline | Every statusline render | `usage` — 5h / 7d percentages and reset countdowns |
| `Stop` hook | Claude finished its turn | `{"type":"attention","text":"Claude finished - your turn"}` |
| `Notification` hook | Claude wants permission or input | `{"type":"attention","text":"Claude needs input"}` |

`Stop` and `Notification` are the two events that mean "Claude is asking me something". `UserPromptSubmit` would be wrong — it fires when *you* submit, i.e. when you are already at the keyboard.

The device merges pushes, so an events-only push never wipes the usage bars.

## Known caveat: the statusline schema is unverified

Usage extraction reads the `rate_limits` object Claude Code passes to the statusline. **The exact field names have not been confirmed against a live payload** — they come from documentation, not observation.

`extractUsage()` in `bin/clauled.mjs` therefore accepts several plausible spellings (`used_percentage`, `usedPercentage`, `utilization`, `pct`) and handles `resets_at` as epoch seconds, epoch milliseconds, or an ISO string. If the real shape differs from all of them, no usage is pushed and the statusline prints `clauled: no usage data`.

To capture the real payload:

```bash
CLAULED_DEBUG=1 claude
```

Every statusline and hook invocation appends its raw stdin to `~/.clauled-debug.log`. Read that, then tighten `extractUsage()` to match. **The log contains whatever Claude Code sends — check it before sharing.**

Also note `rate_limits` is documented as appearing only for Pro/Max subscribers, and only after the first API response in a session.

## Why Node rather than shell scripts

On Windows, Claude Code runs hook commands through **CMD.exe**. `.sh` files don't execute, `$VAR` doesn't expand, and `bash` isn't on PATH even with Git installed — which is why some plugins ship polyglot `.cmd` wrappers.

`node` is on PATH on every platform, and `${CLAUDE_PLUGIN_ROOT}` is substituted by Claude Code before the shell sees the command. So a Node entry point is cross-platform with no wrapper.

## Performance

Hooks block the session while they run, so every push is capped by `timeoutMs` (default 1000 ms) and never throws. The hooks are also declared `async: true` so they don't add latency to your turns. If your Claude Code build rejects that field, remove it from `hooks/hooks.json` — the timeout still bounds the delay.

## Troubleshooting

**`doctor` says the key is not set.** Create `~/.clauled.json` or export `CLAULED_KEY`.

**Pushes return 401.** The key doesn't match the firmware's `CLAULED_PUSH_KEY`. Reflash the device to change it.

**Device unreachable but works in a browser.** mDNS may be blocked between network segments. Put the raw IP in `~/.clauled.json`.

**Statusline shows `clauled: no usage data`.** Either the payload has no `rate_limits` yet (it appears after the first API response), or the field names differ. Capture the payload with `CLAULED_DEBUG=1`.

**Hooks never fire.** Confirm the plugin is enabled, then test the script directly:

```bash
echo "{}" | node bin/event.mjs stop
```

If that pushes successfully, the script is fine and the problem is hook registration.

## License

MIT.
