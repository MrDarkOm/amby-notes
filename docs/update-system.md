# Application update system

Amby uses the Tauri updater with a static `latest.json` file attached to the
latest public GitHub Release. Update archives are verified with the public key
embedded in `src-tauri/tauri.conf.json`; unsigned or incorrectly signed
artifacts are rejected before installation.

## Startup behavior

When automatic updates are enabled in the hydrated preferences, the main
production window checks the update endpoint before mounting the workspace.
That HTTPS request also checks connectivity; its timeout is five seconds.
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
Linux AppImage as well as Windows. Unit tests with mocked IPC check installation
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
   notes in `updates/upd_<version>.md` and increment the patch version exactly once.
2. Run `npm run version:check`, `npm run verify`, and `npm run build`.
3. Commit and push the release candidate when explicitly requested.
4. After explicit authorization to publish a release, create tag `v<version>`
   and push it.
5. The `Release` workflow builds macOS arm64/x64, Linux x64 AppImage, and Windows x64,
   signs the updater artifacts in one draft, and publishes it with `latest.json`
   only after every platform succeeds.
6. Verify the release assets and run an installed-version update smoke test
   before promoting the release through the documented channels.

The workflow rejects a tag whose version does not match any of the three
version sources. Draft and prerelease GitHub releases are not used by the
`/releases/latest/` updater endpoint.
