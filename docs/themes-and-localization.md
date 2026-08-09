# Themes and localization

## Localization

All interface strings live in `src/locales/resources.ts` and use stable dotted
keys. `src/lib/i18n.ts` only initializes i18next and contains no translations.
`SUPPORTED_LANGUAGES` is the one registry that drives the settings selector and
preference validation. Russian is the fallback language, and English is kept
structurally identical to the Russian resource through TypeScript's `typeof ru`
check. The chosen language is a global preference, applies immediately, and is
persisted in `settings.json`.

When adding a feature, add its Russian source string and its translation in the
same change. Do not use visible text as an identifier and do not hard-code a
new user-facing string in a component. This keeps missing translations obvious
at compile time and makes future language packs a data-only addition.

`src/lib/localization-guard.test.ts` scans every TSX component and fails when a
literal user-facing word appears in JSX or in `title`, `placeholder`, `alt`, or
`aria-label`. Technical glyphs such as `H` and `⌘L` are intentionally exempt.

## Portable themes

All editable visual definitions live under `src/themes/`: application CSS,
built-in theme tokens, color palettes, previews, and appearance preference
values. Components may consume these values but do not own static colors.
`src/lib/theme-boundary.test.ts` enforces this for component source files.

Themes live in the global settings library and can be exported as
`.amby-theme.json`. The app never executes a theme as CSS or JavaScript: it
accepts only approved visual tokens, which prevents a downloaded theme from
changing layout, injecting styles, or loading remote resources.

```json
{
  "format": "amby-theme",
  "version": 1,
  "id": "forest-night",
  "name": "Forest Night",
  "author": "Example author",
  "description": "A muted dark green theme.",
  "mode": "dark",
  "tokens": {
    "--background": "150 20% 8%",
    "--note-surface": "#102018",
    "--editor-fg": "#e8f5e9",
    "--link-color": "#86efac"
  }
}
```

`id` is a lowercase kebab-case identifier. `mode` is `light` or `dark`; the
system mode remains an application choice, not an importable package. Theme
imports never overwrite a built-in or existing theme: a numeric suffix is added
when necessary. Removing an imported theme only removes it from Amby's library;
the source JSON file is never changed.

The preferences screen includes bundled themes, import/export, and a GitHub
code-search entry point for community `.amby-theme.json` files. Install themes
only from sources you trust, even though Amby validates their format.
