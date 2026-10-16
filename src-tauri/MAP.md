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
commands in `src/commands/` and domain behavior in the owning service.
Vault access is granted dynamically to the selected canonical vault; do not
add broad static filesystem scopes or relax CSP to silence tests.

Read [filesystem-security.md](../docs/filesystem-security.md) for path/security
work and [update-system.md](../docs/update-system.md) for release/updater changes.
Configuration/plugins/permissions/IPC/packaging/updater changes require a native
build (or a recorded reason it could not run), not only a Vite build.
Never commit `target/` or generated bundles. Ordinary work does not bump versions.
