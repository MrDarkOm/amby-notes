# Creative workshop: UX fix plan

Status as of 2026-11-24: **two waves implemented (A, B items 4 and 15, D, E, F, G, I, J).**
Native drag-and-drop checks for item 30 are pending. Source: a review of the workshop in the
installed 0.1.9-beta.9 on the owner's vault (marked 👁, seen on screen) plus a reading of the maps,
the format and the code (marked 📄, not checked on screen). Batches C and H need owner decisions
first (section 2).

| Batch | What                                                    | Items         | Status             |
| ----- | ------------------------------------------------------- | ------------- | ------------------ |
| A     | One entry to a story                                    | 1             | implemented        |
| B     | Levels of text pages: visible and changeable            | 4, 15, 16     | 4, 15 implemented  |
| C     | One word for universe / world; plot arcs vs text arcs   | 3, 8          | **owner decision** |
| D     | Why a row is shown or hidden; whole-workshop scope      | 5, 6, 7       | implemented        |
| E     | "Create" chooser and button labels                      | 9, 10         | implemented        |
| F     | Anchors: bind from the page, compact page plot          | 11, 12, 13    | implemented        |
| G     | Dossier and empty sections                              | 18–21         | implemented        |
| H     | Import an existing folder or bases into the workshop    | 2             | **owner decision** |
| I     | Plain-language texts, dangling story links, folder name | 22, 23, 24    | implemented        |
| J     | Desk, panel and small polish                            | 14, 17, 25–30 | implemented        |

## 1. Rules for whoever implements this

- Read [AGENTS.md](../../AGENTS.md), then the [creative map](../../src/components/workspace/creative/MAP.md)
  and its sub-maps (`workshop/`, `pages/`, `desk/`), and the
  [backend map](../../crates/amby-core/src/project/MAP.md). The contract is
  [creative-format.md](../creative-format.md). Before any change that writes files, read the parts of
  [vault-format.md](../vault-format.md) and [markdown-compatibility.md](../markdown-compatibility.md) that apply.
- **No item in this plan may change the on-disk format** unless section 2 says so and the owner
  approved it. Renaming visible words is a `src/locales/resources.ts` change; folder names of existing
  workshops are never renamed.
- Visible text goes through `resources.ts` in every language (skill `amby-ui-strings`). Notices follow
  [notices.md](../notices.md).
- Tests first for behaviour changes (red, then code). Keep `workspace.tsx` a facade.
- One batch = one branch from `dev`, one `updates/upd_next.md` entry, `npm run build` and
  `npm run docs:check`; `npm run verify` before review. Update the nearest map when ownership changes.
- After each batch, check it on screen in `npm run tauri dev` (not in `/Applications/Amby.app`).

## 2. Decisions the owner must make first

1. **Universe vs world (item 3).** Proposal: the word is "Вселенная" / "Universe" everywhere. The header
   count "Миров" becomes "Вселенных"; the panel group "Мир" (characters, locations, arcs) becomes
   "Справочник" / "Reference" (or another word the owner picks). Interface only.
2. **Arc as a text level (item 8).** The owner's own scheme is Books → Arcs → Chapters → Pages, but "Арки"
   in the workshop are plot threads. Proposal: rename the plot base's visible name to "Сюжетные линии" /
   "Storylines" (interface label and the `creative.sections.arcs` key for new workshops only; the role
   stays `arcs`, existing folders keep their names), then allow "Арка" as a level name in the Comic
   preset. Needs a yes on the word, and on whether existing workshops get a rename offer.
3. **Import (item 2).** Scope of a first version: which sources (a folder of notes, an Amby database, both),
   whether files move into the workshop or are linked where they are, and how to map existing
   properties. Write a short design (section H) and get approval before code.

## 3. Items

Each item: what is wrong, the fix, where to look, done when.

### A. One entry to a story

**1. 👁 A story opens two different things.** A card in the workshop's "Истории" section tab opens the
story's card note (an empty note, "Начните писать…"); the card on the "Обзор" tab opens the story desk.
Both show the same breadcrumb "Мастерская › Отдельные истории › MoleHills".

- Fix: every open of a story from the workshop UI (section gallery, panel, scope bar, universe page,
  search results) goes to the story desk (`creative:<projectId>`). The card note's body is shown on the
  desk as the story's description (a widget or the header, editable in place through the normal note
  editor or an inline field), so the note never needs to open on its own. "Open note" stays in the
  item's context menu for people who want the file.
- Where: `pages/section-gallery.tsx` (stories role), `workshop/item-actions.ts`, `workshop/search-results.tsx`,
  `project-desk.tsx`, `page-crumbs.ts`.
- Done when: no click on a story in the workshop opens the card note; the desk shows and edits the
  description; breadcrumbs of the desk and of the card note differ (the note's ends in "Описание" or
  the file name).

### B. Levels of text pages

**4. 👁 The level of a page is hidden.** "1 Глава" in MoleHills is on the level "Книга"; the desk shows
"Книга · Правка…" and "+ Книга", the name says chapter. The level is never shown at creation.

- Fix: the inline create row and the desk's add button name the level ("Новая глава"); the text tree
  row tooltip and the page header (`note-trail-header.tsx`) show the level; the page menu gets
  "Изменить уровень" (only to levels allowed by the parent rule; uses `move_text_page` or a value
  write of the level property, whichever the backend allows; add a backend command only if needed,
  through the `amby-ipc-change` skill).
- Where: `workshop/inline-create-row.tsx`, `desk/chapters-widget.tsx`, `workshop/item-menu.tsx`,
  `text-tree-model.ts`, `crates/amby-core/src/project/text.rs`.
- Done when: a person can see and change a page's level without opening the database.

**15. 📄 Level rules are silent.** A last-level page has no "+", a page starts one level below its parent,
a move to a deeper parent is refused without a word.

- Fix: show a disabled "+" with the tooltip "Глубже уровней нет"; while dragging, a refused target shows
  why (the text from `planMove`'s refusal reason).
- Where: `text-tree-model.ts` (`canHaveChildPage`, `planMove`), `workshop/works-tab.tsx`.

**16. 📄 A level cannot be removed.** `update_text_levels` only renames, reorders and adds.

- Fix: allow removing a level that no page uses; for a used level offer to move its pages to a neighbour
  level first. Backend change in `settings.rs` with journal and rollback like the other level changes;
  tests in the style of `create_test.rs`.
- Where: `crates/amby-core/src/project/settings.rs`, `project-settings-dialog.tsx`.

### C. Words (owner decision first, section 2)

**3. 👁 "Миры", "Вселенные" and "Мир" mean different things.** Header count "Миров 0", tab "Вселенные",
panel group "Мир" = characters and locations.

- Fix: as decided in section 2.1. Interface strings only.
- Where: `resources.ts` (`creative.*`), `pages/page-numbers.tsx`, `workshop/world-section.tsx`.

**8. 📄 "Arc" is taken by plot threads.** See section 2.2.

- Where: `project-labels.ts`, `text-schema-presets.ts`, `resources.ts`; backend labels only for new
  workshops (`presets.rs` fallbacks), never a rename of an existing folder without a journaled operation.

### D. Why a row is shown or hidden

**5. 📄 Belonging is invisible.** A row is in a story by its "Истории" relation or by a relation from that
story's text; the universe page shows only rows shared by two or more of its stories.

- Fix: a quiet line at the end of a filtered list: "Ещё N не в этой истории" opening the wider scope; on the
  universe page show every row of the universe's stories, with a "общий" mark on rows shared by two or
  more, instead of hiding single-story rows.
- Where: `workshop/workshop-model.ts` (`scopeEntities`, `buildMembership`), `scope-desk.tsx`,
  `scoped-section.tsx`, `pages/scope-model.ts`.

**6. 📄 No whole-workshop scope.** The universe switch offers a universe or "Отдельные истории" only.

- Fix: add "Вся мастерская" to `UniverseSwitch`; store it as its own value in `creative-scope-storage.ts`
  (keep reading old values).

**7. 📄 Implicit story choice.** `storyFilter: null` means "the first story of the scope".

- Fix: the bar always shows what is chosen; a first visit picks "Все истории" or the last-changed story
  explicitly and writes it.
- Where: `workshop/scope-bar.tsx`, `workshop-model.ts` (`resolvePanelFilter`).

### E. Creating

**9. 👁 The "Что создать?" chooser.** Everything is "Новая страница: …"; the universe appears twice
("Новая страница: Вселенные" and "Вселенная"); there is no anchor or note.

- Fix: three groups. "В истории": page of text (with its level), anchor, note. "В справочнике": character,
  location, arc/storyline, each author section. "Структура": story, universe, section. One universe entry.
- Where: `create-chooser-dialog.tsx`, `chooser-options.ts`.

**10. 👁 "+ Добавить: Персонажи".** Generated from `creative.addEntity: "Добавить: {{name}}"` with the
plural section name.

- Fix: a singular noun per role ("+ Персонаж", "+ Локация", "+ Якорь", "+ Арка"); author sections use
  "+ Добавить в «{{name}}»". All languages.
- Where: `resources.ts`, `pages/section-gallery.tsx`, desk widgets.

### F. Anchors and the page plot

**11. 👁 An anchor cannot be bound from the page it belongs to.** The page aside only reads.

- Fix: "+ Привязать якорь" in "Якоря этой страницы": a picker of the story's anchors ("Впереди" first)
  plus "Новый якорь". Uses `usePlotBinding` / `updateDatabaseRelationValue`, like the desk.
- Where: `dossier/text-page-aside.tsx`, `dossier/plot-blocks.tsx`, `workshop/use-plot-binding.ts`.

**12. 👁 The UI explains itself in a hint.** The desk says "Якоря без главы: перетащите якорь на страницу
или привяжите кнопкой рядом."

- Fix: after item 11, drop the hint; the bind button on each "Впереди" anchor gets a clear label/tooltip.

**13. 👁 The page plot takes half the page.** Four blocks, mostly "не привязано".

- Fix: when nothing is bound, one line "Сюжет: ничего не привязано · + Привязать"; the aside can be folded
  and the choice is remembered per vault; folded, the text gets the full width.

### G. Dossier and sections

**18. 👁 A character page has no header.** Only four empty headings.

- Fix: a dossier header with portrait (first image or initials), role and importance (from the section's
  preset properties when present) and story chips. Presentation only, nothing written.
- Where: `dossier/dossier-header.tsx`, `dossier/dossier-model.ts`, `presets.rs` (only if the preset lacks
  the properties; never add properties to existing bases without the author's action).

**19. 👁 Empty dossier sections give no hint.** Show a grey placeholder under an empty heading
("Возраст, черты, привычки…"), not written to the file.

**20. 👁 Path shown twice.** Remove "Мастерская · Персонажи" under the title; the breadcrumb has it.

**21. 👁 Empty or near-empty gallery.** One small card on a wide empty page. Show a large "+ Персонаж"
card and one line on what the section is for while it has fewer than three rows.

### H. Import (owner decision first, section 2.3)

**2. 👁 The owner's world lives outside the workshop.** The vault has `PaLooVerse/` with "Связи" and
"Сущности" bases and separate "Персонажи", "Локации" folders and a "Персонаж" template; the workshop's
"Вселенные" is empty.

- Fix: design first, as a new section of [creative-format.md](../creative-format.md): a journaled
  `import_into_workshop` that links or moves existing notes into a workshop base, maps properties, never
  changes frontmatter IDs, shows a preview of every file it touches and is restorable. Then the UI entry
  ("Перенести в мастерскую…" on a folder or a database).

### I. Plain language and leftovers

**22. 📄 Technical words.** "Создайте недостающие разделы" → "Обновить мастерскую" with a line on what
appears; "Связать с историями" → say what the author gains; "Открыть как базу" → "Открыть таблицей".

- Where: `complete-workshop-notice.tsx`, `workshop/link-action.tsx`, `resources.ts`.

**23. 📄 Links to a deleted story stay invisible.** Show "История удалена · Убрать ссылку" on rows and in
the dossier; removing writes only after the click.

**24. 📄 Renaming the workshop folder.** Check what happens when the workshop folder is renamed in the file
tree. If the workshop is lost (init screen), make the rename update `moduleSettings.creative.workshopPath`
in the same flow. Test first.

- Where: `workshop-location.ts`, `project-store.ts`, the tree's rename path.

### J. Desk, panel, polish

**14. 📄 Page format with no effect.** Hide the format choice (manuscript / screenplay / comic) until a
format has its own behaviour; keep the property and its values in files.

**17. 📄 One desk layout for every story.** Make the layout per story (`WorkshopPrefs.deskLayout` keyed by
story, the current value as the default for all) with "Применить ко всем историям".

- Where: `desk/desk-layout-model.ts`, `project-page.tsx`.

**25. 👁 Desk grid.** An empty strip under "Продолжить" (row height follows "Прогресс"); "Готово: 0 из 1"
→ "Готово 0 из 1 стр.".

- Where: `project-desk.tsx`, `desk/progress-widget.tsx`, `desk/continue-widget.tsx`.

**26. 👁 The panel jumps.** The "Continue" line in the scope card disappears when a page opens and the
panel shifts up. Keep the line (pointing at the open page's neighbour or hidden with reserved height).

- Where: `workshop/scope-bar.tsx`, `workshop/story-header.tsx`.

**27. 👁 Where are the files?** With the workshop hidden from the tree, add "Показать в Finder" /
"Показать в дереве" to the workshop page's "⋯" menu.

**28. 📄 Notebooks at a grey "0".** Say "Заметки скрыты фильтром истории" on hover.

**29. 📄 Anchor order is unexplained.** In "Впереди" and on the arc page, a tooltip: "Стоит по первой
привязанной странице".

**30. 📄 Native check.** Narrow panel (320 px), drag-and-drop in the text tree and anchors, keyboard moves:
check by eye in `npm run tauri dev` and record the result in
[native-ui-smoke.md](../native-ui-smoke.md).

## 4. Order

1. A, B (items 4, 15), E, F — no decisions needed, biggest effect.
2. D, G, I, J.
3. C and H after the owner's answers; item 16 (level removal) with B if time allows, it touches the
   backend journal.

Not in this plan: the screenplay editor and comic layout, and restoring a lost `amby-story.json` from
the card's `amby-story-id` (both in [creative-format.md](../creative-format.md)).
