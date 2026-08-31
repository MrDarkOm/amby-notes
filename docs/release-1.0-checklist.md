# Release 1.0 checklist

Current working-tree evidence (Windows, 2026-09-01):
[remaining critical progress](remaining-critical-progress.md).
This is not a released or fully accepted candidate.

## Automated local gates

- [x] Data identity, lossless frontmatter, index, search, recovery, and
      backend reliability regression suites.
- [x] Browser storage contract, including Unicode and error semantics.
- [x] Real Windows WebView/Tauri/Rust/filesystem storage contract.
- [x] Rust formatting, strict Clippy, Rust tests, and generated IPC bindings.
- [x] `npm run verify:full` from clean committed candidate `974ff43`.

## Required release-machine gates

- [x] Native Tauri smoke: open, edit, save, reopen, rename, vault switch, and
      external edit/rename/delete/create.
- [x] Windows x64 production MSI and NSIS build.
- [x] NSIS silent install/uninstall lifecycle in an isolated directory; uninstall
      registration and cleanup verified on the exact final candidate. Artifact is
      not code-signed.
- [ ] Windows installer installation and production critical-flow smoke.
- [ ] macOS production build and critical-flow smoke.
- Linux: **deferred / not claimed for this release verification**.
- [ ] Compatibility-vault checks on every supported platform.

Do not release if any check exposes possible user-data loss, silent Markdown or
YAML mutation, non-recoverable index divergence, vault escape, or credential
exposure.
