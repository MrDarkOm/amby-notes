# Release 1.0 checklist

## Automated local gates

- [x] Data identity, lossless frontmatter, index, search, recovery, and
      backend reliability regression suites.
- [x] Browser storage contract, including Unicode and error semantics.
- [x] Rust formatting, strict Clippy, Rust tests, and generated IPC bindings.
- [ ] `npm run verify:full` from a clean tree.

## Required release-machine gates

- [ ] Native Tauri smoke: open, edit, save, reopen, rename, vault switch, and
      external edit/rename/delete/create.
- [ ] Windows build, installer, and critical-flow smoke.
- [ ] macOS production build and critical-flow smoke.
- [ ] Linux production build and critical-flow smoke.
- [ ] Compatibility-vault checks on every supported platform.

Do not release if any check exposes possible user-data loss, silent Markdown or
YAML mutation, non-recoverable index divergence, vault escape, or credential
exposure.
