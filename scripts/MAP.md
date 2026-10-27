# Tooling map

The command source of truth is [package.json](../package.json), not copied
command lists in historical plans. Use Node.js 20.19+ or 22.12+, npm 10+, and Rust.

| Task                                                                                                               | Owner / command                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent map links, reachability and size                                                                             | [check-project-map.mjs](check-project-map.mjs), `npm run docs:check`                                                                                                                                         |
| Version consistency                                                                                                | [check-version-sync.mjs](check-version-sync.mjs), `npm run version:check`                                                                                                                                    |
| Signed update channels, release tag parsing and Windows MSI version mapping                                        | [update-channels.mjs](update-channels.mjs), [update-channels.test.mjs](update-channels.test.mjs); release workflow publishes `stable.json` and `beta.json` on the orphaned `update-feed` branch              |
| Generated binding drift                                                                                            | [check-bindings.mjs](check-bindings.mjs), `npm run bindings:check`                                                                                                                                           |
| Module bundles                                                                                                     | [build-modules.mjs](build-modules.mjs), `npm run build:modules`                                                                                                                                              |
| Native storage contract / UI smoke                                                                                 | [run-native-contract.mjs](run-native-contract.mjs), [run-native-ui.mjs](run-native-ui.mjs)                                                                                                                   |
| Large-vault / database / debug benchmarks                                                                          | [run-large-e2e.mjs](run-large-e2e.mjs), [generate-database-fixture.mjs](generate-database-fixture.mjs), [run-database-benchmark.mjs](run-database-benchmark.mjs), [benchmark-debug.mjs](benchmark-debug.mjs) |
| macOS debug-binary signing for the Keychain prompt (cargo runner from [.cargo/config.toml](../.cargo/config.toml)) | [dev-sign-run.sh](dev-sign-run.sh), `npm run dev:sign-check`, [docs/dev-signing.md](../docs/dev-signing.md)                                                                                                  |
| Rust dependency audit                                                                                              | [audit-rust.sh](audit-rust.sh)                                                                                                                                                                               |
| Sync requirement coverage (`sync/` tests name every О/Р/С)                                                         | [sync-req-check.mjs](sync-req-check.mjs), `npm run sync:req-check`; workspace commands in [sync/MAP.md](../sync/MAP.md)                                                                                      |
| Icons / CSS density transform                                                                                      | [generate-app-icons.mjs](generate-app-icons.mjs), [postcss-density-scale.mjs](postcss-density-scale.mjs)                                                                                                     |
| Frontend build / tests / unused-code checks                                                                        | [vite.config.ts](../vite.config.ts), [vitest.config.ts](../vitest.config.ts), [knip.json](../knip.json)                                                                                                      |
| Real-browser editor checks (WebKit)                                                                                | [playwright.config.ts](../playwright.config.ts), `npm run test:browser`; first `npm run test:browser:install`. See [the verification map](../tests/MAP.md)                                                   |
| CI gates and release automation                                                                                    | [.github/workflows/](../.github/workflows/)                                                                                                                                                                  |

`npm run verify` aliases the full gate, including formatting, Knip, Rust checks,
tests and binding drift. `verify:fast` is for iteration. Every completed batch
still requires `npm run build`; do not weaken checks to make a batch pass.

For releases read [the cumulative release rules](../docs/agent-guidelines.md#public-change-log-and-cumulative-releases)
and [update-system.md](../docs/update-system.md). Every change updates
[upd_next.md](../updates/upd_next.md), but ordinary changes do not bump a version.
Build outputs and machine-specific benchmark evidence must not be committed.

Branches move only through [promote.mjs](promote.mjs) (`npm run promote -- beta|main`): it
merges `dev` → `beta` or `beta` → `main` and removes the development files listed in
[dev-only-paths.txt](dev-only-paths.txt), which exist only on `dev`.
