# Workshop panel map

The body of the "Workshop" panel: one column with the story header, the text tree, anchors, notes
and the world. The owner of the whole creative interface is the [creative map](../MAP.md); the
backend of notebooks is [notebooks.rs](../../../../../src-tauri/src/project/notebooks.rs) and the contract is
[format §8](../../../../../docs/creative-format.md).

| Concern                                      | Owner                                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Composition, filter, drafts, data loading    | [workshop-pane.tsx](workshop-pane.tsx), [use-database-rows.ts](use-database-rows.ts)                                   |
| Story parts (text tree, anchors, notes slot) | [works-tab.tsx](works-tab.tsx), [text-tree-model.ts](text-tree-model.ts)                                               |
| Belonging, groups, scopes (pure)             | [workshop-model.ts](workshop-model.ts)                                                                                 |
| The world's lists                            | [world-section.tsx](world-section.tsx), [world-cards.tsx](world-cards.tsx)                                             |
| Notebooks: grouping, names, delete plan      | [notebook-model.ts](notebook-model.ts) (pure)                                                                          |
| Notebooks: listing from the disk             | [use-notebooks.ts](use-notebooks.ts)                                                                                   |
| Notebooks: create, rename, move, delete      | [use-notebook-actions.ts](use-notebook-actions.ts)                                                                     |
| Notebooks and notes on screen                | [notes-part.tsx](notes-part.tsx), [item-menu.tsx](item-menu.tsx) ("Move to notebook")                                  |
| Real backend data for the model tests        | `real-workshop.fixture.json`, kept equal to the Rust output by `contract_test.rs`; read by `workshop-contract.test.ts` |

**Notes and notebooks.** The notes part is the notes base shown as notebooks, under the same story / universe /
whole-workshop filter as the world: `scopeEntities` over the base's rows, so only the notes of the shown stories; the
whole workshop ends with the group "No story", a tree of its own holding the notebooks that have such notes. It stands
under a story's parts and, for a universe or the whole workshop, alone under "Story" (`NotesSlot` of `works-tab.tsx`).
A base made before the links has no "Stories" relation, so it offers "Link to stories".

A notebook is a folder (format §8). `useNotebooks` lists the folders from the disk (`list_notebooks`) because an empty
notebook has no note to show it. `buildNotebookTree` groups the filtered rows by `categoryPath`: every notebook is
listed with the count of notes under the filter, dimmed at zero but still a drop target and a place to write in,
nested notebooks nest and "No notebook" (the base's root) comes last. A notebook has "+" (a note there), a menu (note,
notebook inside, rename, delete) and takes dropped notes; a note's menu has "Move to notebook" for the keyboard.

Nothing here writes a file; `use-notebook-actions.ts` calls the vault's own operations:

- create: `createFolder` after `notebookNameProblem` (the backend's folder-name rules, no sibling of the same name in
  any case) checked against a fresh listing;
- rename: the tree's rename (`onRename`, which asks before rewriting links), then the listing is read back to confirm;
- move a note: the tree's move (`onMoveItem`, returning `moved` / `skipped` / `failed`; it rewrites links and keeps open
  tabs on the new path), after `moveCollision` refused a clash;
- create a note: `createWorkshopEntity` with `notebook` and, under a story, `storyId`;
- delete: `planNotebookDelete` refuses before any write when the notebook holds more than notes, when the rows or the
  listing are cut, or when moved names would clash (it names the notes). After a confirmation the notes go up into the
  parent with `onMoveItem`, the folders are read again and only an empty subtree goes to the trash (never
  "permanent"). A move that stops halfway leaves the folder and says every note is in the old or the new place.
