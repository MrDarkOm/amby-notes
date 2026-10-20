# Sync workspace map

Encrypted sync through a self-hosted server. The plan and every decision (Р1–Р14, promises О1–О8,
failures С1–С14) are in [sync-plan.md](../docs/sync-plan.md); read it before changing anything here.
**Tests come before code** (plan, section 6): do not edit a test to make it pass. A test that looks
wrong stops the work and is fixed in its own commit after review.

A separate Cargo workspace (decision Р12): it does not touch `src-tauri/target` or the app gates.
License AGPL-3.0-only. Not wired into `src-tauri` yet.

| Path                                   | Owns                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| [proto/](proto/src/lib.rs)             | wire types and format constants (empty until Э2)                                     |
| [core/](core/src/lib.rs)               | cryptography (Э1) and the sync engine (Э3), no Tauri; I/O only through interfaces    |
| [server/](server/src/main.rs)          | blind storage server and Dockerfile (Э2)                                             |
| [conformance/](conformance/src/lib.rs) | server conformance suite that runs against any address (Э2)                          |
| [reference/](reference/)               | independent Python reference of the byte format; generates `vectors/format-v1.json`  |
| [vectors/](vectors/)                   | test vectors: `standards.json` (from RFCs, by hand) and `format-v1.json` (generated) |
| [deny.toml](deny.toml)                 | cargo-deny: licenses and advisories                                                  |
| [core/fuzz/](core/fuzz/Cargo.toml)     | cargo-fuzz targets (nightly only)                                                    |

Commands (see [package.json](../package.json)): `npm run sync:test`, `sync:lint` (fmt, clippy,
cargo-deny), `sync:req-check` ([script](../scripts/sync-req-check.mjs): every requirement is named
in a test), `sync:mutants`, `sync:fuzz -- <target>`, `sync:reference:setup`,
`sync:reference:vectors`. CI: [sync.yml](../.github/workflows/sync.yml).

The exact byte format is appendix "Точный формат v1" of the plan; the Python reference and the Rust
code must agree with it byte for byte.
