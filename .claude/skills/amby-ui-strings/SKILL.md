---
name: amby-ui-strings
description: Use in Amby Notes when adding or changing any text a person sees — labels, buttons, menus, tooltips, aria-labels, placeholders, notices, errors, confirmations, empty states.
---

# Adding or changing visible text in Amby

The rules live in [agent-guidelines.md](../../../docs/ai/agent-guidelines.md) ("Localization and
Themes") and in [notice rules](../../../docs/notices.md) §10 "Текст". If anything here
disagrees with those files, they win.

## Where the strings are

`src/locales/resources.ts` is about 450 KB. **Do not read it whole.** Find the section first:

```bash
rg -n '^const ru = \{|^const en: typeof ru = \{' src/locales/resources.ts
rg -n 'myKey|neighbourKey' src/locales/resources.ts
```

- `const ru = {` comes first. Russian is the source and the fallback.
- `const en: typeof ru = {` comes later. Because of `typeof ru`, a key missing from `en` (or
  present only in `en`) is a **type error**. Add the key to both objects at the same dotted path,
  then read only the few lines around each insertion point.
- Interpolation is `{{name}}`. Plurals: Russian needs `_one`, `_few`, `_many` plus the bare key.
  English has the same four keys, since the shape must match (see `serverDeletedAgo`).

## In components

- `const { t } = useTranslation()` and `t("area.section.key")`. No literal words in TSX.
  `src/lib/localization-guard.test.ts` fails on them.
- An error shown to a person comes from a machine code mapped to a key (pattern:
  `src/lib/sync/sync-errors.ts`, `src/lib/operation-errors.ts`). Never show raw Rust, server or
  library error text.

## How the text should read (from notices §10, short form)

- What happened, what happened to the data, what to do. Say plainly when data is safe.
- Buttons are verbs ("Сохранить снова", "Открыть"), never "ОК". At most two buttons, one main.
- Name the object: which note, which vault. Note names without extensions or paths.
- No jargon: "шапка заметки", not "frontmatter"; "другой компьютер", not "узел".

## Check

```bash
npx vitest run src/lib/localization-guard.test.ts
npm run typecheck
```
