# Amby updates (release notes)

This folder holds the release notes of the Amby app. Each release has its own file with the changes a user can see.

Everything here is written in English (owner's decision, 2026-11-17). Notes released before that date and entries accumulated in Russian stay as they are; Russian entries in `upd_next.md` are translated when they are condensed at release.

## Files

- **[`upd_next.md`](upd_next.md)** — the working draft that collects changes before the next release. Every new feature, optimization, fix and developer note goes here while work is in progress.
- **`upd_<version>.md`** (for example [`upd_0.1.8.md`](upd_0.1.8.md)) — the release notes. The GitHub release text and the in-app update text are built from them automatically.
- **[`TEMPLATE.md`](TEMPLATE.md)** — the release notes template: a short intro, "Highlights", sections by area, "For developers" last.
- **[`release-footer.md`](release-footer.md)** — the "Installation" block appended to every GitHub release.

## How updates are kept

1. **During development:**
   - Every change (feature, interface, configuration, documentation or platform) is described in [`upd_next.md`](upd_next.md).
   - Draft entries may be detailed; they are condensed into the template at release.
   - Wording is short, correct and states the real benefit for the user, without raw hashes or unverified promises.

2. **Before a release (when the owner asks to commit and push the cumulative release):**
   - The whole diff of the accumulated changes is reviewed.
   - A file for the new version `updates/upd_<version>.md` is created from [`TEMPLATE.md`](TEMPLATE.md): entries from `upd_next.md` are not copied as they are but condensed into "Highlights" and short bullets by area.
   - `updates/upd_next.md` is cleared for the next cycle.
   - The patch version is raised in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
   - Required checks run: `npm run version:check`, `npm run verify`, `npm run build`.
   - The notes in the new `upd_<version>.md` become the GitHub release description.

## Version history

- [Next version (in development)](upd_next.md)
- [0.1.9 — 2026-11-26](upd_0.1.9.md)
- [0.1.8 — 2026-10-16](upd_0.1.8.md)
- [0.1.7 — 2026-10-11](upd_0.1.7.md)
- [0.1.6 — 2026-10-02](upd_0.1.6.md)
- [0.1.5 — 2026-09-27](upd_0.1.5.md)
- [0.1.4 — 2026-09-20](upd_0.1.4.md)
- [0.1.3 — 2026-09-11](upd_0.1.3.md)
- [0.1.2 — 2026-09-11](upd_0.1.2.md)
- [0.1.1 — 2026-09-08](upd_0.1.1.md)

---

_Note: the former single `updates.md` file was replaced by per-version files._
