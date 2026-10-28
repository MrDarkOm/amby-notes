# Application update system

Amby uses the Tauri updater. Update archives are verified with the public key
embedded in `src-tauri/tauri.conf.json`; unsigned or incorrectly signed
artifacts are rejected before installation.

## Channels and release identity

The persisted update preference contains `channel: "stable" | "beta"` and
`autoUpdate`. Existing preferences without a channel, and invalid values, default
to Stable while preserving the automatic-update setting.

- **Stable** offers only final releases and is the default.
- **Beta** offers beta releases and newer final releases.
- Both manual checks and automatic startup checks use the selected channel.
  Changing the channel does not start an installation. Switching back to Stable
  never downgrades: a newer installed beta waits for a suitable final release.
- A manual check result belongs to the channel it checked. Changing channels
  discards it; an installation already requested by the user finishes normally.

Native `updater.rs` owns fixed HTTPS endpoints and version comparison. JavaScript
cannot supply an endpoint or enable downgrades through the check command. Only
`main` and `settings` WebViews may check; they receive a WebView-owned updater
resource for Tauri's normal signed download/install operation. Capabilities permit
that operation and resource cleanup, without exposing the plugin's generic check.

Release binaries embed `AMBY_RELEASE_TAG` during compilation, for example
`v0.1.9-beta.2`. The displayed and compared version is `0.1.9-beta.2`, so beta 3
and the final `0.1.9` sort after beta 2. The three numeric version sources stay
`0.1.9` throughout that cycle. A local build without a release tag uses its
numeric package version and does not treat itself as an earlier beta.
Previously published binaries do not gain channel selection until upgraded to a
build containing it; use a manual installation for that initial beta transition.

Windows MSI compares only three numeric fields. Release automation assigns its
internal version automatically: `major.minor.(patch * 100 + betaNumber)` for
betas, and `major.minor.(patch * 100 + 99)` for finals. Thus beta 2 uses `0.1.902`
and its final uses `0.1.999`; users still see `0.1.9-beta.2` and `0.1.9`.
The helper rejects beta numbers outside 1–98, patch numbers above 654, and
major/minor numbers above 255 before packaging. A later numbering policy would
need an explicit migration before reaching those limits.

## Static channel feeds

The release workflow maintains an independent, generated, data-only Git branch
`update-feed` containing `stable.json` and `beta.json`. Clients request raw HTTPS
files rather than querying GitHub's release-list API at every startup:

- Stable: `https://raw.githubusercontent.com/MrDarkOm/amby-notes/update-feed/stable.json`
- Beta: `https://raw.githubusercontent.com/MrDarkOm/amby-notes/update-feed/beta.json`

The Beta feed includes the newest final when it is newer than the last beta.
Publication is serialized and compares SemVer before changing either file, so a
late older build cannot roll a feed back. The helper preserves Tauri artifact
URLs and signatures, replaces `version` with the complete release identity, and
adds `release_tag`. It requires all six architecture targets and checks
that every platform asset has a signature and uses a repository HTTPS URL before
publishing a feed. Cryptographic signature verification happens in the native
updater before installation.

Beta checks fall back to the Stable feed on request failure; both channels also
fall back to the legacy `/releases/latest/download/latest.json` endpoint.
A valid feed with no eligible update ends the check: fallback is for failed
requests, not for searching past a valid response. The producer therefore keeps
Beta current with final releases. Missing feeds before initial publication can
use the legacy endpoint, which only serves final releases.

## Startup behavior

When automatic updates are enabled in the hydrated preferences, the main
production window checks the update endpoint before mounting the workspace.
The HTTPS check also checks connectivity; its total budget across fallback
endpoints is five seconds. Manual checks have a thirty-second budget.
There is no separate network probe, confirmation dialog, or update notification.
If a newer signed update is available, Amby downloads and installs it, then
restarts. The old workspace stays unopened during installation and restart.

No update, an unreachable endpoint, or a failed download/signature check allows
the current version to open. Failures are recorded in diagnostics without a
popup. Each launch runs one shared check, including under React StrictMode.
Changing the automatic-update preference after startup applies on the next
launch. Browser development, Tauri development, and secondary windows do not
automatically install updates. Manual checks and their progress UI remain
available in settings.

This startup sequence is shared by Windows, macOS, and Linux. On macOS and
Linux the native installer returns after replacement; Amby explicitly calls
the process plugin's `relaunch()` before allowing the workspace to open.
macOS updates replace the installed `.app` bundle without an Amby dialog.
The bundle must be in a location writable by the current user for installation
without OS authorization; the updater may request administrator privileges
for protected locations. Amby does not bypass that authorization.

Linux releases use **AppImage** so updating the application does not invoke a
package manager or a password dialog. Keep the AppImage in a user-writable
directory. Existing `.deb` and `.rpm` installations skip automatic startup
installation: Tauri's native updater invokes `pkexec`/graphical sudo for those
packages. Manual updates remain available. The main window has only the narrow
`core:app:allow-bundle-type` permission to identify this case; no filesystem
scope or privilege escalation permission is added.

Native installed-version smoke tests must run on macOS (arm64 and x64) and
Linux AppImage as well as Windows; the arm64 Windows and Linux builds have no
smoke machine yet, so their first release is a beta for owners of such devices. Unit tests with mocked IPC check installation
ordering and the package guard, but do not verify platform replacement or signing.

Windows uses the updater's `quiet` installer mode, with no installer progress
window. Quiet MSI updates require a per-user installation or an already elevated
process; they cannot request administrator privileges. This setting does not
bypass Windows permissions or platform trust checks. Installed-version smoke
tests must cover the actual signed installer distributed by the release workflow.

See the [Tauri updater documentation](https://v2.tauri.app/plugin/updater/) for
platform restart behavior and Windows installer modes.

## One-time GitHub setup

The matching private key is generated locally at
`.tauri/amby-updater.key` and is intentionally ignored by Git. Back it up in a
secure password manager before publishing the first update. Losing it prevents
existing installations from accepting future updates.

Add the complete private-key contents to the repository Actions secret
`TAURI_SIGNING_PRIVATE_KEY`. The generated key currently has no password, so
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` may be omitted or left empty. If the key is
replaced with a password-protected key, add its password as that second secret.

Platform code signing and notarization are separate from updater signatures.
Production releases must still satisfy the macOS and Windows signing gates.

## Publishing a release

1. Follow the cumulative release workflow: finalize the public
   notes in `updates/upd_<version>.md` and follow the agreed version cycle. Beta tags share their final numeric
   base.
2. Run `npm run version:check`, `npm run verify`, and `npm run build`.
3. Commit and push the release candidate when explicitly requested.
4. After explicit authorization to publish a release, promote with
   `npm run promote -- beta|main`, then create and push
   `v<version>-beta.N` on `beta` or `v<version>` on `main`.
5. The `Release` workflow first runs the full gate on Linux plus the Rust tests on
   Windows and macOS and the WebKit editor suite on macOS. It then builds macOS
   arm64/x64, Linux x64/arm64 AppImages and Windows x64 (NSIS + MSI) / arm64 (NSIS
   only: WiX has no arm64 support), signs the updater artifacts in one draft, and
   publishes it with `latest.json` only after every platform succeeds. The workflow
   embeds the release tag, generates the MSI override, and updates the static
   channel feeds after publication. Windows arm64
   is cross-compiled on x64 Windows; Linux arm64 is built on a native arm64 runner.
6. Verify the release assets and run an installed-version update smoke test
   before declaring the update path verified on that platform. A successful local
   native build does not prove an installed-version update on Windows or Linux.

The workflow rejects a tag whose version does not match any of the three
version sources. Draft and prerelease GitHub releases are not used by the
`/releases/latest/` updater endpoint.
