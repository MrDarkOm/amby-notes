# Rust dependency advisory policy

`npm run audit:rust` runs `cargo audit` against `src-tauri/Cargo.lock`. It
fails for every advisory except the exact IDs in `scripts/audit-rust.sh`; broad
warning suppression is prohibited. This record is the review authority for
those temporary exceptions.

Direct dependency review on 2026-08-24: `tauri` 2.11.5 is the current compatible
release. The direct `rfd` dependency now follows the 0.17 line used by
`tauri-plugin-dialog`, so the lock file holds a single `rfd` (the earlier
0.16 pin, needed while the plugin still resolved 0.16, is gone). No direct
update reduces the listed advisories without a Tauri/Specta compatibility
migration.

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

## npm `overrides` in package.json

Each override exists for a security reason recorded below; remove it when upstream resolves the
patched version itself, then run `npm run verify`.

- `lodash-es` 4.18.1: Excalidraw's chain pins older versions ([remediation 2026-09-29](#dependency-remediation--2026-09-29)).
- `@excalidraw/excalidraw` → `nanoid` 3.3.18 and `@excalidraw/mermaid-to-excalidraw` → `nanoid` 5.1.16: same section.
- `@excalidraw/excalidraw` → `sass` 1.105.2 (its `chokidar` no longer pulls `braces`) and `mermaid` → `katex` `$katex` (one patched KaTeX for the direct and Mermaid copies): [remediation 2026-10-16](#dependency-remediation--2026-10-16).

## Dependency remediation — 2026-09-29

- Cargo.lock selects Rustls 0.23.45, fixing [RUSTSEC-2026-0285](https://rustsec.org/advisories/RUSTSEC-2026-0285.html). Its required aws-lc/webpki updates stay in the lockfile. The transitive `chacha20` 0.10.1 was yanked; 0.10.2 replaces it through the existing `ulid → rand` dependency, without changing vault IDs or formats.
- Vitest and its matching internal packages use 4.1.11, addressing [GHSA-82fw-gwwq-j7x9](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9). Tests here run in Node; the advisory concerns the development mocker server, not a demonstrated production app exploit.
- The Excalidraw dependency chain uses `lodash-es` 4.18.1 via an override because its upstream packages retain older pins. The [upstream advisory](https://github.com/lodash/lodash/security/advisories/GHSA-r5fr-rjxr-66jc) identifies 4.18.0 as the first patched release. Excalidraw itself remains 0.18.1.
- Scoped overrides select Nano ID [3.3.18](https://github.com/ai/nanoid/releases/tag/3.3.18) for Excalidraw and [5.1.16](https://github.com/ai/nanoid/releases/tag/5.1.16) for mermaid-to-excalidraw. The latter replaces the unpatched 4.x line: the consumer uses the named ESM `nanoid()` API without a size argument. Remove these overrides only after upstream manifests resolve patched versions themselves.

Browser checks covered Excalidraw element creation, drawing, JSON restoration, Amby sketch serialization with unknown metadata, Mermaid flowcharts, and Canvas conversion. Mermaid class diagrams triggered a converter DOM-ID error and fell back to an SVG image. Editable class-diagram conversion is **not** verified; this remains an upstream integration defect to resolve separately. Do not describe the browser run as error-free.

The updated lockfile was compared locally against the findings of the earlier npm audit. A fresh npm audit has not run: it requires sending dependency names and versions to registry.npmjs.org, and that transfer is awaiting explicit authorization. The package updates are not evidence of a clean, current, whole-tree npm audit. No additional Rust advisory exceptions were added.

## Dependency remediation — 2026-10-16

Found by the release gate of 0.1.8 (`npm run audit`), fixed before the release:

- [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) (`braces`, every version): reached only through Excalidraw's `sass` 1.51 → `chokidar` 3. A scoped override selects `sass` 1.105.2, whose `chokidar` 5 does not use `braces`. Excalidraw ships prebuilt styles and does not run `sass` in the app.
- [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7) (KaTeX ≤ 0.18.1): KaTeX is a direct dependency (formulas in Live) and Mermaid's; both resolve to 0.18.10 (`mermaid` override `"katex": "$katex"`). Formula rendering was checked in the editor: inline formulas and fractions render with no KaTeX errors; all unit tests pass.
- [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) (`source-map-js` ≤ 1.2.1): lockfile update to 1.2.2.
- RUSTSEC-2026-0338 to RUSTSEC-2026-0342 (`quinn-proto`) and RUSTSEC-2026-0346 to RUSTSEC-2026-0349 (`rustls`): compatible lockfile updates to `quinn-proto` 0.11.19 and `rustls` 0.23.46.

`npm audit --omit=dev` reports no vulnerabilities; `npm run audit:rust` passes with the two allowed warnings (unmaintained `unsafe-libyaml`, yanked `zip` 4.6.1).

## Dependency remediation — 2026-10-20

Found by the nightly audit after the 0.1.8 release:

- RUSTSEC-2026-0367, RUSTSEC-2026-0368 and RUSTSEC-2026-0369 (`zip` 4.6.1, unsafe extraction of permissions and symlinks): reached only through the default `zip` feature of `tauri-plugin-updater`, which unpacks legacy zipped Windows updates and gzipped AppImages. Amby's updater artifacts are plain `.exe`, `.msi`, `.AppImage` and `.app.tar.gz` (macOS extraction does not use that feature), so the dependency now disables default features and keeps `rustls-tls` and `system-proxy`. `zip` is no longer in `Cargo.lock`.
- New unmaintained warnings for `zbus_names`, `zvariant` and `zvariant_derive` (RUSTSEC-2026-0370 to RUSTSEC-2026-0372) come from the Linux D-Bus chain and do not fail the audit.

## Known limitation — Windows system trash

`DeleteMode::System` uses `SHFileOperationW` with `FOF_ALLOWUNDO | FOF_NOCONFIRMATION`.
For items the Recycle Bin cannot hold (too large, network drives) Windows may delete
permanently without a warning. Not reproduced or fixed here (no Windows run).

## Official package signing key leaked — revoked in code, new key pending — 2026-10-02 / 2026-11-17

**Severity: high. Code side done (MOD-01); the owner still has to create the new key.**

The private half of the former official Ed25519 key `amby-official-2026` was committed in
`scripts/build-modules.mjs` and, as a "test" key, in
`src/lib/modules/package-manager/validator.ts`. It has been in git history since
commit `14ed478`; removing it from the tree does not un-leak it, so the key is **revoked**:
it is trusted nowhere and must be treated as compromised. Anyone with repository read
access could sign a package that the old build accepted as official. At no point were
installed modules executed (`INSTALLED_MODULE_EXECUTION_ENABLED = false`,
`THIRD_PARTY_PACKAGES_ENABLED = false`), and `dist-modules/` is not committed or shipped, so no
released build contains a package signed by the old key.

Done in code (2026-11-17):

- New key id `amby-official-2026-11`, created by the owner on 2026-11-17; its public half is
  `OFFICIAL_ED25519_PUBLIC_KEY_HEX` in `src-tauri/src/package_manager.rs` and `validator.ts`, and
  the private half exists only in the owner's macOS Keychain. Both verifiers reject an all-zero
  key explicitly. `amby-official-2026` is not accepted.
- No private key in the repository. Tests sign with an ephemeral key generated at test
  time (`package-manager/test-signing.ts`, Rust `TestSigner`) that is not in the production trust
  list. Guard tests fail if the old public key or the test key is trusted, if the Rust and
  TypeScript anchors differ, or if third-party packages / installed-module execution are enabled
  while the official key is the placeholder.
- `scripts/build-modules.mjs` reads the private key from the macOS Keychain or from the CI
  secret `AMBY_MODULE_SIGNING_KEY` (never from the repo), refuses to build if it is missing or does
  not match the trusted public key.

Owner steps:

1. On the owner's Mac run `npm run modules:new-key`. It generates the pair, stores the private key
   (PKCS8 DER as hex) in the Keychain (service `amby-module-signing`, account
   `amby-official-2026-11`) via `security -i`, so the secret is never in argv, and prints only the key
   id and the public key. It refuses to overwrite an existing entry unless `--replace` is passed.
2. Give the printed public key (not secret) to the developer, who puts it into both
   `OFFICIAL_ED25519_PUBLIC_KEY_HEX` constants (done 2026-11-17). For CI put the same private key in the secret `AMBY_MODULE_SIGNING_KEY`; take it
   from the Keychain by hand, never through chat or a file in the repository.
3. Run `npm run build:modules` to re-sign packages. Reissue anything that was distributed under the
   old key. Do not enable installed-module execution or third-party packages before that and the
   isolation work described in `execution-policy.ts`.

## npm audit — 2026-10-02

Run with the owner's consent (package names and versions are sent to the npm
registry). Before: 3 findings — `brace-expansion` 5.0.9 (high, dev tooling via
eslint/minimatch), `dompurify` 3.4.15 (low, via mermaid/Excalidraw) and
`markdown-it` 14.3.0 (moderate, direct). `npm audit fix` (no `--force`, scripts
off) moved the lockfile to `brace-expansion` 5.0.12, `dompurify` 3.4.16 and
`markdown-it` 14.3.2; `package.json` is unchanged. After: 0 vulnerabilities for
the full tree and for `--omit=dev`. This closes the "npm audit not run" item of
handoff stage 2. The exceptions listed for Rust (`npm run audit:rust`) are
unchanged and were not re-reviewed here.

## Dependency remediation — 2026-10-28

The beta release gate identified GHSA-cg2g-xh64-v4q7, GHSA-mrv2-3pqr-j5jr and
GHSA-c6gr-qvv4-5v3f in DOMPurify, and GHSA-vfgh-jcmw-g37q and GHSA-gfr2-rv44-r23c
in markdown-it. The lockfile selects DOMPurify 3.4.17 and markdown-it 14.3.3.
Rust TLS verification uses rustls-webpki 0.103.16, webpki-root-certs and
webpki-roots 1.0.11 (RUSTSEC-2026-0381 to 0383). Tokio 1.53.3 addresses the
I/O safety warning RUSTSEC-2026-0386. Existing documented Rust exceptions are
unchanged.
