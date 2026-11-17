# Tauri integration map

Use this map for app bootstrap, permissions and packaging; use
[the Rust services map](src/MAP.md) for domain behavior.

| Concern                                            | Owner                                                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Native executable / app builder / command registry | [src/main.rs](src/main.rs), [src/lib.rs](src/lib.rs)                                                                                     |
| Dependencies, features, crate version              | [Cargo.toml](Cargo.toml), [Cargo.lock](Cargo.lock)                                                                                       |
| App/window/security/bundle/updater configuration   | [tauri.conf.json](tauri.conf.json)                                                                                                       |
| Platform bundle overrides                          | [tauri.macos.conf.json](tauri.macos.conf.json)                                                                                           |
| Narrow capability declarations                     | [capabilities/default.json](capabilities/default.json)                                                                                   |
| Build hook                                         | [build.rs](build.rs)                                                                                                                     |
| App icons                                          | [icons/](icons/)                                                                                                                         |
| Frontend integration guards                        | [tauri-capabilities.test.ts](../src/lib/tauri-capabilities.test.ts), [tauri-build-config.test.ts](../src/lib/tauri-build-config.test.ts) |

`lib.rs` composes state/plugins/windows and the Specta command builder. Put new
commands in `src/commands/` and domain behavior in the owning service. Per-keystroke
write commands (`write_note`, `write_file` in `commands/notes.rs`) are `async` and run on
`spawn_blocking`, never on the main thread; `WriteSequencer` there keeps writes to one note or path in
IPC arrival order. The main
window lifecycle (restore/recreate on Dock click or a second launch, closing the
hidden settings window with it) lives in `src/state.rs`. Its `handle_run_event` is also used by the isolated
native UI harness in `src/native_contract.rs` so smoke tests exercise the same
helper-window cleanup and restore path. On macOS both also install `app_menu`: the default menu with
Amby's own Quit item (`QUIT_MENU_ID`, Cmd+Q). `request_quit` asks every editing window to close, so
each saves its edits in its own close handler; the predefined Quit item would end the process without a
close request. Dock → Quit and logout also send `terminate:` without a close request, and tao implements no
`applicationShouldTerminate:` (so no public Tauri API sees them: `RunEvent::ExitRequested` does not fire,
`RunEvent::Exit` cannot be prevented). [terminate_gate.rs](src/terminate_gate.rs) adds that method to tao's
delegate class at `RunEvent::Ready`: the first request answers `NSTerminateLater`, runs `request_quit`
(the same close handlers as Cmd+Q) and starts a 5 s timer; the process ends when the last window is gone,
or the timer answers `replyToApplicationShouldTerminate:` (logout must not hang; recovery drafts, written
within about a second of typing, keep the text). `TerminateGate` is the tested state machine. The update
install in the renderer has its own path, see [src/lib map](../src/lib/MAP.md).
Vault access is granted dynamically to the selected canonical vault; do not
add broad static filesystem scopes or relax CSP to silence tests.

Read [filesystem-security.md](../docs/filesystem-security.md) for path/security
work and [update-system.md](../docs/update-system.md) for release/updater changes.
Configuration/plugins/permissions/IPC/packaging/updater changes require a native
build (or a recorded reason it could not run), not only a Vite build.
Never commit `target/` or generated bundles. Ordinary work does not bump versions.
