# Sync: what remains

Status as of 12 November 2026. Plan and decisions: [../../sync-plan.md](../../sync-plan.md). Done: Э0–Э4б,
appendix Е, gates, real vaults (27 October), the owner's server, key and token as one entry in the
keychain, password change (4 November), note properties under appendix З (5–7 November), earlier versions and
deleted files from the server under appendix И, the 30 MB file limit, open registration, login change and device names
(11–12 November), deleting a space from the server under appendix Л (12 November, branch
`codex/sync-delete-space`).

## How to start a new session

- Read this file, then only the needed section of the plan: stages — section 6, properties — appendix З.
- The working order is section 6 of the plan, "Tests first". Strict parts: a separate red-tests session → a commit of the
  tests with the owner's approval → a separate code session, tests frozen. Lightweight ones (interface): tests
  as the first commit, then code.
- New rules are first written into the plan (decisions with a number and a date); anything debatable for the user goes as a
  question to the owner. Work in a branch from `dev`, merge into `dev` without squash when the stage is green.
- Commits, merging, push and release — only with the owner's approval.

## Order (the owner's decision, 5 November; refined 6 November)

Item 1 is done by the owner; it does not block items 2 and 3 — the rules and tests for them are written in parallel.

1. **Manual check of properties on two computers — closed 13 November (the owner's decision: passed 6–7 November, a separate review of notices is not needed).** (done by the owner, on copies of vaults: on first
   open the vault migrates itself to the new format). Scenario: an appearance edit on one computer
   (icon, variant color, variants, type) is visible on the other; simultaneous appearance edits of different
   notes merge without a conflict; a simultaneous edit of the same note; renaming a property;
   an old version of the app on the second computer. Findings go to a fix branch from `dev`.
2. **Э5: earlier versions and deleted files — done** (appendix И, `259cbae7`): versions — in the note's
   history, deleted ones — in the "On the server" section («На сервере») of the archive.
3. **30 MB file limit** (the owner's decision, 11 November 2026): Amby is a note-taking app, support for large
   files is not required. The maximum source size of one synced file is 30,000,000 bytes;
   the encrypted body needs a separate margin for overhead data. Instead of lifting the restriction through
   streaming encryption, align the client and server checks and the message in the interface. A file over
   the limit is not deleted from the vault but stays in "Not synced" («Не синхронизируется»). **Implemented in code:**
   the engine limit is 30 MB; on the live server an encrypted-body limit of 30,416,160 bytes is applied. Remove the work on supporting files larger than 30 MB from the queue.
4. **Э5: deleting a space from the server from the app — implemented 12 November** (appendix Л of the plan):
   `DELETE /v1/spaces/{id}`, client, runtime, the `sync_delete_space` command, the action «Удалить с сервера…» (Delete from server…)
   with typing the exact name. Only the server copy and its versions are deleted; **local files on all
   devices remain**, exchange with the deleted space stops, and other devices
   turn it off themselves. Tests in a commit before the code. **Deployed to Omlet on 12 November:** image
   `delete-space-20261112`, backup `pre-delete-space-20261112`, schema 2 and table counters
   unchanged. Native check of two windows (`test:native:sync-vault`, local server) — 28/28.
   The check on two physical computers (Mac and Windows, live server, a test space)
   was passed on 12 November: a note and an unsaved edit on Windows were preserved, Windows itself turned off
   exchange (`enabled=0`) and did not resume it after a restart. Remarks: on Windows the deletion was
   shown as an error with «Повторить» (Retry); in the log `sync_pass_failed` without a cause code; in the
   confirmation the space size was «0 Б» (0 B) — all three fixed (`f49d2773`). Mutation
   check of deletion: server 1 caught / 4 do not build, client 1/1 caught, no survivors.
   Test report: [sync-delete-space-tests.md](sync-delete-space-tests.md).
5. **Э2б without QR**: open registration is implemented in code (11 November): the setting is off by default,
   the app reads the server mode and offers the invitation separately. **Deployed to Omlet on 11 November:**
   registration is open, new accounts get 1 GB, the body limit is 30,416,160 bytes (30 MB of source file).
   The earlier shared quota of existing accounts is preserved. Before the update, backups were made,
   and preservation of all earlier table fields during the schema 1 → 2 transition was checked. 271 conformance tests passed,
   along with a native check of the container and 11 registration/recovery steps over public HTTPS. The temporary
   account and test containers were deleted.
   Login change with the current password and renaming of encrypted device names were added on 11 November:
   image `identity-20261111` deployed with a full backup `pre-identity-20261111`, the schema stayed 2,
   registration and plans preserved. 66 API scenarios of the new image and 14 native steps were checked.
   On 12 November `username-20261112` was deployed: logins are canonicalized to lowercase on login,
   registration, recovery, renaming and the availability check. No account migration is needed;
   backup `pre-username-20261112`, registration and limits preserved. 81 API checks
   and 14 native steps with capital letters in the login passed.
   Simplification of the first sign-in was done on 12 November (appendix М of the plan): `login` and `recover` without a name,
   the client signs in once and sets the name, an old server — the earlier way; tests in a commit before the code,
   no surviving mutants. **Deployed to Omlet on 12 November:** image `unnamed-20261112` (with SQLite 3.54), backup `pre-unnamed-20261112`, schema 2 and table counters unchanged. QR is deferred until the mobile app.
   `RUSTSEC-2026-0459` in bundled SQLite was closed on 12 November: `rusqlite` 0.41 (SQLite 3.54) with
   `fallible_uint` in the app and in `sync/`; all tests of both workspaces are green, `cargo deny` is clean.
   It will reach the Omlet server with the next image update.
6. **Э5: public documentation** for one's own server, the `docs/sync-format.md` contract (the file does not exist yet),
   a security review of the whole stage. The format contract `docs/sync-format.md` was written on 13 November and checked against the code (plan discrepancies —
   [sync-format-discrepancies.md](sync-format-discrepancies.md)). The security review was carried out on 13 November: [sync-security-review.md](sync-security-review.md)
   (findings Б1–Б11, fixes — tests first, by the owner's decision). Publishing the Docker image and a release — only with separate permission.
7. **One's own server on the internet** (before giving sync to others). Conditions: **only after item 6**
   (the security review); the properties migration measurement was done on 6 November (З68) — other people
   will not have copies of vaults. Hetzner "Omlet", domain and HTTPS
   through Caddy, data on a separate volume, only ports 80 and 443 open, backups.

## Properties (appendix З): loose ends

- Manual check on two computers — item 1 above. On 6 November it found two bugs, fixed in the branch (З.13 of the plan, З64–З66): groups did not get into sync (the `VaultFs` walk did not enter `.amby/properties`) and the panel did not re-read properties after other people's changes. Repeat the check: an appearance edit on one computer reaches `state.db`, the server and is visible in the other's open panel. The repeat check on 6 November: groups sync within seconds, but the sync notices owner was not connected to the app (З67) — fixed; look with your own eyes at the notices about a conflict, a deleted and a returned note, which were not shown at all before.
- Closed on 6 November: the first meeting of already migrated vaults merges by notes against an empty database (З64а); the per-row write (З50) was already done; the migration measurement on a large vault — З68.
- Done on 7 November (З69): a conflict of a properties group with the database is resolved by notes — two cards «Этот компьютер» (This computer) / «Другой компьютер» (Other computer) with the difference itself, in the sync settings and in the window by the ⚠ icon (the core's `resolve_group`). A set without a database is still resolved by the whole file.
- Done on 7 November (З70, the owner's decision after the check on two computers): a single note changed on two computers is not a conflict; the last edit by the row's `edited` time stays. The З69 window remained only for edits of old versions without a time. The "this / other computer" labels in it were swapped for sets created on another computer — fixed on 13 November (the sides and the whole-file buttons swap places by `createdHere`).
- The branches `sync/props-tests` and `claude/props-core-2cb6bb` (appendix Ж) are already deleted (on 6 November they exist neither locally nor on GitHub).
- Working copies from `.claude/worktrees/` were removed on 6 November, merged branches deleted. The `shadow_check` tests build
  in release mode was fixed on 6 November.

## Subscription (13 November, the owner's decision)

Registration is open, but only an account with a subscription syncs; without one the account exists (login, device
names, password), data on the server can be read, restored and deleted, sending is closed. The subscription
is granted and removed by the administrator (`user plan set <name> <plan> [--until YYYY-MM-DD]`, `--default`),
the buy button in the app is a stub. The rules are appendix Н of the plan (Н1–Н12). **Deployed to Omlet on 13 November:** image
`subscription-20261113` (`dev` `ecd14e56`), backup `pre-subscription-20261113`, schema 2 → 3
(copy `pre-v3-*`), table counters unchanged; the default plan is `free` (no sync), the subscription is
`notes` (1 GB, file up to 30 MB), earlier accounts stayed on `legacy`. 21 API checks passed on a copy and
through public HTTPS; temporary accounts and the test container were deleted. The fix for Б3 (appendix Т) was deployed
the same day: image `fix-b3-20261113` (`dev` `7480f1bb`), backup `pre-fix-b3-20261113`, schema 3 unchanged,
22 checks on a copy and through HTTPS. The server limits (appendix Х: free-space reserve of 1 GiB,
login up to 64 KiB, no more than 4 large bodies, deletions without a subscription only of what exists) were deployed the same day:
image `limits-20261113` (`dev` `0bc82828`), backup `pre-limits-20261113`, 25 checks on a copy and through HTTPS.
The `notes` plan was given a history limit of 1 GB (`max_history_bytes`). Б9 was closed the same day: in Nginx Proxy Manager, Force SSL and HSTS
were enabled for the sync host (settings backup `npm-before-forcessl-20261113`). Б10 (appendix Ц: a password when deleting from the server) was deployed
the same day: image `b10-20261113` (`dev` `fd5cb969`), backup `pre-b10-20261113`, 27 checks on a copy and through
HTTPS. Payment, sign-in with
Google and Apple remain deferred.

## Deferred by the owner (5 November): monetization

The paid "Amby Server" («Сервер Amby»; selected by default in the interface, registration is for now by invitation code), plans and
payment, sign-in with Google and Apple (for the account only; it does not replace the encryption password). Do not
propose until the owner returns to the topic themselves.

## Later, no deadline

- Connecting a new device by QR — when the mobile app appears.
- Selective folder sync (currently the whole vault is synced, except service files).
- Shared spaces with real-time editing (Yjs); each space already has its own key with an epoch.
- Multiple key epochs (Р14).
- Cleanup of incomplete conflict sets (Г23): currently only shown in the log.
- Publishing a site from notes as a separate service (like Obsidian Publish).
- Mobile version: [../mobile.md](../mobile.md).
