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

## Dependency remediation — 2026-09-29

- Cargo.lock selects Rustls 0.23.45, fixing [RUSTSEC-2026-0285](https://rustsec.org/advisories/RUSTSEC-2026-0285.html). Its required aws-lc/webpki updates stay in the lockfile. The transitive `chacha20` 0.10.1 was yanked; 0.10.2 replaces it through the existing `ulid → rand` dependency, without changing vault IDs or formats.
- Vitest and its matching internal packages use 4.1.11, addressing [GHSA-82fw-gwwq-j7x9](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9). Tests here run in Node; the advisory concerns the development mocker server, not a demonstrated production app exploit.
- The Excalidraw dependency chain uses `lodash-es` 4.18.1 via an override because its upstream packages retain older pins. The [upstream advisory](https://github.com/lodash/lodash/security/advisories/GHSA-r5fr-rjxr-66jc) identifies 4.18.0 as the first patched release. Excalidraw itself remains 0.18.1.
- Scoped overrides select Nano ID [3.3.18](https://github.com/ai/nanoid/releases/tag/3.3.18) for Excalidraw and [5.1.16](https://github.com/ai/nanoid/releases/tag/5.1.16) for mermaid-to-excalidraw. The latter replaces the unpatched 4.x line: the consumer uses the named ESM `nanoid()` API without a size argument. Remove these overrides only after upstream manifests resolve patched versions themselves.

Browser checks covered Excalidraw element creation, drawing, JSON restoration, Amby sketch serialization with unknown metadata, Mermaid flowcharts, and Canvas conversion. Mermaid class diagrams triggered a converter DOM-ID error and fell back to an SVG image. Editable class-diagram conversion is **not** verified; this remains an upstream integration defect to resolve separately. Do not describe the browser run as error-free.

The updated lockfile was compared locally against the findings of the earlier npm audit. A fresh npm audit has not run: it requires sending dependency names and versions to registry.npmjs.org, and that transfer is awaiting explicit authorization. The package updates are not evidence of a clean, current, whole-tree npm audit. No additional Rust advisory exceptions were added.

## Known limitation — Windows system trash

`DeleteMode::System` uses `SHFileOperationW` with `FOF_ALLOWUNDO | FOF_NOCONFIRMATION`.
For items the Recycle Bin cannot hold (too large, network drives) Windows may delete
permanently without a warning. Not reproduced or fixed here (no Windows run).

## Open finding — official package signing key in source — 2026-10-02

**Severity: high. Needs the project owner; not fixed by code alone.**

**Status (2026-10-02): deferred by the owner.** Third-party modules are not used yet. The key rotation below is a hard prerequisite for enabling installed-module execution (`INSTALLED_MODULE_EXECUTION_ENABLED`), publishing any package, or announcing a module ecosystem; do not enable those before it is done.

The private half of the official Ed25519 key `amby-official-2026` is committed in
`scripts/build-modules.mjs` and, as a "test" key, in
`src/lib/modules/package-manager/validator.ts` (`TEST_OFFICIAL_PRIVATE_KEY_HEX`).
The build script verifies its own signatures against the same public key that
`src-tauri/src/package_manager.rs` (`OFFICIAL_ED25519_PUBLIC_KEY_HEX`) trusts, so
the committed secret corresponds to the trusted official key. It has been in git
history since commit `14ed478`; removing it from the tree does not un-leak it.

Anyone with repository read access can therefore sign a package that the backend
accepts as official. Current mitigation: installed modules are not executed
(`INSTALLED_MODULE_EXECUTION_ENABLED = false`), and only bundled official modules
run. That limits impact but does not remove the trust-anchor problem.

Required remediation (owner actions marked):

1. **Owner:** generate a new Ed25519 key pair outside the repository and keep the
   private key only in a secrets store (CI secret or local environment).
2. Replace the public key and key ID in `package_manager.rs`, `validator.ts` and
   `scripts/build-modules.mjs`; stop accepting `amby-official-2026`.
3. Make `build-modules.mjs` read the private key from the environment and fail
   loudly when absent; tests must use an ephemeral key pair injected as the trust
   anchor, never a committed secret.
4. Treat packages signed with the old key as untrusted and reissue any that were
   distributed. Do not enable installed-module execution before this is done.
