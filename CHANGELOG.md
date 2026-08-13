# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
