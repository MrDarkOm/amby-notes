# Frontend map

Start here for startup, global providers and shared UI. For feature behavior,
choose [workspace](components/workspace/MAP.md) instead.

| Owner                                                               | Responsibility                                     |
| ------------------------------------------------------------------- | -------------------------------------------------- |
| [main.tsx](main.tsx)                                                | React entry, stylesheet and i18n initialization    |
| [App.tsx](App.tsx)                                                  | App startup, update gate and workspace mounting    |
| [startup-error-boundary.tsx](components/startup-error-boundary.tsx) | Startup failure UI                                 |
| [theme-provider.tsx](components/theme-provider.tsx)                 | Theme context                                      |
| [components/ui/](components/ui/)                                    | Reusable Radix-style controls, not workspace state |
| [workspace map](components/workspace/MAP.md)                        | Documents, navigation, panels, state               |
| [services map](lib/MAP.md)                                          | Storage, modules, AI, updater, diagnostics         |
| [appearance map](themes/MAP.md)                                     | CSS, themes, icons, localization                   |

Use function components, the `@/` alias, existing primitives and `cn()` from
[utils.ts](lib/utils.ts). Put behavior in the owning hook/store, not shared UI.
User-facing text comes from [resources.ts](locales/resources.ts); do not hard-code
it in TSX. Avoid eagerly importing large editors into startup.

Tests: colocated `*.test.ts(x)` and [component scenarios](../tests/MAP.md).
Startup updater behavior is covered by
[startup-update.test.tsx](../tests/component/startup-update.test.tsx).
Build/chunk configuration lives in [vite.config.ts](../vite.config.ts).
