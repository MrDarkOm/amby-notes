# Major dependency updates: what is left

Results of the 3 November 2026 experiment (branch `experiment/major-deps` from `d7f6561`, deleted on 6 November; commits
`a62a906` — Tailwind 4, `3c4394e` — Rust). The branch fell 75 commits behind `dev`, so it does not need to be
carried over: each update is redone from `dev`, as a separate PR, following the steps below.

## Already in `dev`

KaTeX 0.19, markdown-it 15, Mermaid 12, Motion 14, Vitest 5, notify 8 and TypeScript 6. The pins remain
(without them tests and `knip` break): `happy-dom` 20.11.2, `@tanstack/react-virtual` 3.14.9, `knip` 6.31.0.

## Results for the remaining ones

| Package                          | Experiment result | Data risk | Decision                                      |
| -------------------------------- | ----------------- | --------- | --------------------------------------------- |
| tailwindcss 4                    | worked, 155 files | none      | take as a separate PR after checking screens  |
| rusqlite 0.41 + sha2 0.11        | worked, ~20 lines | medium    | take together, with a check on a copy         |
| hkdf 0.13, hmac 0.13, argon2 0.6 | worked, 1 line    | high      | take after checking against vectors           |
| chacha20poly1305 0.11            | did not work      | high      | do not take: the `stream` feature was removed |
| keyring 4                        | did not work      | medium    | do not take: key handling must be rewritten   |
| ureq 3                           | not tried         | none      | later, test client only                       |
| TypeScript 7                     | did not work      | none      | wait for support in `typescript-eslint`       |
| happy-dom 21, removing the pins  | did not work      | none      | do not take                                   |

## Tailwind 4

What the official upgrader (`npx @tailwindcss/upgrade`) did:

- renamed utilities (`shadow-sm` → `shadow-xs` and the like) in ~150 components;
- moved `tailwind.config.ts` into an `@theme` block in `src/themes/app.css` and deleted the config file;
- `postcss.config.js` was rewritten by hand: the `@tailwindcss/postcss` plugin, without `autoprefixer` and `postcss`;
  the density plugin `scripts/postcss-density-scale.mjs` stays last, the `compact` rules are still in the build;
- the Tailwind config was removed from `knip.json`.

Risks:

- the upgrader **mistakenly replaced three lines that were not classes**: the event name `blur`, the button variant
  `outline` and a word in a comment. After it, the whole diff must be reviewed by eye, not just the build;
- the visual comparison was done selectively and in windows of different sizes at the time. Before merging, a full pass
  over all screens is needed in the light and dark themes and in `compact` mode;
- new components written after 3 November will also be rewritten by the upgrader — run it again rather than
  carrying over the old diff.

What to update in the documentation: the maps currently do not mention `tailwind.config.ts`, but the theme map
`src/themes/MAP.md` must note that the Tailwind theme (`@theme`) now lives in `app.css`; `knip.json` and
`postcss.config.js` — as they stand. The rule "Prefer Tailwind utilities" in
[agent-guidelines.md](../../ai/agent-guidelines.md) stays as is.

## rusqlite 0.41 and sha2 0.11

- `src-tauri` and `sync/` are updated **simultaneously**: they share a `sqlite3` build.
- For `u64` the `fallible_uint` feature is needed: a number greater than `i64::MAX` now produces an error instead of being written silently.
  This is stricter and safer, but affects the shared database and the index.
- sha2 0.11 removed the `{:x}` format for the hash. It was replaced by byte-by-byte hex with the same result in four places:
  `ai/chats.rs`, `ai/consent.rs`, `ai/turn.rs` (test), `index/note_index.rs` (`body_revision`). Revisions
  in the database and AI consents stay the same — this must be confirmed by a test with a recorded hash value.

Check before merging: open a copy of a real vault with the old and the new version, compare the index and
revisions, check database migrations and recovery; `npm run rust:test`, `sync/` tests, strict Clippy.

## Sync cryptography (hkdf, hmac, argon2)

The experiment noted that the match of output bytes with the old versions was not verified. In fact such a check exists:
`sync/core/tests/crypto_reference_vectors.rs` compares password and recovery code keys, key wrappers,
headers and bodies against the independent vectors in `sync/vectors/format-v1.json`, and in the experiment the `sync/` tests passed.
But before merging it is necessary to:

- make sure the vectors cover every Argon2 and HKDF call (including new calls after 3 November);
- check on two computers: one on the old version, the other on the new one, sign-in and note exchange in the same
  space; then sign-in with the recovery code;
- rebuild and release the server image `ghcr.io/mrdarkom/ambynotes-sync`: the server uses hmac for the
  fake sign-in salt (`sync/server/src/http/account.rs`, П13) and rusqlite for its own database.

A byte mismatch makes already encrypted data and sign-in unreadable, so this update is done
only after sync has been verified on two computers (Э5) and not together with other changes.

## chacha20poly1305 0.11 and keyring 4

- chacha20poly1305 0.11 removed the `stream` feature on which body encryption (`sync/core`) is built. This is an on-disk
  and on-the-wire format: the move requires a new format version, vectors and a migration, not a package update.
- keyring 4 split the stores into separate crates and removed `apple-native`. Key handling with the
  keychain must be rewritten, and it must be checked on macOS and Windows that saved keys are still found after the update.
