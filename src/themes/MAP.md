# Appearance and localization map

Read [themes-and-localization.md](../../docs/themes-and-localization.md) for the
portable theme format and localization contract.

| Concern                                   | Owner                                                                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application CSS and tokens                | [app.css](app.css); notice level colours `--notice-{danger,decision,warning,info,success}-{bg,fg,border}` (light and dark; portable themes may set them, see `THEME_TOKENS` in [index.ts](index.ts)) |
| Theme definitions / validation            | [index.ts](index.ts), public facade [../lib/themes.ts](../lib/themes.ts)                                                                                                                             |
| Color palettes                            | [palettes.ts](palettes.ts)                                                                                                                                                                           |
| Appearance preferences                    | [preferences.ts](preferences.ts)                                                                                                                                                                     |
| Emoji picker shadow-DOM styling           | [emoji-mart-base.css](emoji-mart-base.css)                                                                                                                                                           |
| ProseMirror / Tiptap base rules           | [prosemirror-base.css](prosemirror-base.css) (Tiptap's `injectCSS` is off)                                                                                                                           |
| Theme provider / settings                 | [theme-provider.tsx](../components/theme-provider.tsx), [settings-theme-library.tsx](../components/workspace/settings/settings-theme-library.tsx)                                                    |
| Visible strings, every supported language | [resources.ts](../locales/resources.ts)                                                                                                                                                              |
| i18next initialization only               | [i18n.ts](../lib/i18n.ts)                                                                                                                                                                            |
| Workspace icon encoding / rendering       | [icon-values.ts](../components/workspace/icon-values.ts), [icon-value.tsx](../components/workspace/icon-value.tsx), [EmojiPickerPanel.tsx](../components/workspace/tiptap/EmojiPickerPanel.tsx)      |

Settings content is centered at a maximum of 760px across sections and search;
scroll areas reserve a stable gutter and inset their thumbs from panel edges.

Static visual definitions belong here; components consume tokens and only local
behavior/layout styling. Compact density joins workspace surfaces inside a rounded frame with panel dividers;
`--amby-dock-width` keeps the activity rail, header and overlays aligned. Themes are validated data, never executable CSS/JS or
remote resources. Preserve the token allowlist, format version and no-overwrite
rules. Render encoded icons through `IconValue`, not as strings.

Add Russian source text and every supported translation under one stable dotted
key; keep resource shapes identical. Validate with
[localization-guard.test.ts](../lib/localization-guard.test.ts),
[theme-boundary.test.ts](../lib/theme-boundary.test.ts),
[themes.test.ts](../lib/themes.test.ts) and focused icon tests.
