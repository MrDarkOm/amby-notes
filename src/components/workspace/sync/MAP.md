# Sync connect screen map

The optional module `amby.sync` (beta, opt-in, off by default) and its settings section. Plan:
[sync-plan.md](../../../../docs/sync-plan.md) (Р5, Р12, stage Э4). Only the connection is built: notes do
not synchronise yet, and the screen says so.

| Concern                                                  | Owner                                                                                                                            |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Module definition (adds a settings section only)         | [sync-module.tsx](sync-module.tsx), registered in [builtins.ts](../../../lib/modules/host/builtins.ts)                           |
| The section in the settings (status, devices, sign out)  | [sync-settings.tsx](sync-settings.tsx); the tab is shown by [settings-dialog.tsx](../settings-dialog.tsx) while the module is on |
| Connect wizard (address → create / sign in / recover)    | [connect-wizard.tsx](connect-wizard.tsx)                                                                                         |
| Recovery code step (code, save, print, type groups back) | [recovery-code-step.tsx](recovery-code-step.tsx); print sheet style `.sync-print-sheet` in [app.css](../../../themes/app.css)    |
| New password with strength                               | [password-fields.tsx](password-fields.tsx), [use-password-verdict.ts](use-password-verdict.ts); the verdict comes from Rust      |
| Commands, error texts, recovery file                     | [src/lib/sync/](../../../lib/sync/): `sync-port.ts`, `sync-errors.ts`, `recovery-file.ts`                                        |
| Rust side                                                | [src-tauri/src/sync/](../../../../src-tauri/src/sync/mod.rs), [commands/sync.rs](../../../../src-tauri/src/commands/sync.rs)     |
| Test double of the port                                  | [fake-sync-port.ts](fake-sync-port.ts) (tests only)                                                                              |

Rules that tests hold: the recovery code is shown **before** anything is sent, and the only way on is typing back
groups of it; the password is judged by the application (12 characters, `zxcvbn` score 3), the screen only
shows the verdict; every error is a machine code translated in `sync.errors.*` (the text of a server is
never shown); the browser build has the `unavailable` port. Keep passwords and codes out of component state
once they have been used, and out of the DOM text.

Tests sit beside the files. The manual check in a native window, against a server in Docker, is the
section "Синхронизация" of [native-ui-smoke.md](../../../../docs/native-ui-smoke.md).
