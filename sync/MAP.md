# Sync workspace map

Encrypted sync through a self-hosted server. The plan and every decision (Р1–Р14, promises О1–О8,
failures С1–С14) are in [sync-plan.md](../docs/sync-plan.md); read it before changing anything here.
**Tests come before code** (plan, section 6): do not edit a test to make it pass. A test that looks
wrong stops the work and is fixed in its own commit after review.

A separate Cargo workspace (decision Р12): it does not touch `src-tauri/target` or the app gates.
License AGPL-3.0-only. Not wired into `src-tauri` yet.

| Path                                   | Owns                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| [proto/](proto/src/lib.rs)             | wire constants of the protocol: part size, machine error codes (appendix Б)          |
| [core/](core/src/lib.rs)               | cryptography (Э1) and the sync engine (Э3), no Tauri; I/O only through interfaces    |
| [server/](server/src/lib.rs)           | blind storage server (Э2): all of appendix Б; Dockerfile, compose with Caddy, README |
| [conformance/](conformance/src/lib.rs) | server conformance suite: HTTP tests against any address, real client crypto (Э2)    |
| [reference/](reference/)               | independent Python reference of the byte format; generates `vectors/format-v1.json`  |
| [vectors/](vectors/)                   | test vectors: `standards.json` (from RFCs, by hand) and `format-v1.json` (generated) |
| [deny.toml](deny.toml)                 | cargo-deny: licenses and advisories                                                  |
| [core/fuzz/](core/fuzz/Cargo.toml)     | cargo-fuzz targets (nightly only)                                                    |

Commands (see [package.json](../package.json)): `npm run sync:test`, `sync:lint` (fmt, clippy,
cargo-deny), `sync:conformance:red` (sorts the failures of the stub server by reason),
`sync:conformance:docker` (build the image, run the suite against the container), `sync:req-check` ([script](../scripts/sync-req-check.mjs): every requirement is named
in a test), `sync:mutants`, `sync:fuzz -- <target>`, `sync:reference:setup`,
`sync:reference:vectors`. CI: [sync.yml](../.github/workflows/sync.yml).

The exact byte format is appendix "Точный формат v1" of the plan; the Python reference and the Rust
code must agree with it byte for byte.

Stage report with the red run and open questions for review: [sync-e1-report.md](../docs/Road/sync-e1-report.md).

The protocol is appendix Б of the plan (decisions П1–П41). The suite starts a server in the process
(`AMBY_SYNC_URL` unset) or goes to the address in `AMBY_SYNC_URL`, creating users through
`AMBY_SYNC_ADMIN_CMD`; tests that move the clock, restart the server or read its data directory
always use their own server in the process. Stage report with the red run, the implementation and the
mutation run: [sync-e2-report.md](../docs/Road/sync-e2-report.md).

Inside [server/src/](server/src/lib.rs):

| File                                            | Owns                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [db.rs](server/src/db.rs)                       | SQLite in WAL mode, schema version and migrations (checked before and after), `instance_id`, fake-salt secret |
| [store.rs](server/src/store.rs)                 | `BlobStore` (files under `blobs/`, parts, atomic join) and `UserStore` (database) behind traits               |
| [state.rs](server/src/state.rs)                 | `AppState`: settings, clock, stores, the broadcast channel for event streams                                  |
| [config.rs](server/src/config.rs)               | `AMBY_SYNC_*` variables, the HTTPS rule                                                                       |
| [app.rs](server/src/app.rs)                     | the router; unknown path and wrong method answer in JSON                                                      |
| [http/util.rs](server/src/http/util.rs)         | errors (П4), strict hex (П2), reading a body with a limit (П8), token check (П5), client address (П16)        |
| [http/account.rs](server/src/http/account.rs)   | prelogin, enrol, login, recover, keys, devices (П11–П19)                                                      |
| [http/throttle.rs](server/src/http/throttle.rs) | the two failure counters (П16)                                                                                |
| [http/spaces.rs](server/src/http/spaces.rs)     | spaces and the ownership lookup (П6, П20)                                                                     |
| [http/blobs.rs](server/src/http/blobs.rs)       | bodies in parts, resume, ranges, quota (П21–П25, П42)                                                         |
| [http/commit.rs](server/src/http/commit.rs)     | the atomic commit (П26–П30)                                                                                   |
| [http/feed.rs](server/src/http/feed.rs)         | compressed change feed, history (П31–П33)                                                                     |
| [http/events.rs](server/src/http/events.rs)     | server-sent events, closed for a revoked device (П34)                                                         |
| [maintenance.rs](server/src/maintenance.rs)     | cleanup by the `Clock` only (П35–П37)                                                                         |
| [admin.rs](server/src/admin.rs)                 | `user add                                                                                                     | list | remove`, `backup` (П38, П39) |
| [main.rs](server/src/main.rs)                   | the command line, `serve` with cleanup every ten minutes, `healthcheck`                                       |

Running your own server: [server/README.md](server/README.md) and
[server/docker-compose.yml](server/docker-compose.yml).
