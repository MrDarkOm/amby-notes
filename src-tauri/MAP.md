# Tauri integration map

Use this map for app bootstrap, permissions and packaging; use
[the Rust services map](src/MAP.md) for domain behavior.

| Concern                                            | Owner                                                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Native executable / app builder / command registry | [src/main.rs](src/main.rs), [src/lib.rs](src/lib.rs)                                                                                     |
| Desktop manifest and workspace lockfile              | [Cargo.toml](Cargo.toml), [Cargo.lock](../Cargo.lock)                                                                                       |
| App/window/security/bundle/updater configuration   | [tauri.conf.json](tauri.conf.json)                                                                                                       |
| Platform bundle overrides                          | [tauri.macos.conf.json](tauri.macos.conf.json)                                                                                           |
| Narrow capability declarations                     | [capabilities/default.json](capabilities/default.json)                                                                                   |
| Build hook                                         | [build.rs](build.rs)                                                                                                                     |
| App icons                                          | [icons/](icons/)                                                                                                                         |
| Frontend integration guards                        | [tauri-capabilities.test.ts](../src/lib/tauri-capabilities.test.ts), [tauri-build-config.test.ts](../src/lib/tauri-build-config.test.ts) |

`lib.rs` composes state/plugins/windows and the Specta command builder. Put new
commands in `src/commands/` and domain behavior in [amby-core](../crates/amby-core/src/MAP.md). Per-keystroke
write commands (`write_note`, `write_file` in `commands/notes.rs`) are `async` and run on
`spawn_blocking`, never on the main thread; `WriteSequencer` there keeps writes to one note or path in
IPC arrival order. The main
window lifecycle (restore/recreate on Dock click or a second launch, closing the
hidden settings window with it) lives in `src/state.rs`. Its `handle_run_event` is also used by the isolated
native UI harness in `src/native_contract.rs` so smoke tests exercise the same
helper-window cleanup and restore path. On macOS both also install `app_menu`: the default menu with
Amby's own Quit item (`QUIT_MENU_ID`, Cmd+Q). `request_quit` asks every editing window to close, so
each saves its edits in its own close handler; the predefined Quit item would end the process without a
close request. Dock → Quit and `tell application to quit` also send `terminate:` without a close request, and tao
implements no `applicationShouldTerminate:` (so `RunEvent::ExitRequested` does not fire).
[terminate_gate.rs](src/terminate_gate.rs) adds that method to tao's delegate and never answers `NSTerminateLater`
(AppKit's terminate-later loop does not run tao's main-thread work: the app hung). A quit with an editing window
open is answered `NSTerminateCancel`, then `request_quit` runs on the normal event loop (every window saves in its
close handler and the app exits with the last one); a 5 s timer calls `exit(0)` if it is still running, and a second
Dock Quit meanwhile only cancels again. Logout, restart and shutdown (`keyAEQuitReason` of the current Apple
Event) and a quit with no editing window are answered `NSTerminateNow`, as before; recovery drafts keep recent
typing. `TerminateGate` is the tested state machine. The update
install in the renderer has its own path, see [src/lib map](../src/lib/MAP.md).
Vault access is granted dynamically to the selected canonical vault; do not
add broad static filesystem scopes or relax CSP to silence tests.

Read [filesystem-security.md](../docs/filesystem-security.md) for path/security
work and [update-system.md](../docs/update-system.md) for release/updater changes.
Configuration/plugins/permissions/IPC/packaging/updater changes require a native
build (or a recorded reason it could not run), not only a Vite build.
Never commit `target/` or generated bundles. Ordinary work does not bump versions.
