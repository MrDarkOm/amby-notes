# Story desk map

The widgets of a story's overview tab (`ProjectDesk`, [project-desk.tsx](../project-desk.tsx)). The owner of the whole
creative interface is the [creative map](../MAP.md); the plan is section 16 of the
[workshop plan](../../../../../docs/creative-workshop-plan.md). The desk reads the databases and the note index and
writes only through the calls the panel uses (`createTextPage`, `moveTextPage`, `createWorkshopEntity`,
`updateDatabaseRelationValue` by `usePlotBinding`); compiling the manuscript only reads and writes one new file.

| Concern                                           | Owner                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Widgets, order, widths, hidden, columns (pure)    | [desk-layout-model.ts](desk-layout-model.ts)                                            |
| The card of a widget (title, count, "Open")       | [desk-widget.tsx](desk-widget.tsx)                                                      |
| Layout mode: up, down, width, hide                | [desk-controls.tsx](desk-controls.tsx); the tray and the hint are in `project-desk.tsx` |
| Own width of the desk                             | [use-element-width.ts](use-element-width.ts)                                            |
| Continue, Progress (and the manuscript)           | [continue-widget.tsx](continue-widget.tsx), [progress-widget.tsx](progress-widget.tsx)  |
| Chapters: outline, moves, new page, "Ahead" strip | [chapters-widget.tsx](chapters-widget.tsx)                                              |
| Notes of the story, the world of the story        | `NotesBoard` (`embedded`) and `SectionGallery` (`compact`) of [pages/](../pages/MAP.md) |

**Grid.** Three columns when the desk is 860 px wide or more, two from 560 and one below (`deskColumns`, measured on the
desk itself because side panels change its width; unmeasured is wide). A widget spans 1, 2 or 3 columns, never more than
the desk has (`effectiveSpan`). Default order: Continue (2), Progress (1), Chapters (2), Notes (1), Characters, Locations,
Arcs (1 each), then the author's own sections (`availableWidgets`; ID `section:<sectionId>`).

**One layout for every story.** `WorkshopPrefs.deskLayout` (`{ id, span, hidden }[]`, per vault) is written by the page
(`project-page.tsx`, "Customize desk" in the page's "⋯" menu and on the floating bar) and reconciled with the widgets the story can show
before use (`reconcileDeskLayout`: new widgets appear last, unknown ones and repeats are dropped, a bad width is the
default). `moveWidget`, `nextSpan` / `setWidgetSpan` and `setWidgetHidden` are the changes; no free dragging.

**Chapters.** The text as the panel's tree (`buildTextTree`): a status dot by the page's status group, the level icon, the
anchors' mark and arc dots (`pageMarks`), the words of the page with what is below it. A page's menu has the panel's moves
(`pageMoves`, committed with `moveTextPage`) and "Add a page inside"; "+ <first level>" makes a top-level page
(`startLevelId`, `lastOrderKey`, `createTextPage`). "Ahead" lists the story's anchors bound to no page
(`orderStoryAnchors`); an anchor is dragged onto a page (`PLOT_DRAG_TYPE`) or bound from its own menu through
`usePlotBinding`, as the panel does. Tests: `project-desk.test.tsx`, `project-desk-ahead.test.tsx`,
`../desk-customize.test.tsx`.

**Read mode.** `ProjectDesk` takes `locked` (the story page's lock): nothing is created, moved or bound (`canWrite` is false, the galleries get no
`createFor`) and the layout mode is off. `compileRef` hands the page's menu the same "Compile manuscript" as the Progress widget's button.
