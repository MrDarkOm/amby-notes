# Tooling map

The command source of truth is [package.json](../package.json), not copied
command lists in historical plans. Use Node.js 20.19+ or 22.12+, npm 10+, and Rust.

| Task                                        | Owner / command                                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent map links, reachability and size      | [check-project-map.mjs](check-project-map.mjs), `npm run docs:check`                                                                                                                                         |
| Version consistency                         | [check-version-sync.mjs](check-version-sync.mjs), `npm run version:check`                                                                                                                                    |
| Generated binding drift                     | [check-bindings.mjs](check-bindings.mjs), `npm run bindings:check`                                                                                                                                           |
| Module bundles                              | [build-modules.mjs](build-modules.mjs), `npm run build:modules`                                                                                                                                              |
| Native storage contract / UI smoke          | [run-native-contract.mjs](run-native-contract.mjs), [run-native-ui.mjs](run-native-ui.mjs)                                                                                                                   |
| Large-vault / database / debug benchmarks   | [run-large-e2e.mjs](run-large-e2e.mjs), [generate-database-fixture.mjs](generate-database-fixture.mjs), [run-database-benchmark.mjs](run-database-benchmark.mjs), [benchmark-debug.mjs](benchmark-debug.mjs) |
| Rust dependency audit                       | [audit-rust.sh](audit-rust.sh)                                                                                                                                                                               |
| Icons / CSS density transform               | [generate-app-icons.mjs](generate-app-icons.mjs), [postcss-density-scale.mjs](postcss-density-scale.mjs)                                                                                                     |
| Frontend build / tests / unused-code checks | [vite.config.ts](../vite.config.ts), [vitest.config.ts](../vitest.config.ts), [knip.json](../knip.json)                                                                                                      |
| Real-browser editor checks (WebKit)         | [playwright.config.ts](../playwright.config.ts), `npm run test:browser`; first `npm run test:browser:install`. See [the verification map](../tests/MAP.md)                                                   |
| CI gates and release automation             | [.github/workflows/](../.github/workflows/)                                                                                                                                                                  |

`npm run verify` aliases the full gate, including formatting, Knip, Rust checks,
tests and binding drift. `verify:fast` is for iteration. Every completed batch
still requires `npm run build`; do not weaken checks to make a batch pass.

For releases read [the cumulative release rules](../docs/agent-guidelines.md#public-change-log-and-cumulative-releases)
and [update-system.md](../docs/update-system.md). Every change updates
[upd_next.md](../updates/upd_next.md), but ordinary changes do not bump a version.
Build outputs and machine-specific benchmark evidence must not be committed.
