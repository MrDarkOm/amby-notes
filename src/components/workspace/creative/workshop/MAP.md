# Workshop panel map

The body of the "Workshop" panel: one column with the story header, the text tree, anchors, notes
and the world. The owner of the whole creative interface is the [creative map](../MAP.md); the
backend of notebooks is [notebooks.rs](../../../../../src-tauri/src/project/notebooks.rs) and the contract is
[format §8](../../../../../docs/creative-format.md).

| Concern                                                    | Owner                                                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Composition, filter, drafts, data loading                  | [workshop-pane.tsx](workshop-pane.tsx), [use-database-rows.ts](use-database-rows.ts)                                    |
| Story parts (text tree, anchors, notes slot)               | [works-tab.tsx](works-tab.tsx), [text-tree-model.ts](text-tree-model.ts)                                                |
| Belonging, groups, scopes (pure)                           | [workshop-model.ts](workshop-model.ts)                                                                                  |
| The world's lists                                          | [world-section.tsx](world-section.tsx), [world-cards.tsx](world-cards.tsx)                                              |
| The bar: universe › story, "continue" line                 | [story-header.tsx](story-header.tsx) over [scope-bar.tsx](scope-bar.tsx); [use-universes.ts](use-universes.ts)          |
| Notebooks: grouping, names, delete plan                    | [notebook-model.ts](notebook-model.ts) (pure)                                                                           |
| Notebooks: listing from the disk                           | [use-notebooks.ts](use-notebooks.ts)                                                                                    |
| Notebooks: create, rename, move, delete                    | [use-notebook-actions.ts](use-notebook-actions.ts)                                                                      |
| Notebooks and notes on screen                              | [notes-part.tsx](notes-part.tsx), [item-menu.tsx](item-menu.tsx) ("Move to notebook")                                   |
| Anchors and arcs: order, marks, drag codec (pure)          | [plot-model.ts](plot-model.ts), [page-marks.tsx](page-marks.tsx)                                                        |
| Anchors and arcs: bind, unbind, ensure properties          | [use-plot-binding.ts](use-plot-binding.ts); menus in [item-menu.tsx](item-menu.tsx) (`PlotMenu`)                        |
| Plot seen from a place (pure): neighbours, ribbon, buckets | [plot-views.ts](plot-views.ts)                                                                                          |
| Anchors with no single story                               | [anchors-overview.tsx](anchors-overview.tsx), [quick-create.tsx](quick-create.tsx)                                      |
| Anchor order, `ensure_plot_links` from the interface       | [use-anchor-order.ts](use-anchor-order.ts), [use-ensure-plot.ts](use-ensure-plot.ts)                                    |
| Moves by menu: pages, anchors ahead                        | `pageMoves` (`text-tree-model.ts`), `stepAheadAnchor` (`plot-model.ts`), `ArrangeMenu` ([item-menu.tsx](item-menu.tsx)) |
| Real backend data for the model tests                      | `real-workshop.fixture.json`, kept equal to the Rust output by `contract_test.rs`; read by `workshop-contract.test.ts`  |

**Narrow panel.** The column holds its width at 320 px: the scrolling list is `overflow-x-hidden`, an empty part's label
(`EmptyAction`) and the hint lines wrap (`break-words`) instead of ending in an ellipsis, and the notice of missing
sections wraps its button. With a universe or the standalone stories shown, the parts "Anchors" and "Notes" carry no
"Story" caption; an absent base is a quiet line that points at the panel's "Create the missing sections".
Tests: `empty-action.test.tsx`, "fits a narrow panel" in `creative-panel.test.tsx`.

**One bar.** The universe and the story are one card, the universe a small grey line over the story (`scope-bar.tsx`); each choice has its own small arrow, shown while the bar is hovered, that opens its page (the story's only when a story is chosen), and the "Continue: …" line sits in the same frame. Names wrap instead of ending in an ellipsis. A scope with no story shows a "Create the first story" prompt in the story's place and hides its empty parts. The universe is
`universeFilter` (`null` is "Standalone stories", stored as `standalone`; the rows of the "Universes" base come from
`use-universes.ts`); the story is `storyFilter` (`all`, an ID, or `null`: the first story of the scope). `resolvePanelFilter`
gives story > universe > standalone; a story the scope does not hold (`storiesInScope`) or that is gone is written back as
"all", a universe that is gone as `standalone`. A universe is made by the dialog (`createWorkshopEntity`) and chosen at
once; "Universes" is left out of `worldCategories`. A story made under a universe gets its "Universe" relation written at once (`story-universe-link.ts`). Tests: `creative-panel-universes.test.tsx`, `workshop-model.test.ts`.

**Notes and notebooks.** The notes part is the notes base shown as notebooks, under the same story / universe /
standalone filter as the world: `scopeEntities` over the base's rows, so only the notes of the shown stories; the
standalone scope ends with the group "No story", a tree of its own holding the notebooks that have such notes. It stands
under a story's parts and, for a universe or the standalone stories, alone under "Story" (`NotesSlot` of `works-tab.tsx`).
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

**Anchors and arcs.** A page of the text keeps its anchors and arcs as two relations of its own database
(`text.properties.anchors`/`arcs`, [format §6](../../../../../docs/creative-format.md)); `readBindings` reads them from
the rows already held. `orderStoryAnchors` puts a bound anchor where the earliest of its pages stands in the tree
(`textOrder`, depth first) and the rest "Ahead" in the author's order (`manualOrder`, `orderByAuthor`); only "Ahead" can
be reordered by dragging, and the row of a bound anchor says why (`creative.plot.placedHint`). The anchors and arcs a story
shows are those that belong to it like any world page (`PlotPart` built in `workshop-pane.tsx` from `buildMembership`):
its "Stories" relation or a page of its text. `pageMarks` makes the row's marks (an anchor with a count, up to three arc
dots in a color `arcColor` takes from `ARC_COLORS` in `src/themes/palettes.ts` by the arc's ID, then "+N").

Binding is one call, `usePlotBinding`: drop an anchor or an arc row on a page (type `PLOT_DRAG_TYPE`), or the page's menu
"Anchors"/"Arcs" (checked = bound), or "Unbind from a page" on the anchor's or arc's own row. If the story's text lacks the
property, the first binding calls `ensurePlotLinks` (once; then, best effort, once for the anchors' own "Arcs"/"Universe"),
then writes the page's complete list of targets with `updateDatabaseRelationValue` and its row revision, so other bindings
stay. A failure shows under the row it came from. An anchor made in the panel goes through `createWorkshopEntity`, so it
belongs to the shown story from the first write.

**Plot from other places (part 6b).** `plot-views.ts` holds every computation the components only show:
`pageNeighbours` (the anchors of a page, the nearest bound anchor before and after it by `orderStoryAnchors`, else the
first "ahead"), `anchorRibbon` (a story's anchors in the text's order, "passed" when the first page's status group is
`done`; no screen uses it now), `bucketAnchors` (the standalone stories: the anchors of those stories in the author's order, those with no story, no page and no universe last, a universe's events not shown;
a universe: its events first), `universeEvents`, `arcAnchors` / `arcChapters` (per story in text order, the unbound
last, the span first to last page), `characterArcs` (the incoming references through the arcs' "Characters"),
`anchorLinksMissing`. With no single story shown the anchors part is `AnchorsOverview` (`AnchorsSlot` of `works-tab.tsx`),
and an anchor made there while a universe is shown is an event of it. `useAnchorOrder` is the one source of the author's
order (the first view's `manualOrder` and the creation times) for the panel, the desk, the universe page and the aside.
`usePlotEnsurer` owns `ensure_plot_links`: the panel and the project page call `ensureAnchorLinks` after a base was made and
before an event is written, and show its failure; the binding of a page only logs a failure of the anchors' own relations.
The aside of a text page and the blocks of an arc and a character live in [dossier/](../dossier/).

**Moving without the mouse.** Every row's menu (`ItemMenu`) opens from the keyboard as in the file tree (the Menu key or
Shift+F10, `openMenuOnKey`). A page of the text has "Move up", "Move down", "Nest under the previous page" and "Move out one
level": `pageMoves` is `planMove` (the drop's own rules: levels, loop, edges) over the neighbours, so an entry that a drop would
refuse is greyed out and the others call `move_text_page` through the same `commitMove` as a drop. An anchor in "Ahead" has
"Move up" / "Move down", which write the first view's `manualOrder` as dragging does (`stepAheadAnchor`); a bound anchor has none,
its place is the text's. Tests: `creative-panel-arrange.test.tsx`.
