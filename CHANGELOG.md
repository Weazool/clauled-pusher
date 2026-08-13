# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
