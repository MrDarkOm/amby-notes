# Modules and packages map

Owns feature lifecycle, capability checks, registries, profiles and package clients.
Feature UI lives under [workspace](../../components/workspace/MAP.md).

| Concern                                        | Owner                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Public module API / types                      | [index.ts](index.ts), [types.ts](types.ts)                                                                                                                                           |
| Module activation / deactivation               | [host/module-host.ts](host/module-host.ts)                                                                                                                                           |
| Registries / SDK / capabilities                | [host/registries.ts](host/registries.ts), [host/sdk.ts](host/sdk.ts), [host/capability-broker.ts](host/capability-broker.ts)                                                         |
| Built-in feature definitions                   | [host/builtins.ts](host/builtins.ts), workspace feature `*-module.tsx` files                                                                                                         |
| Safe mode                                      | [host/safe-mode.ts](host/safe-mode.ts)                                                                                                                                               |
| Workspace profiles and configuration migration | [profiles.ts](profiles.ts), [workspace-modules.ts](workspace-modules.ts), [module-migration.ts](module-migration.ts), [global-registry.ts](global-registry.ts)                       |
| Package discovery / validation / install       | [package-manager/catalog.ts](package-manager/catalog.ts), [package-manager/validator.ts](package-manager/validator.ts), [package-manager/installer.ts](package-manager/installer.ts) |
| Community runtime / sandbox / revocation       | [community/](community/)                                                                                                                                                             |
| Native package boundary and disk publication   | [commands/modules.rs](../../../src-tauri/src/commands/modules.rs), [package_manager.rs](../../../src-tauri/src/package_manager.rs)                                                   |
| User settings                                  | [settings-modules.tsx](../../components/workspace/settings/settings-modules.tsx), [settings-package-manager.tsx](../../components/workspace/settings/settings-package-manager.tsx)   |

A disabled module must not retain active capabilities or duplicate core persistence.
Keep crash recovery available independently of optional history UI. Validate
packages at both boundaries; a valid version is not an execution permission.
Read the package-version contract in [engineering.md](../../../docs/engineering.md)
and current implementation before changing installation or activation semantics.

Tests: host lifecycle/capability/workspace tests, community tests, package-manager
tests, [modular-acceptance.test.ts](modular-acceptance.test.ts) and native package
tests in `package_manager.rs`. Shared version cases live in
[package-versions.json](../../../tests/fixtures/package-versions.json).
The modular documents under `docs/Road/` are plans/audits, not an API reference.
