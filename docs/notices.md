# Notices: rules

Status: the rules were accepted by the owner on 2026-11-07. Existing code was brought in line with them on
2026-11-07–09, and a guard test keeps it so; the last questions about reversible edits (rename and move that rewrite links,
merge) were replaced by an exact undo on 2026-11-22. The small exceptions left are listed in ["Transition"](#16-transition).

This document answers the question "how does the program tell a person about something other than the content itself":
an error, a warning, a conflict, a question, an event, the result of an action. Not notices: loading
indicators, empty states, hints for fields, and the failure placeholder (it has its own [section](#14-failure-placeholder)).

## 1. The essentials in five lines

1. Every notice has one **level** (section 2) and exactly one **place** where it lives and is resolved (section 3).
2. An **announcement** — at most one, and only for "Danger" and "Needs a decision" (section 4).
3. Everything in the background is collected in the **notification center** — the bell in the dock (section 5).
4. The response to an action is shown **where the person clicked**; confirmation of something irreversible is a **dialog inside the app**.
5. The text says what happened, what happened to the data, and what to do; **no raw error text** (section 10).

## 2. Four questions about a notice

### 2.1. Level

| Level                         | When                                                                                                                                                      | Expanded / announced |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `danger` — Danger             | The person's text is not saved or may be lost if nothing is done (a save failure)                                                                         | yes                  |
| `decision` — Needs a decision | Nothing is lost, but the program has stopped and is waiting for the person (a conflict, a mass deletion, a draft found, the file of an open note is gone) | yes                  |
| `warning` — Attention         | It works, but with a limitation; deciding is not required (source only, file over the limit, newer format)                                                | no                   |
| `info` — Information          | Something happened that is useful to know (edits merged, a note came back, properties converted to the new format)                                        | no                   |
| `success` — Success           | The outcome of an explicit long action by the person (backup, export, import of many files). Instant actions — without it                                 | no                   |

A doubt between levels is resolved in favor of the higher one only if, without the person's action, the data
will really suffer. Otherwise — the lower one: extra alarm teaches people not to read notices.

### 2.2. Source

- **Response to an action** — the person has just clicked, typed, or dragged. Shown in the same place.
- **Happened by itself** — sync, autosave, the file watcher, a check on open.
  Shown at the object (if it is on screen) or in the center.

### 2.3. Nature

- A **state** lives as long as there is a cause and goes away with it. It is not "closed", it is resolved.
- An **event** happened once: it is mentioned and not repeated.

### 2.4. Scope

Element (field, cell, button) → note → section (sync, database, workshop, AI) → application.

## 3. Places

| Place                                | What goes there                                                                                           | What is never there                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Under the element**                | The response to an action in this place, of any level                                                     | Background events                        |
| **Note card** (strip)                | Everything about a specific open note: states and events                                                  | Anything not about this note             |
| **Notification center** (bell)       | Closed notes, the vault, sections, the application; copies of danger and decisions of open notes; the log | Input errors under fields, confirmations |
| **Confirmation dialog** (in the app) | An irreversible or dangerous action requested by the person; a choice without which one cannot continue   | A simple error message                   |

A toast is not a place, only an announcement (section 6). The debug log (`logger`) is not a notice (section 13).

Choosing the place, in order, the first that fits:

1. The person requests an irreversible action → **confirmation dialog**.
2. A response to an action, and the person is still where they acted → **under the element**. If the action is long and
   finished after the person left, → the result goes to the **center log** (success) or to **"Требует решения"** (Needs a decision) (failure).
3. It concerns an open note → **note card**; for `danger` and `decision` also a copy in the center.
4. Everything else → **notification center**.
5. The person has nothing to do, and the data is not affected → not a notice, only `logger` with a code.

## 4. One place and one announcement

- **One place.** A notice lives in one place. The copy in the center for an open note is the same
  notice with the same `id`: a decision in either place removes both.
- **At most one announcement.** For an open note the announcement is the expanded stack of cards itself. For
  everything else — a toast. Never both at once.
- **Only `danger` and `decision` are announced.** `warning`, `info`, and `success` appear in their place silently.
- **At startup** and when the vault changes, what already existed is visible in its place but not announced:
  the first status is a reference point, not news.
- **One cause — one notice.** A repeat does not create a second one but updates the number ("3 conflicts").

## 5. Notification center

- **The button** — the bell in the dock, above settings: an ordinary dock button of the same kind as the others, always present. It opens a **stack of cards right at the bell**, not a side panel: the stack floats beside the dock, on the side where the dock is, grows upward from the window’s bottom inset, its height is limited by the window, with scrolling inside. It sits on one backing, like popup menus (background `--popover`, thin border, shadow, rounding), scrolling inside; it aligns with the dock’s inner edge and sits 8 pixels above the bottom of the window, keeping the dock buttons visible and clickable. It closes by clicking the bell again, by clicking elsewhere, and by `Esc`; focus returns to the button; while the bell is open it is highlighted.
- **Sections:**
  - "Требует решения" (Needs a decision) — `danger` and `decision`;
  - "Внимание" (Attention) — `warning`;
  - "Ранее" (Earlier) — the log: `info` and `success` events, newest on top, in compact rows with a time and a link to the object; the last three are visible, "Показать все" (Show all) expands the rest in the same stack; "Очистить" (Clear) is there too.
  - Order from top to bottom: "Требует решения" (by severity), "Внимание", "Ранее". Section headings are small and quiet; an empty section is not shown.
- **The counter** on the bell — the number of entries in "Требует решения" and "Внимание". The color is by the most
  severe level among them. The log does not change the counter: otherwise in a week it says "37", and people
  stop opening the bell.
- **"Требует решения" and "Внимание" are not stored.** They are derived each time from live causes (the sync
  status, the documents store, and so on) and disappear with the cause. An entry in "Внимание" can be
  hidden; a hidden one returns only if the cause went away and came back. Hiding is remembered until
  restart.
- **The log is stored** in the application data, separately for each vault, and not in the vault's `.amby/`:
  it is not synced and must not fall under other rules about service data. Entries live 7 days
  or until cleared manually.
- **Management screens remain.** The list of conflicts and of files that are not synced, in the sync
  settings, is a screen for working with them, not a notice. The center leads there with a button.
- There is no longer a separate conflicts badge in the corner of the window: it was replaced by the bell button in the dock (step 1), whose counter is the center's counter (step 2).
- **What is in "Требует решения":** all sync conflicts (the "Сравнить" (Compare) button), sync stops (the "Открыть настройки синхронизации" (Open sync settings) button, the decision is there), copies of `danger` and `decision` of open notes with the same `id` as the card (the "Открыть заметку" (Open note) button), an autosave failure of a closed note (the "Открыть" (Open) button). **In "Внимание":** plan limits and files with errors (the "Показать" (Show) and "Скрыть" (Hide) buttons).
- **The log** can "Очистить" (Clear). An entry about a change sync made by itself (merged edits, a version chosen in a comparison) has a "Вернуть" (Restore) button when the snapshot sync took before the change is in the history: it puts that version back the way the history panel does (unsaved text is saved first; a note with unsaved edits is not touched) and the entry then says "Возвращено" (Restored) ([restore-from-journal.ts](../src/components/workspace/notices/restore-from-journal.ts)).
- **A conflict is the same kind of `decision`-level card** as the others, with one main button "Сравнить"; there is no separate conflict list with its own look in the center (the list remains in the sync settings).

## 6. Toast

- Only an announcement of `danger` or `decision`, when the object is not on screen. Currently announced: a new conflict of a closed note (one toast per cause, several in one pass — "Новых конфликтов: N" (New conflicts: N)), a new sync stop, an autosave failure of a closed note. A toast goes away together with its cause.
- The toast stands **in the same place, at the bell** (on the same side, with the same offset from the dock and from the same point as the stack), and it is the same calm card as in the stack. While the stack is open there are no toasts: the notice's place is already in view; toasts hanging when the stack opens are tucked into it.
- It disappears after 10 seconds; on hover the time stops. Each toast has its own timer.
- No more than three are visible, the rest collapse into "ещё N" (N more).
- A click on a toast opens the stack (as does "ещё N"). If the notice has its own action (open the note), the toast has a short "Открыть" (Open) button. Deciding in a toast is not possible: it
  disappears, and the decision must remain available.

## 7. Note card

The structure is described in the [note notices map](../src/components/workspace/note-notices/MAP.md).
The rules on top of it:

- **A pill instead of a lightbulb.** Note notices are a small standalone element next to the bottom bar
  of the note ("Только что · 19 сл." (Just now · 19 words), undo, redo, lock): at its right edge, with a gap of about 8 pixels above the
  bar, not under it and not flush with its width. No cards — no pill.
- **Collapsed** — a pill as wide as its content (with a limit, a long title is truncated): the icon of the most
  severe level, the title of its card on one line, "+N" for the others, and a "expand" chevron. One button
  (`aria-expanded`). **Expanded** — a panel rounded on all sides on the popup menu surface (background,
  border, soft shadow, like the stack at the bell), about 24rem wide, but no wider than the note area: a
  title row (level icon, "Уведомления заметки · N" (Note notices · N), "collapse" chevron) and under it the cards as separate
  tiles; with many cards — scrolling inside, height limited. The panel does not cover the buttons of the bottom bar.
- `danger` and `decision` cards expand the strip by themselves when they appear or when the note is opened.
  `warning`, `info`, and `success` wait for a click on the strip.
- The icon color is by the most severe level of the cards (`danger`, `decision`, `warning`, `info`, `success` in
  descending order).
- A card goes away when its source goes away. An information item can be dismissed with a button.
- The action button shows what is going on ("Восстанавливаю…" (Restoring…)); an action error is in the same card.

## 8. Under the element

- A line under a field, cell, or button, in the same panel or popover where the action took place.
- The line is drawn by `NoticeLine` ([notice-line.tsx](../src/components/workspace/notices/notice-line.tsx)): the icon and color of the level (`warning`), not the red `text-destructive`; this is how it is in the property editors of databases and notes and in cells (the cell mark is `noticeTextClass`). The guard keeps the list of these files.
- It disappears on the next attempt or when the input changes.
- It does not go to the center: the person is looking at that place anyway.
- Example: a name that was not accepted on rename (taken, invalid characters). The field stays open with the entered
  name, under it a `warning`-level line from the dictionary by error code; it goes away when the name is edited and on Esc, and leaving the field
  with the same name counts as giving up, rather than asking again. The component is `RenameHint`, the rename result is `RenameOutcome`. It is done the same way under the title of an open note and under the title of a database. A refusal of the database window (new view, new record, new property) is shown only in the window itself under the field, not once more above the table; "Отмена" (Cancel) removes it.

## 9. Confirmation dialog

- Only when the person requests an irreversible or dangerous action (delete permanently, roll back, upload the
  vault again), or when one cannot continue without a choice (version comparison on an external edit).
- The dialog is drawn by the application itself: in its own style, with translation, covered by tests. The OS system dialogs
  (`confirmAction`, `showErrorMessage`, `window.confirm`, `window.alert`) are not used. The exceptions are the
  system file or folder picker and keychain requests. It is asked like this: `confirm({ title, description,
confirmLabel, destructive })` from [confirm.ts](../src/lib/confirm.ts) returns `Promise<boolean>`;
  the dialog is drawn by [ConfirmDialogHost](../src/components/confirm-dialog-host.tsx), which stands in `App` once, so it
  works in the main window, in the separate settings window, and before a vault is opened. The questions are collected in one place,
  [confirmations.ts](../src/lib/confirmations.ts); the texts are in `confirmations.*` of the dictionary.
- A dialog over another dialog works. Questions go one at a time, in the order asked. `Esc` and a click outside are
  "Cancel" (`confirm()`); `confirmChoice()` distinguishes "closed without an answer" from "no", for a question where "no" does something. If the action is dangerous (`destructive`), the button is highlighted and focus is on "Cancel"; otherwise focus is on the
  action button. Focus is held inside the dialog and on closing returns to where it was. The word "Cancel"
  is changed only if it would lie: when restoring a canvas and sketch draft, "no" erases the draft, so there
  the button is "Не восстанавливать" (Do not restore), and only it erases it. `Esc` and a click outside close the question without a decision:
  the draft remains, the layer shows the file from disk read-only (nothing will overwrite the draft), and the question
  returns the next time the layer is shown ([held-drafts-store.ts](../src/components/workspace/held-drafts-store.ts)).
- The title is a question about the action ("Удалить «План»?" (Delete “План”?)), the line says what will happen to the data ("Заметка попадёт в
  корзину хранилища, её можно вернуть" (The note will go to the vault trash, it can be restored)). The action button is a verb ("Удалить" (Delete)), a dangerous action
  is highlighted as dangerous; the second is "Отмена" (Cancel).
- A reversible action is not asked about but is made undoable or restorable. This is how it is done for: **restoring a version** (the current
  text always becomes a history version first, even when history is off, and the finished line says that the
  previous state is in history); **removing a theme** from the library (a line under the library "Тема убрана" (Theme removed) with a
  "Вернуть" (Restore) button); **deleting a notebook** (the notes move up a level, an empty folder goes to the trash, not permanently); since
  2026-11-22, **a rename or a move that rewrites links** and **a merge of two notes** (below). The question remains only where
  the edit is not reversible.
- **Exception by the owner's decision (2026-11-24): deleting a page of a note** asks although Undo brings the
  page back, and its question has a third answer: "Удалить всё" (dangerous), "Перенести" (only the page goes,
  its text stays on the neighbouring page) and "Отмена". The middle answer is `alternativeLabel` of
  `confirmChoice()`, which then returns `alternative`.
- **Exact undo of a rename, a move and a merge** ([commands/undo.rs](../src-tauri/src/commands/undo.rs),
  [amby-core undo.rs](../crates/amby-core/src/undo.rs)). Before a link rewrite every rewritten note becomes a kept
  `link-refactor` version (a page's title that followed the name and a database folder's description: `rename`; the target of a
  merge: `merge`), even with history off. The result carries `FsMutationResult.undo`: for each rewritten note its path, the
  version id and the SHA-256 of what was written. «Вернуть» (`undo_mutation`) never rewrites links back — a note that already
  linked to the new name would be changed too. Under the mutation gate it checks that the item is where the operation left it and
  its old place is free (else `undoItemMoved`), that every rewritten note still has the written digest (else `undoNoteChanged`),
  and that the versions exist (else `undoUnavailable`); then it writes each note's previous bytes back (BOM and line endings
  included) and moves or renames the item back without touching links; a failure puts back what it wrote. A merge keeps the
  target's text first (`begin_merge`), the merged note goes to the archive, not to the system trash (`finish_merge`), and the undo
  restores the target and brings the note back to its exact place. In the interface: a line under the tree ("Переименовано в
  «…»", "Ссылки обновлены в N заметках", "Текст «…» добавлен в «…»") and a journal entry, both with «Вернуть»
  ([undo-operation.ts](../src/components/workspace/file-actions/undo-operation.ts)). A move of several items is one entry and one «Вернуть»: every
  move carries its record, the moves are undone from the last to the first, each exactly or not at all; if one is refused,
  the line says how many came back ("Вернулось 1 из 2…") and the entry keeps the rest. Unsaved open notes are saved first, a refusal
  is said in the same place with its code's text, and nothing is touched.
- A question about deletion names the thing by its kind ("Удалить заметку «План»?" (Delete the note “План”?), "Удалить папку…" (Delete the folder…), sketch, canvas, database), not "file"; the line under the title is one and short ("Попадёт в корзину хранилища, оттуда можно вернуть" (It will go to the vault trash, it can be restored from there)).
- What Amby itself deleted does not come back to life: after a sketch or canvas is deleted, the record sent by the closing editor is discarded (without the question "overwrite?") until the same path is opened again.

## 10. Text

- **Three parts:** what happened; what happened to the data; what to do. If the data is intact, say so
  directly: «Текст в черновике, ничего не потеряно» (The text is in the draft, nothing is lost).
- **No raw error text** from Rust, the server, or a library. The error carries a machine code, and the
  code is turned into text through `src/locales/resources.ts` (the model is
  [sync-errors.ts](../src/lib/sync/sync-errors.ts); databases and the workshop use [operation-errors.ts](../src/lib/operation-errors.ts)). For an unknown code, show a generic text and the code itself in small type,
  so the person can contact support with it.
- **An action is mandatory** for `danger` and `decision`. For `warning`, either an action or the phrase "nothing
  needs to be done".
- **Buttons use a verb:** «Сохранить снова» (Save again), «Сравнить» (Compare), «Открыть» (Open). Not "OK".
- **Name the object:** which note, which file, which vault.
- **No blame and no jargon:** "note header", not "frontmatter"; "another computer", not "node".
- **Short.** A notice has a title, at most one line of explanation, and at most two buttons, one of which is
  primary. If there are more options, the notice leads to where the decision is made (a comparison, a window) instead of
  listing them.
- **A button needs no legend.** If it is unclear what a button does without an explanatory paragraph, the button is renamed.
- **Notes and versions, not files and copies.** Name without extension, without paths and service words ("main file",
  "copy", "identifier").
- **Consequences come after the action, not before it.** Do not describe in advance what will happen; do it and show
  a journal entry with a «Вернуть» (Restore) button. A reversible action does not need explaining; it can be undone.
- **Choose when both sides are visible.** Choosing between versions is offered where the person sees both of them.
- All strings go in `resources.ts` in all languages, under a stable key.

## 11. Appearance

- Level colors are tokens in `src/themes/` (`--notice-danger`, `--notice-decision`, `--notice-warning`,
  `--notice-info`, `--notice-success` with background, text, and border variants). Classes like `text-amber-500`
  are not used in notice components.
- The icon is tied to the level (Lucide): `danger` — `OctagonAlert`, `decision` — `TriangleAlert`,
  `warning` — `CircleAlert`, `info` — `Info`, `success` — `CircleCheck`. Good news never
  comes with a triangle.
- One shared component draws the level (color, icon, role) for the card, the centre entry, the toast, and the line
  under an element.
- **A calm look** for stack cards, toasts, and journal rows: a plain surface, a thin neutral border, a colored strip on the left, and a colored level icon. No color fill and no colored borders (note cards still keep a colored border for now). One primary button per card.
- **A note name next to a verb** with gender or number goes with the word "note": «Заметка «Дневник» не сохранилась» (The note "Дневник" was not saved), not ««Дневник» не сохранилась»; a test enforces this.
- For screen readers: `danger` — `role="alert"`, everything else — `role="status"`.
- Only the confirmation window takes focus. Animations respect `prefers-reduced-motion`.

## 12. Decisions the program made on its own

If the program itself changed the person's text or data — merged the edits of two computers, kept the
later edit of a property, restored a deleted note, converted a format — it must not stay silent:

- a snapshot is taken in history before the change (rule Р8 of the [sync plan](sync-plan.md));
- an `info` appears: a card if the note is open (the stack is not expanded), and an entry in the centre journal.

## 13. Silence and the debug log

- An error may go unshown only if there is nothing for the person to do about it and the data is not affected
  (cleanup, cache, optional reads). In that case, leave a comment in the code explaining why we stay silent, and a `logger` with the error
  code.
- `.catch(() => {})` without a comment is not allowed. The same goes for `catch {}`, `.catch(() => undefined)`, and `.catch(() => null)`: the comment goes on the same line, on the line above `.catch`, or on the line above the statement. If it is not an obvious cleanup (closing a handle, a window gesture), there is also a `logger` with an event code recorded in `allowed-events.txt`. This is enforced by [notice-rules-guard.test.ts](../src/lib/notice-rules-guard.test.ts).
- If the person's data is affected, staying silent is never allowed.
- A log event code must be in the single list [allowed-events.txt](../src/lib/debug/allowed-events.txt), which is read by both the interface (`event-codes.ts`) and Rust (`allowed_event` in `logging.rs`): an unknown code is saved as `diagnostic.invalid_event`, and the real name is lost. This is enforced by [event-registry.test.ts](../src/lib/debug/event-registry.test.ts): a new `logger.*("name")` or `event = "name"` without a line in that file fails the test.

## 14. Failure placeholder

Not a place for notices but a safety net: when a tab or panel crashes while rendering,
[surface-error-boundary.tsx](../src/components/workspace/surface-error-boundary.tsx) shows in its place
«Что-то пошло не так» (Something went wrong) and «Повторить» (Retry), and the rest of the window keeps working; at startup
[startup-error-boundary.tsx](../src/components/startup-error-boundary.tsx) does the same. There is one rule: the text says
that the data is intact and what to do, does not show the raw error, and the error itself goes to `logger`.

## 15. Verification

Every new notice is verified by a test:

- it appears in its place with the right level;
- it is announced once (or not announced, if the level is below `decision`);
- a repeat of the same cause does not create a second one;
- it goes away together with its cause;
- the text comes from `resources.ts`, not from the error (this is enforced by [notice-rules-guard.test.ts](../src/lib/notice-rules-guard.test.ts): a new exception is added to its list with a reason).
- the color rules (red `role="alert"` and palette classes like `text-amber-500`) are checked across all of `src`, not against a list of files; earlier violations are recorded in the baseline lists `RED_ALERT_BASELINE` and `PALETTE_BASELINE` of the same test. A list can only shrink: a new violation and a fixed one that was not struck from the list both fail the test.
- a failed action does not stay only in `console.error`: `console.error` calls are checked across all of `src`, and the remaining ones are recorded in `CONSOLE_ERROR_BASELINE` (which also only shrinks). A failure is a `logger` with a code and, if the person was waiting for a result, a line under the tree or a `warning` in the centre.

## 16. Transition

Deviations found during the 2026-11-07 inventory, and the order of converting them. The numbers are from a search of the code,
approximate.

| №   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Done 2026-11-07.** Level tokens `--notice-{level}-{bg,fg,border}` in [app.css](../src/themes/app.css) (light and dark theme, allowed for portable themes) and the shared level component [notice-level.tsx](../src/components/workspace/notices/notice-level.tsx): icon, role, and colors by level. Note cards ([notice-card.tsx](../src/components/workspace/note-notices/notice-card.tsx)) and the toasts and limits in [sync-notices-host.tsx](../src/components/workspace/sync/sync-notices-host.tsx) were moved onto it. What expands the stack on its own is now derived from the level (only `danger` and `decision`), and the icon and the dot of the note's strip follow the most serious level among the cards (§7). The lamp was replaced by a strip, and the conflict badge by a bell button in the dock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2   | **Done 2026-11-07, except "Restore" and successes, which do not exist yet.** The centre is a stack of calm cards by the bell ([notices-stack.tsx](../src/components/workspace/notices/notices-stack.tsx)); the conflicts popover, the badge, and the side panel are gone. "Needs a decision" and "Attention" are derived from live causes ([centre-entries.ts](../src/components/workspace/notices/centre-entries.ts)); the journal is per vault, in the app data (`notice-journal/<hash>.json`), 7 days, with "Clear" ([lib/notices/](../src/lib/notices/notice-journal.ts)). Toasts were moved into a shared store and host ([notice-toasts-host.tsx](../src/components/workspace/notices/notice-toasts-host.tsx)), sit by the bell, and open the stack: they announce only a new conflict on a closed note, a new sync stop, and an autosave failure on a closed note (instead of a system window); limits and "note came back" are no longer shown as toasts; for an open note a conflict gives no toast. Not done: the "export" and "import of many files" successes (their endpoints do not exist in the code yet); of the backups, only the copy before the first sync pass gets into the journal.                                                                                                                                                                                                                                                                                                                                             |
| 3   | **Done 2026-11-08, except dropping unnecessary questions.** The confirmation window is `confirm()` and `ConfirmDialogHost` in `App` (section 9); 22 questions are gathered in [confirmations.ts](../src/lib/confirmations.ts); `window.confirm` from the database is gone too. The methods `confirmAction` and `showErrorMessage` were removed from the storage port, and the `dialog:allow-message` permission was removed from the windows; file picking remains. Former error messages moved to their proper places: under the tree (move, bulk delete, file drag-and-drop — [tree-message.tsx](../src/components/workspace/tree/tree-message.tsx)), in the crop window and in the AI connection card (a line under the element), in the centre as `warning` or `decision` ([use-app-notices-store.ts](../src/components/workspace/notices/use-app-notices-store.ts)): the vault failed to open — `decision` with a toast; recovery data, a link that failed to open, an image that failed to save, an old key that remained — `warning`. There is no longer any raw error text in these places; error codes for databases and the workshop are step 4. Unnecessary questions were removed on 2026-11-09 (section 9): restoring a version, removing a theme (with a «Вернуть» (Restore) button), deleting a notebook; on 2026-11-22 rename and move with links, and merge, which became exactly undoable (section 9). Canvas and sketch draft: only the «Не восстанавливать» (Don't restore) button erases it; `Esc` and a click outside leave it. |
| 4   | **Done 2026-11-08 for databases and the creative workshop.** The Rust error carries a code: for databases, `reason` (the `FailureReason` enum, `crates/amby-core/src/database/failure.rs`: `revision_conflict`, `locked`, `name_taken`, `formula_invalid`, and others) alongside the command code; for the workshop, the `ProjectError` kind and the code `failed`. The text comes from a dictionary: [database-errors.ts](../src/lib/database-errors.ts), [project-errors.ts](../src/lib/project-errors.ts), and the shared entry point [operation-errors.ts](../src/lib/operation-errors.ts) (`operationErrorText`); for an unknown code, a generic text with the code. Warnings that arrive with a successful write are reduced to one text (`warningNotices`), and the hint on a formula and on a summary also comes from the dictionary. Parsing of error text (`/revision conflict/`, "No such property", "existing values are cleared") was replaced by codes. The text itself went to the debug log with `failureCode`. The guard test keeps these catalogs free of `error.message` (since step 6, all of `src`). Not done: the shared `Result<T, String>` commands (note properties, files) — they need their own codes; the other places with raw text were converted in step 6.                                                                                                                                                                                                                                                            |
| 5   | **Done 2026-11-07.** The `sync-merged` event is listened to by the sync port (`onMerged`); it writes to the journal "“Name”: edits from two computers were merged", and for an open note shows a quiet `info` card "Edits from two computers were merged — the previous version is in history" ([note-notices.tsx](../src/components/workspace/note-notices/note-notices.tsx)). "The later property edit won" stays silent by the owner's decision of 2026-11-22, which confirms З70 of the sync plan: it is only the look of a property (icon, colour, type), and values merge as text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 6   | **Done 2026-11-08.** One guard for all of `src` — [notice-rules-guard.test.ts](../src/lib/notice-rules-guard.test.ts) (it absorbed `no-system-dialogs` and `error-text-guard`): no system windows (`window.confirm`/`alert`, `confirmAction`, `showErrorMessage`, `dialog:allow-message` permissions); no reading of `.message` and `String(error)` outside the log and a short list of exceptions with reasons (boundary adapters, own dictionaries, codes in the text); no parsing of error phrases and raw `warnings` in components; no `.catch(() => {})`, `catch {}`, and the like without a "why we are silent" comment; no palette classes (`amber-*`, `red-*`, etc.) in places where notices are drawn; no second toast host. The guard explains each rule with a message linking to the section. The remaining places with raw text were converted to dictionaries: the installer and module settings — [install-errors.ts](../src/lib/modules/package-manager/install-errors.ts), database remarks — `databaseDiagnosticText`, everything else — `operationErrorText`; raw text remains only in the log. Not done: English Mermaid parse remarks on the board (a guard exception); the `Result<T, String>` commands without codes from step 4 were not converted.                                                                                                                                                                                                                                                                           |
| 7   | **Done 2026-11-07.** An automatic update failure ([app-updater.ts](../src/lib/app-updater.ts)) is written to the centre journal as `info` (the entry "Не удалось проверить обновления, попробуем позже" (Could not check for updates, will try later); if an update is found but did not install — "Не удалось установить обновление 0.1.9-beta.6" (Could not install update 0.1.9-beta.6) with a link "Скачать версию вручную" (Download the version manually) to its release on GitHub; a repeat is the same entry with a count). Until a vault is opened, the entry waits in memory and goes into the journal of the first vault opened.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 8   | **Done 2026-11-07, except the journal.** The sync conflict was reworked per section 10 (the journal is step 2). The row in the list and the card in the note: "“Name” was changed on two computers" (for two new files, "created"), "Both versions are intact", one «Сравнить» (Compare) button; no paths, extensions, or legend ([sync-vault-parts.tsx](../src/components/workspace/sync/sync-vault-parts.tsx), [note-notices.tsx](../src/components/workspace/note-notices/note-notices.tsx)). The comparison window: the sides are "Version in the note" and "Second version", not "this" and "other computer" — the engine does not record whose version lies in the second slot (on a repeated pass and on a tie of two new files it is the server's version), so the window does not claim it; one time, "Conflict found …"; two primary buttons "Keep the version in the note" and "Take the second version", and "Save both as separate notes" in the "…" menu ([sync-compare-dialog.tsx](../src/components/workspace/sync/sync-compare-dialog.tsx)). After a choice, the result is written to the centre journal (step 2), and for an open note an `info` card also remains with "Open history" if a version went into history ([conflict-outcome.ts](../src/components/workspace/sync/conflict-outcome.ts)); the row in the list is gone. The journal entry has a "Вернуть" (Restore) button since 2026-11-22.                                                                                                                              |
| 9   | **Done 2026-11-09.** Moving a note into a database: if reading the properties, the note's place in the database, or writing the move failed, a `warning` "Properties of “…” were not moved to the database" appears under the tree with a «Перенести» (Move) button (it reads again and asks again), and the note itself gets a `warning` card with the same button while the session lasts ([property-move-retry-store.ts](../src/components/workspace/file-actions/property-move-retry-store.ts)); the properties stay in the note until the person answers. The "Databases" module is off — we stay silent, the note is not in a database as far as the person is concerned. Silent failures became `warning` in the centre: the property format check on vault open and the check of edits from an old version ([property-notices.tsx](../src/components/workspace/note-notices/property-notices.tsx)); the subscription to sync state (`sync.listen_failed`, [listen-failure.ts](../src/components/workspace/sync/listen-failure.ts)) — the centre says the state stopped updating, the panel shows "Состояние неизвестно" (State unknown) instead of a stale "synced" and re-subscribes up to three more times with a 10 s pause. Red lines in property editors and database cells were moved to `NoticeLine` and the level tokens, and the guard was extended.                                                                                                                                                                                 |

Until a step is done, existing behavior is not broken for the sake of the rules: it is converted as a whole, together with the tests.
