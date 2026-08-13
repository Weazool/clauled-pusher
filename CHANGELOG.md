# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.3.0] - 2026-08-13

Every hook push now recomputes the full display, not just the field it
exists to add. Requires firmware **v3.4.0** for the header/footer layout;
against older firmware the same data still renders, at the old positions.

### Fixed
- **A hook push only ever updated its own field, leaving everything else
  stale until the next statusline render.** `busy.mjs` sent the spinner plus
  title/session/effort but never touched either gauge; `event.mjs` sent the
  banner plus a context gauge but never the quota gauge. Switch effort or the
  model mid-session and submit a prompt, and the device could show a mix of
  fresh and minutes-old numbers depending on which field happened to live in
  which push. Both hooks now call the same `buildDisplay()` the statusline
  uses, so every push carries the full state it can compute: session and
  effort fresh from the payload, both gauges from cache/transcript, model from
  cache. There is now exactly one code path deciding what the display looks
  like, used everywhere.
- **The model still cannot be fresher than the last statusline render on a
  hook-only turn, and this release does not change that.** Claude Code's hook
  payloads never carry the model — confirmed against captured payloads, only
  `effort` is present — so a hook has no way to know it changed. If you switch
  models and the very next prompt fires before a statusline render happens,
  the model corner will show the previous one for that one push. Effort and
  session do not have this problem: hooks carry both directly, and now update
  on every single push instead of only some.
- **A burst of hook calls could spawn multiple concurrent quota-refresh
  processes.** Now that hooks recompute the full display on every push,
  a stale quota cache would previously trigger a fresh detached refresh child
  on every one of them — each making its own API call against the very quota
  being measured. A short-lived lock file now caps this at one refresh in
  flight at a time, regardless of how many hooks fire in the same burst.

### Changed
- **`buildDisplay()` no longer sends `footer.left` (cost).** Firmware v3.4.0
  stopped drawing it; sending it against older firmware was harmless but is
  now simply dropped at the source instead.
- `doctor`'s synthetic test push and its post-test restore were updated to
  match: the restore now clears the test session, restores the model from its
  own persistent cache (better than leaving `"test"` on the glass), and is
  explicit that the context gauge and effort corner are the only two fields it
  cannot restore without a real payload.

## [3.2.0] - 2026-08-13

Feeds the header and footer that Clauled firmware v3.1.0 removed and v3.3.0
brought back. Requires firmware **v3.3.0** to render the new fields; against
anything older they are simply ignored.

### Added
- **`session`** — which session this is, for the header's left. `session_name`
  is the intended source, but Claude Code sends it rarely: once in fifty
  payloads across the captures behind this. The fallback is the workspace
  directory name, which is nearly always present and is arguably the better
  answer anyway — it says which *project* the device is reporting on.
- **`footer.right`** — the effort level, spelled out. It has a corner to itself
  now, so nothing has to be abbreviated to fit.
- Hooks send both, alongside the model. Hook payloads carry `cwd` and `effort`,
  and the statusline can go minutes without firing, so without this the header
  and footer would sit stale between renders.

### Changed
- **`title` is the model alone.** It previously joined model and effort into one
  string capped at 14 characters, which meant a long model name truncated the
  effort away entirely — `Claude Opus 5 (1M context)` rendered as `Opus 5 (1M`
  with no effort at all. They are separate fields now, so neither can crowd out
  the other, and the abbreviation table is gone with them.

## [3.1.1] - 2026-08-13

### Fixed
- **`doctor` left its synthetic test values on the display.** It pushes
  `23%` with a `1h21m` countdown to prove the display path works — figures that
  read exactly like a real quota — and because the device merges, they stayed on
  the glass until something overwrote them. That can be minutes, during which
  the device is confidently showing a number that is simply false, and the
  natural conclusion is that the quota feed is broken. `doctor` now restores the
  quota gauge from the cache and clears the test banner before it exits, and
  says plainly which fields it could not restore.

### Notes
- The same class of mistake is worth avoiding when testing by hand: any script
  run against your real home directory will write whatever it is given into
  `~/.clauled-quota.json`, because a payload's `rate_limits` is cached by
  design. `selftest` is isolated from `$HOME` for exactly this reason — ad-hoc
  verification is not.

## [3.1.0] - 2026-08-13

Works on macOS. Needs no credential. Pairs with Clauled firmware v3.1.0.

### Added
- **`node bin/install.mjs`** — the one setup step, done safely. Writes a shim to
  `~/.clauled/`, points `statusLine` at it, backs up `settings.json` first,
  refuses to clobber a status line that is not ours without `--force`, and then
  **runs the command through the same shells Claude Code uses** to prove it
  works rather than assuming it will. `--print`, `--force`, `--uninstall`.
- **macOS device discovery by vendor ID**, via `ioreg`. There was previously no
  vendor filtering off Windows at all — `/dev/serial/by-id` is a Linux udev
  construct, so macOS fell through to an unfiltered prefix scan and would bind
  to whatever `usbmodem` device `readdir` happened to list first. An Arduino, an
  STM32 Nucleo, another ESP board.
- **macOS round-trip status probe**, so `doctor` reports firmware version,
  `display_ok` and uptime there too. It falls back to the write-only probe
  rather than reporting a false negative.
- **macOS Keychain token fallback** — Claude Code stores credentials in the
  login Keychain there, not in `~/.claude/.credentials.json`, so the file check
  could never succeed.
- **Linux vendor matching via sysfs**, replacing a `ttyACM` prefix scan with no
  vendor check.
- **`doctor` diagnoses the setup, not just the device**: malformed config,
  statusline wiring, whether the interpreter it names still exists, whether it
  points into a plugin directory, and whether a shell can resolve `node` at all.
- `.gitattributes`, pinning LF. A CRLF shebang makes the kernel look for an
  interpreter called `node\r`.

### Changed
- **The 5h gauge no longer needs a token.** It now comes from the statusline
  payload's `rate_limits` block, which also carries `seven_day`. The
  authenticated API call is demoted to a fallback for hosts that never send it.
- **Context comes from the payload's `context_window`** when present, with the
  transcript as the fallback.
- **Gauge labels are shorter** (`5h reset`, `ctx`) because firmware v3.1.0
  composes them into a single 21-character line with the detail and percentage.
  The selftest asserts both lines fit at 100%, which is the widest case.
- Effort levels are spelled out — `xhigh`, not `xhi`. Only `medium` is
  abbreviated; everything else fits the bottom row's 14 characters.
- **Port discovery caches misses**, for 30 seconds. Without that an unplugged
  device made every hook pay for a full enumeration — measured at 1.2–1.4 s per
  scan — before every single tool call, which reads as Claude Code having gone
  slow. Re-detection is also capped at once per push.

### Fixed
- **A reduced payload blanked the gauges to `--`.** Claude Code does not send
  the same keys every time; some invocations carry only `{model, effort}`.
  Emitting `pct: -1` for the missing feeds meant those payloads actively
  overwrote good readings, because the device merges and `-1` is data. Fields
  that cannot be computed are now omitted entirely, so the last good value
  survives.
- **A wrong port silently created a regular file and reported success.**
  `openSync(path, 'w')` is `O_WRONLY|O_CREAT|O_TRUNC`, so pushes "succeeded"
  into a file on disk and `doctor` cheerfully reported a healthy device that was
  not plugged in. Now an honest `ENOENT`.
- **Write collisions were not retried.** Two hooks firing together produced
  `EPERM` on Windows; re-detecting returns the same port, so it did nothing. A
  short bounded wait is what actually helps.
- **Short writes were ignored**, which would truncate a line and present as
  intermittent corruption.
- **A doomed refresh child was spawned on every statusline render** for anyone
  without a token: the refresh could not succeed, so it never wrote a cache, so
  the cache stayed stale, so it spawned again.
- **`powershell` was resolved via `PATH`** with no fallback; a trimmed `PATH`
  became a bare `ENOENT` swallowed as "device not found". Now an absolute path,
  and the probe reports PowerShell's stderr instead of leaking a raw .NET stack
  trace and misdiagnosing it as a busy port.
- **A malformed `~/.clauled.json` silently discarded every setting.** Absent and
  invalid are now different things, and `doctor` says which.
- **`readStdin`'s timeout left stdin ref'd**, so a host that never closed the
  pipe would have hung the process. Not observed in practice — the handle is
  released explicitly now regardless.
- **The selftest read the developer's real home directory**, so results depended
  on whether that machine happened to have a token configured. That is how
  `gauge1 is -1 with no token` passed while testing nothing. It now runs against
  its own throwaway home.

### Notes
- **Two things this project documented were wrong**, both concluded from a
  sample that happened to contain only reduced payloads: `rate_limits` *is* sent
  in the statusline payload, and `context_window` *does* populate. A payload's
  `five_hour.resets_at` matches the API header epoch exactly.
- **`node` may not be on `PATH` for hooks on macOS.** A GUI launch from Finder
  inherits launchd's environment, not your shell's, and Claude Code exports no
  variable pointing at an interpreter. `install.mjs` sidesteps this for the
  statusline by baking in an absolute path; hooks cannot be fixed from here, so
  `doctor` checks and reports it.
- **Quoting is hostile across shells.** `"C:/Program Files/nodejs/node.exe" x`
  runs under sh, Git Bash and cmd, but PowerShell treats a leading quoted token
  as a string literal and prints it — no status line, no error. The installer
  emits an unquoted space-free path, using the DOS 8.3 alias on Windows.
- macOS uses `/dev/cu.*` only. Opening the `tty.*` dial-in node blocks until
  carrier is asserted, which in a hook is a hang rather than an error.

## [3.0.2] - 2026-08-13

Requires Clauled firmware v3.0.1 for the banner fix.

### Fixed
- **The header went stale whenever the statusline was quiet.** Only the
  statusline set the model and effort, so changing effort mid-session left the
  header showing the old value until the statusline next ran — which can be
  minutes. Hooks carry the current model and effort in their own payloads and
  now send the header too.
- **Hook payloads carry the effort but not the model**, so the header above
  would have rendered a bare `xhi` and dropped the model entirely. The model is
  now cached to `~/.clauled-model` by whoever sees one — in practice the
  statusline — and read back by whoever doesn't, so both paths render a
  complete header.

## [3.0.1] - 2026-08-13

### Fixed
- **An unrecognised effort level was silently dropped from the header.** `ultra`
  was not in the abbreviation table, so the lookup returned undefined and the
  effort simply vanished — the header read `Opus 5` with no explanation.
  Unknown levels now fall back to the raw value, and `ultra` is mapped.
- **Long model names dropped the effort too.** The joined string was truncated
  to the header's 14 characters, so `Claude Opus 5 (1M context)` became
  `Claude Opus 5 ` with the effort cut off. The effort's room is now reserved
  first and the model shortened instead. A leading `Claude ` is also stripped,
  since the header already says it.
- **Context reading trailed by one message.** The statusline renders before the
  turn's usage block is written to the transcript, so it always showed the
  previous turn's figure. The `Stop` hook now recomputes context from the
  transcript, which is current by the time it fires.

## [3.0.0] - 2026-08-13

Real data at last. Requires Clauled firmware v3.0.0.

### Changed — breaking
- Emits the v3 labelled-field schema (`gauge1`, `gauge2`, `row`, `footer`,
  `title`, `busy`) instead of fixed usage buckets.

### Added
- **Context gauge**, computed from the session transcript: the newest
  `message.usage` block over `context_window_size`. Only the last 256 KB of the
  transcript is read, so it stays fast on multi-megabyte files.
- **Activity reporting.** A `UserPromptSubmit` hook shows a gerund while Claude
  thinks; a `PreToolUse` hook shows the actual activity, including the file
  being edited. `Stop` raises a `Your turn` banner and clears the spinner.
- **Model and effort in the header**, e.g. `Opus 5 med`.
- **Optional 5h subscription gauge**, off by default. Needs an OAuth token in
  `~/.clauled.json`; without one the gauge shows `--` and nothing else changes.
  Cached for five minutes and refreshed by a detached child process, so the
  statusline never waits on the network.

### Fixed
- The status probe no longer resets the device. .NET's `SerialPort` raises
  DTR/RTS on `Open()`, rebooting the ESP32-C3 and wiping the state being read —
  `doctor` reported `last_push_age=-1` regardless of what had just been pushed.
- Debug capture can be enabled from config (`"debug": true`) rather than only an
  environment variable, so it takes effect without restarting Claude Code.

### Notes on what Claude Code exposes
Verified against v2.1.231 by capturing live payloads:
- **No `rate_limits` anywhere.** Not in the statusline payload, not in the
  transcript. Subscription limits exist only behind an authenticated API call.
  The previous release's `extractUsage()` targeted a field that does not exist
  and would have silently pushed nothing.
- **`context_window` in the payload is always zero** — `total_input_tokens`,
  `used_percentage` and `remaining_percentage` never populate.
- The token in `~/.claude/.credentials.json` may be an empty string on some
  setups, with only metadata left behind, so it is a fallback rather than the
  primary source.

## [2.0.0] - 2026-08-13

Transport moved from HTTP to USB serial, matching Clauled firmware v2.0.0.

### Changed — breaking
- **Pushes go to a USB serial port, not an HTTP endpoint.** Requires Clauled
  firmware v2.0.0 or later.
- `~/.clauled.json` no longer takes `url` or `key`. It is now optional
  entirely, and only accepts `port` as an override for auto-detection.
- The `CLAULED_URL` and `CLAULED_KEY` environment variables are replaced by
  `CLAULED_PORT`.

### Added
- **Automatic device discovery** by Espressif USB vendor ID (`303A`). Moving the
  device to a different USB socket needs no configuration change.
- Discovery is cached for five minutes so the statusline does not pay for a
  scan on every render. A failed write forces immediate re-detection and retries
  once, so replugging recovers without waiting for the cache to expire.
- `doctor` performs a real round-trip status probe against the device.
- `selftest` points `CLAULED_PORT` at a temporary file and asserts on the exact
  bytes written, so the transform can be verified with no hardware attached.

### Removed
- The shared push key and the `X-Clauled-Key` header. Physical USB access is now
  the authentication.

### Notes
- Still **no npm dependencies**. Serial writes use Node's built-in `fs`; port
  discovery shells out to PowerShell on Windows and reads `/dev` elsewhere.
  There is no native `serialport` module to build.
- Usage extraction is unchanged, including the tolerance for several plausible
  `rate_limits` field spellings. That schema remains unverified against a live
  Claude Code payload.

## [1.0.0] - 2026-08-12

First release. HTTP transport to a Clauled device on the local network.

### Added
- Statusline script forwarding rate-limit figures to `POST /push`.
- `Stop` and `Notification` hooks forwarding attention events.
- `doctor` for connectivity diagnosis and `selftest` for offline verification.
- Written in Node rather than shell: on Windows, Claude Code runs hooks through
  CMD.exe, where `.sh` files do not execute and `bash` is not on PATH.
