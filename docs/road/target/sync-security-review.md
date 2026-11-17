# Sync: security review Э5

Date: 13 November 2026. Branch `sync/security-review` from `dev` (`1deb4b85`). What was reviewed: the server
(`sync/server/src/http/*`, `db.rs`, `store.rs`, `maintenance.rs`), the client (`sync/client`), the integration in
the app (`src-tauri/src/sync/*`, `src-tauri/src/commands/sync.rs`) and the settings of the live Omlet (read
only). The yardstick is the promises О1–О8, the threat model (section 3 of the plan) and appendices И, К, Л, М.

There are no fixes in this branch: each will go through section 6 of the plan (rule into the plan → red tests
by a separate session → approval of the tests commit → code).

## Summary in plain words

The encryption and the promise "the server cannot read the notes" hold: among the findings there is not a single path
by which the server or a stranger could read content, file names or keys. The findings are about
**availability and fairness of resources**: with open registration a stranger can fill the server's disk,
a large first upload can stall other devices, and a rare race can corrupt the
synchronization of someone else's space (not read it — only stop it).

| №   | Finding                                                                 | Risk              | Where                 |
| --- | ----------------------------------------------------------------------- | ----------------- | --------------------- |
| Б1  | Open registration does not limit the total disk usage                   | fixed (Н, Х1, Х2) | server, Omlet         |
| Б2  | A large commit is not read by other devices                             | fixed (Т4, Т5)    | engine, client        |
| Б3  | The row number of a deleted space passes to a new one                   | fixed (Т1–Т3)     | server (violates Л4)  |
| Б4  | Before login the server accepts JSON up to 64 MiB with no request limit | fixed (Х3, Х4)    | server                |
| Б5  | Record headers do not count toward the quota                            | mostly fixed (Х6) | server                |
| Б6  | SQLite is called synchronously from async handlers                      | low–medium        | server                |
| Б7  | No limit on event streams and no body-read timeout                      | low               | server                |
| Б8  | Parallel uploads of the same body share a temporary file                | low               | server                |
| Б9  | Omlet also answers over plain `http://`                                 | fixed (NPM)       | Omlet settings        |
| Б10 | Dangerous actions need only a token, no password                        | fixed (Ц)         | protocol              |
| Б11 | Minor differences in refusals and metadata                              | information       | server, documentation |

## Findings

### Б1. Open registration does not limit the total disk usage — high (fixed 13 November: subscription, Н; Х1, Х2)

**What was found.** Рег3 limits registration to 5 attempts per 15 minutes from one address, Рег5 gives each
new account 1 GB. There is no overall limit: neither a number of accounts, nor a total volume, nor a reserve of free
space. From one address that is up to 480 accounts a day, i.e. up to 480 GB of promised space; an
attacker may have many addresses.

**Why it matters.** On Omlet 18 GB of 75 GB is free, and this disk is shared with Vaultwarden, Linkwarden and other
services. A full disk stops not only sync but the neighbours too. Users' data is not
lost (SQLite rolls back what is unfinished), but the server stops accepting changes.

**Proposal.**

1. Server: `AMBY_SYNC_MIN_FREE_BYTES` — when free space is below the threshold, new uploads and registrations
   get `507 insufficient_storage`, while reading and deleting keep working (default, for example, 2 GB).
2. Server: `AMBY_SYNC_MAX_USERS` (optional) — how many accounts open registration may create,
   beyond that `409 registration_unavailable` (as now for a taken name).
3. Omlet: a separate volume or a size limit for `/data`, so that sync cannot take the neighbours' space.
   This is a change to the live server — only with your "yes".

### Б2. A large commit is not read by other devices — high (fixed 13 November, appendix Т)

**What was found.** The engine sends changes in batches of up to `max_commit_items` (10,000 on the server). The feed
(`/changes`) always returns a commit whole, even if it is larger than a page (Р2: a folder rename
arrives as one piece). The client accepts a response of no more than 4 MiB (`MAX_ANSWER_BYTES`). One record in
the feed with the shortest header is about 850 bytes of JSON, so a commit of roughly 4,900 files already does not
fit; with long paths, sooner.

**Why it matters.** The first upload of a vault of roughly 5,000 files or more (or a rename of a large folder)
goes through, but the second device cannot read that page — "response too large" on every
pass, and synchronization of the space stands still. Local files do not suffer. For "giving to other people" this is a
likely scenario: many people have Obsidian vaults of more than 5,000 files.

**Proposal.** The calculation above is an estimate from the code; a red test will confirm it first.

1. Engine: split a commit not only by the number of records but also by the request size (for example, no more than
   1,000 records and 1 MiB of JSON). Д50 already allows a folder rename to go in several commits.
2. Client: for the feed, accept a response up to the limit the server itself declared (`max_json_bytes` from
   `/v1/info`, but no more than 64 MiB). This also fixes spaces where such a commit already exists.

### Б3. The row number of a deleted space passes to a new one — medium (fixed 13 November, appendix Т)

**What was found.** The `spaces` table has an `INTEGER PRIMARY KEY` key without `AUTOINCREMENT`: if the
space with the largest row number is deleted, the next space created (by any user)
gets the same number. The commit, upload-start and body-part handlers find the space by
`(space_id, user_id)` **before** reading the request body, but write by row number, in a separate transaction.
Between them is the body read, which lasts as long as the client wants.

**Why it matters.** User A starts a commit, slowly sends the body, deletes their space and
waits until someone creates a new one. Their records (deletions without bodies) land in someone else's space B. They
do not allow reading anything, but the devices of B cannot decrypt them, and by Д5 the cursor stops before them:
synchronization of space B stops. This violates Л4 ("write requests after deletion get 404").
Without number reuse the same request currently gets `500` (foreign key violation), not `404`. In front of
Omlet stands nginx, which first accepts the whole body, so the window there is narrow; with Caddy from our
kit it is wide. Something similar but even rarer: a user's row number after `user remove`.

**Proposal.** Without a migration: inside each writing transaction, find the space anew by
`(space_id, user_id)` and check that the token is still alive; if not found — `404 not_found`. Add the rule to
Л4 and П26: "the ownership check and the write — in one transaction".

### Б4. Before login the server accepts JSON up to 64 MiB — medium (fixed 13 November: Х3, Х4)

**What was found.** `max_json_bytes` is 64 MiB by default and the same for all routes, including `prelogin`, `login`,
`recover`, `enroll`, where there is no token yet. The body is read into memory whole and parsed into a
`serde_json::Value` tree (several times larger than the source text). There is no limit on concurrent requests.

**Why it matters.** Without an account one can send several dozen such requests at once and eat the
server's memory (on Omlet 7.7 GB for all services).

**Proposal.** For the login and registration routes — 64 KiB; for the rest — a limit consistent with
Б2 (for example 16 MiB); an overall limit on concurrent requests (a semaphore, for example 64) answering `503`.

### Б5. Record headers do not count toward the quota — medium (mostly closed 13 November: Х6; Х5 cancelled)

**What was found.** The quota counts only bodies. A record header is up to 16 KiB, a commit can carry thousands of
deletion records without bodies, and versions are kept for 30 days.

**Why it matters.** One account can bloat the server's database by tens of megabytes per commit, bypassing the quota —
the same outcome as in Б1, but even without open registration.

**Proposal.** Count the length of headers (of current and stored versions) in quota usage; for a
server without a quota — at least a limit on the number of commits per minute per device.

### Б6. SQLite is called synchronously from async handlers — low–medium

**What was found.** The database is one connection behind a `std::sync::Mutex`, and handlers take it directly on
tokio threads. A long transaction (a commit of 10,000 records, quota counting, a cleanup waiting up to 30 s)
occupies a thread, and the others wait on the lock, also on tokio threads.

**Why it matters.** On Omlet's 4 cores a few simultaneous heavy requests stop the entire server,
including the event-stream pings. Data does not suffer.

**Proposal.** Run the database work through `spawn_blocking` (or one dedicated database thread).
It can be deferred until the first complaints about speed; the outside behavior does not change.

### Б7. No limit on event streams and no body-read timeout — low

**What was found.** One device can open any number of `/events` streams; each holds a connection
and queries the database every 15 seconds. The server itself does not limit the time spent reading a request body.

**Proposal.** No more than 4 streams per device (the oldest is closed); a body-read timeout
(for example 60 s without data). In the README for one's own server — advice about proxy limits.

### Б8. Parallel uploads of the same body share a temporary file — low

**What was found.** Two simultaneous uploads of the same part write to the same `part-N.tmp`, two `complete` calls — to
the same `body.tmp`. `complete` answers "done" even if the body was deleted in parallel (it does not check that the
row was updated).

**Why it matters.** Only to oneself: another user does not get in here, and the client verifies every body
(AEAD and hash), so a corrupted one will not be accepted — there will be a retry or an error.

**Proposal.** Unique names for temporary files; `complete` checks the number of updated rows.

### Б9. Omlet also answers over plain `http://` — low (fixed 13 November: Force SSL and HSTS in NPM)

**What was found.** `http://ambysync.omlet.space/v1/info` answers `200`, with no redirect to `https://`.
The app itself refuses `http://` for non-local addresses (П41), so your devices
are protected; the risk is for third-party clients and manual checks.

**Proposal.** Enable "Force SSL" and HSTS in Nginx Proxy Manager for this host. This is a change to the
live server — only with your "yes".

### Б10. Dangerous actions — token only — the owner's decision (fixed 13 November, appendix Ц)

**What was found.** Deleting a space from the server (Л), disconnecting any device and reading all the
encrypted data require only the device token; the password is needed for a password and login change. A password
change does not disconnect other devices.

**Why it matters.** If a token is stolen (an infected device is outside the threat model, section 3), the
server copies and their versions can be erased. Local files on the devices remain (Л7).

**A question for you.** Options: leave as is (describe it honestly); require the password for «Удалить с сервера…» (Delete from server…)
(requires a protocol change Л1); after a password change, offer to disconnect the other devices.

### Б11. Information: minor differences and metadata

- `POST /v1/spaces` with someone else's `space_id` answers `409 space_exists`, not `404`. The ID is 128 random
  bits and cannot be guessed; harmless, but worth recording as an exception to П6.
- Open registration by nature reveals whether a name is taken (`409`), and thereby bypasses the "fake salt" in
  `prelogin` (П13). Limited by Рег3. An account with non-standard Argon2 parameters is also distinguishable in
  `prelogin`. Add to О2 and the public documentation.
- The `revoked_tokens` table grows without cleanup (a row per disconnected device) — a minor matter.

## Decision on Б5 (13 November)

Counting headers in the quota (Х5) was cancelled: it diverged from the history cleanup by size limit and could erase
extra earlier versions. An account without a subscription can no longer create records (Х6), so bloating the database with
headers (empty folders, renames) can only be done by an account with a subscription and only deliberately; this is
limited by the history retention period and by the administrator removing the subscription. Separately found: earlier versions of bodies (history)
do not count toward the quota — they are limited by the plan's `max_history_bytes`; on Omlet the `notes` subscription plan has a
limit of 1 GB set (13 November). The `legacy` plan (the owner's earlier accounts) has no history limit.

## What was checked and is fine

- **Ownership on every route.** All space routes go through `owned_space` (a wrong id, someone else's and a
  non-existent space — the same `404`, П6); devices, bodies and versions are looked up inside their own
  space or account. Apart from the race Б3, there are no bypasses.
- **Identical refusals (П13–П16).** Login and recovery: one response for an unknown name, a wrong key and
  a missing password, constant-time comparison, unknown names count toward the attempt limit.
  The attempt limit is in the same transaction as the check; `X-Forwarded-For` is taken only with
  `TRUST_PROXY`, the last address; on Omlet the container is not published externally, and nginx appends the real
  address.
- **Leaks of open data.** Content, paths, device names and space names leave only
  encrypted (Ф34, Padmé); the server logs contain only the causes of internal errors, without request
  data. The password and the AK key are not sent to the server.
- **Client against a hostile server.** Only `https://` (except local addresses), no following of
  redirects, timeouts, a response limit of 4 MiB and an event line limit of 64 KiB, a check of the Argon2 parameters
  (a lower bound of 64 MiB — the server cannot weaken the password).
- **App.** A path from the server is accepted only if made of plain names, with no links on the way; the write is
  atomic; deleted items go to the trash. AK and the token are only in the system keychain and do not reach
  the log. Deleting a space does not touch local files (Л7).
- **Deletion (Л).** Rows are deleted in one transaction, files under the same lock; leftovers after a
  failure are removed by the cleanup; the deleted space's event stream is closed.
- **`cargo deny check`** in `sync/`: advisories, bans, licenses, sources — ok (13 November).

## Proposed order of fixes

1. **Б2** (another device getting stuck) and **Б3** (race, violation of Л4) — strict, tests before code.
2. **Б1, Б4, Б5** as one "server limits" package — strict; then an Omlet update with your "yes".
3. **Б6–Б8** — if possible in the same package, or later.
4. **Б9** and a volume for `/data` on Omlet — your "yes" for a server change.
5. **Б10** — per your decision.
