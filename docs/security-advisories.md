# Rust dependency advisory policy

`npm run audit:rust` runs `cargo audit` against `src-tauri/Cargo.lock`. It
fails for every advisory except the exact IDs in `scripts/audit-rust.sh`; broad
warning suppression is prohibited. This record is the review authority for
those temporary exceptions.

Direct dependency review on 2026-08-24: `tauri` 2.11.5 is the current compatible
release. `rfd` 0.17.2 was evaluated but requires resolving `tauri-plugin-dialog`
back to 2.4.2 and introduces duplicate dialog crates, so the shared compatible
0.16.0 release remains in use. No direct update reduces the listed advisories
without a Tauri/Specta compatibility migration.

| Advisory IDs                                                                                  | Affected crates                                                                                | Owner and target                                                             | Decision                                                                                                                                        | Review by  |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| RUSTSEC-2024-0411 through RUSTSEC-2024-0420; RUSTSEC-2024-0429; RUSTSEC-2024-0370             | `atk*`, `gdk*`, `gdkwayland-sys`, `gdkx11*`, `gtk*`, `gtk3-macros`, `glib`, `proc-macro-error` | Tauri/Wry and shared `rfd` Linux GTK3 runtime/compile chain                  | No compatible Tauri 2 or shared `rfd` update removes this chain. Keep explicit exceptions while tracking the Tauri/Wry Linux backend migration. | 2026-11-24 |
| RUSTSEC-2024-0436                                                                             | `paste`                                                                                        | Specta/Tauri proc-macro surface, transitive from pinned `specta` 2.0.0-rc.22 | The matching `tauri-specta` release pins this Specta release. Upgrade them together only after confirming generated IPC binding compatibility.  | 2026-11-24 |
| RUSTSEC-2025-0075, RUSTSEC-2025-0080, RUSTSEC-2025-0081, RUSTSEC-2025-0098, RUSTSEC-2025-0100 | `unic-char-range`, `unic-common`, `unic-char-property`, `unic-ucd-version`, `unic-ucd-ident`   | `tauri-utils` `urlpattern`, used by Tauri build tooling and runtime          | No direct dependency controls this transitive. Re-evaluate with the next Tauri update.                                                          | 2026-11-24 |

## Review procedure

1. Run `npm run audit:rust` and `cargo tree --manifest-path src-tauri/Cargo.toml --target all -i <crate>` for every still-listed crate.
2. Prefer a compatible direct dependency update and remove exceptions that it resolves.
3. Reconfirm target reachability, owner and review date before retaining any exception.
4. Never ignore a vulnerability without a separately approved mitigation plan.
