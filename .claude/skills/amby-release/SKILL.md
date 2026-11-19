---
name: amby-release
description: Use in Amby Notes when the owner asks to commit and push the accumulated changes ("закоммить и запушь", "выпусти версию"), to promote dev → beta → main, or to tag or publish a release.
---

# Cumulative release in Amby

The full rules are in [agent-guidelines.md → Public Change Log and Cumulative
Releases](../../../docs/ai/agent-guidelines.md#public-change-log-and-cumulative-releases). Read
that section before starting. This file is only the order of steps and the stop points. If they
disagree, the guidelines win.

## Stop points (each needs its own explicit go-ahead)

- **Commit and push** to `dev`: the owner's request to commit and push the accumulated changes.
- **Promote** (`npm run promote -- beta` or `-- main`): a separate request.
- **Tag** (`vX.Y.Z-beta.N` only on `beta`, `vX.Y.Z` only on `main`; never on `dev`) and
  **GitHub Release**: a separate request each.
- Never propose a version bump on your own.

## Commit and push the accumulated changes

1. `git status` / `git diff --stat`: review the **whole** diff. Do not drop unrelated working
   changes; ask about anything that does not look like part of the release.
2. Curate `updates/upd_next.md`, then move it to `updates/upd_<version>.md` with the date, in the
   style of `updates/TEMPLATE.md` and `updates/upd_0.1.8.md`: short, sectioned, scannable.
   Recreate an empty `updates/upd_next.md`.
3. Bump the **patch** version once, in `package.json`, `src-tauri/Cargo.toml`,
   `src-tauri/tauri.conf.json` and `crates/amby-cli/Cargo.toml` together. Never again because a check or push had to be retried.
4. `npm run version:check`, `npm run verify`, `npm run build`. Native packaging check when
   desktop behaviour changed. Report any failure; commit only if all pass or the owner accepts
   the named failure.
5. Commit on `dev` with a conventional subject, then push `dev`.

## Promote

- Only `npm run promote -- beta|main`, never a manual merge. It drops the development files
  listed in `scripts/dev-only-paths.txt` (agent instructions, maps, plans, these skills).
- A new development-only file must be added to `scripts/dev-only-paths.txt` first.
