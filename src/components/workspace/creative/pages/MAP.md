# Creative pages map

The parts of the pages of the workshop, a story, a universe and the standalone stories that are not the file tree's panel:
story cards, the notes board and the section gallery. The owner of the whole creative interface is the
[creative map](../MAP.md); the plan is section 16 of the [workshop plan](../../../../../docs/creative-workshop-plan.md).
Nothing here writes a file except a page or note made through `createWorkshopEntity`; every number is read from the
databases and the note index.

| Concern                                                  | Owner                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Header numbers (workshop; universe and standalone)       | [page-numbers.tsx](page-numbers.tsx)                                                                                                       |
| Body of the workshop's page                              | [workshop-overview.tsx](workshop-overview.tsx) (`WorkshopOverview`)                                                                        |
| Story tile, its star                                     | [story-card.tsx](story-card.tsx)                                                                                                           |
| Story list: filter, sort, world, "New story"             | [story-list.tsx](story-list.tsx) over [story-list-model.ts](story-list-model.ts) (pure)                                                    |
| Numbers of a story, the page to continue (pure)          | [story-stats-model.ts](story-stats-model.ts) (`computeStoryStat`, `latestWork`)                                                            |
| Numbers of every story (one `listTextStats` per story)   | [use-stories-stats.ts](use-stories-stats.ts)                                                                                               |
| Cards or timeline of a universe's stories                | [stories-view-switch.tsx](stories-view-switch.tsx), [story-timeline.tsx](story-timeline.tsx), [story-order-model.ts](story-order-model.ts) |
| Stories as cards (numbers, finished, favorite)           | [use-story-entries.ts](use-story-entries.ts)                                                                                               |
| Which pages a universe shows (two or more stories, pure) | [scope-model.ts](scope-model.ts) (`sharedInUniverse`)                                                                                      |
| Notes under their notebooks                              | [notes-board.tsx](notes-board.tsx) over [notes-board-model.ts](notes-board-model.ts) (pure)                                                |
| Section as a gallery with categories                     | [section-gallery.tsx](section-gallery.tsx) over [section-gallery-model.ts](section-gallery-model.ts) (pure)                                |
| A section on the workshop's page (whole base)            | [workshop-section.tsx](workshop-section.tsx), [use-workshop-section-data.ts](use-workshop-section-data.ts)                                 |
| A section on a story / universe / standalone page        | [scoped-section.tsx](../scoped-section.tsx) (same gallery, the pages of the scope)                                                         |
| Logical path of a note of the workshop (note header)     | [note-trail.ts](../note-trail.ts) (pure), [use-note-trail.ts](../use-note-trail.ts), [note-trail-header.tsx](../note-trail-header.tsx)     |
| Page in the tab history; its trail (breadcrumb)          | [creative-history.ts](../creative-history.ts), [page-crumbs.ts](../page-crumbs.ts), [use-story-universe.ts](../use-story-universe.ts)      |

**Workshop page.** Header: the numbers "Worlds · Stories · Words written" (worlds are the rows of the universes base).
Body: the "Continue" band (the text page changed last), `StoryList` and `NotesBoard`. The section tabs stay as they were;
a section tab is a `SectionGallery`; "Open as base" is a row of the page's "⋯" menu and opens the ordinary database tab.

**Stories.** A story's words, pages and last change come from `listTextStats` of its text database; its done pages from the
text rows' status option group `done`. A story is **finished** when its card row's status (the first `status` property of
the stories base) is in the `done` group (`isStoryFinished`, groups read by `draftsFromProperty`), whatever the option is
called. The star is the shared favorite of Amby (`useViewStateStore.favorites`, keyed by the story's `cardNoteId`; a story without a card has no star). The filter
(all, favorites, in progress, finished) and sort (last change, name, words, progress, creation) are remembered per vault in
`WorkshopPrefs.storyFilter` / `storySort`; the world filter is not.

**Gallery.** Groups are the Select/Status the first grouped view of the section's database is grouped by (`groupPropertyOf`,
`groupEntities`): options in their order, "No category" last, no heading for one group. A card shows the page's first
image (`resolveGalleryPreview`) or, without one, the initials of a character or the section's icon, and up to two story
names with "+N" (`storyLabels`). `compact` is the small list of a desk widget; `NotesBoard`'s `embedded` is its list form there. Tests: `*.test.ts(x)` beside the files, `workshop-page.test.tsx` for the whole page.

**Universe and standalone page** ([scope-desk.tsx](../scope-desk.tsx)). Header numbers: stories and words written. Stories: `StoryList`
(on a universe also the sort "In order" and the switch Cards | Timeline, the view remembered per vault in
`WorkshopPrefs.scopes`); the standalone page has cards only. The **order** of a universe's stories is the `manualOrder` of the
stories base's first view (`useViewManualOrder`; card note IDs), unplaced stories after it by the time their card was made
(`orderStoryEntries`). The timeline reorders by drag or by the arrows under a card; `mergeStoryOrder` keeps the places of other
universes' stories in that shared list. The universe's events stay under the stories. The world is one section at a time under
tabs; on a universe it is only the pages that two or more of its stories hold (`sharedInUniverse`, also applied by the section
tabs of the page through `ScopedSection`, except the anchors, whose events are the universe's own), with a line counting what only one
story holds; on the standalone page, every page of the scope and "No story" as a second gallery.

**One tab, one history.** A page opens in the current tab like a note, so workshop → universe or standalone stories → story → a section tab → a note, and
back, are steps of that tab's history (`openCreativeTab` / `openCreativeSection` in `workspace-orchestration.tsx` call `openItem`; a section step
passes `inPlace` so it never jumps to another tab). An entry is `creative:<projectId>` (the overview; the shape every earlier tab holds, read unchanged) or
`creative:<projectId>#<sectionId>`. `ProjectPage` takes `section` and `onShowSection` from the tab (without them it keeps
`creative-nav-store.sectionByProject`); "Open in a new tab" opens the page in a tab of its own.

**Header and bar.** The page wears the shared [page-chrome](../../page-chrome/MAP.md); the shell gives it history, focus, favorites, splits and the
file manager through `CreativePageHost`. Trail: Workshop › (universe or standalone stories) › story › section, every crumb but the last opens its page.
"⋯": content width (remembered per page, `contentWidths["creative:<projectId>"]`; a workshop page defaults to the whole width), favorite of the page's
note (story card, universe card), open in a new tab, split, show the folder, settings; a story adds "Customize desk" and "Compile manuscript", a
section tab on the workshop's page "Open as base". Floating bar: last change and words; a story adds the read-mode lock (`lockedFileIds`,
`creative:<projectId>`: no page, note, anchor or binding is made, no layout change) and "Customize desk". No undo: a page has none.

**Path of a note.** In the workshop a note's header shows a logical path in place of its folders (`noteTrail`; the shell hands
`CreativeNoteTrail` and `onOpenWorkshopPage` to the editor, as it does `DossierFrame`): a page of a story's text,
Workshop › universe or Standalone stories › story › the pages above › page; a story's card and a universe's note end at the story
or universe; a world or plot section's page is Workshop › section › page (shared pages: no story); a note of the notes base is
Workshop › Notes › notebooks › note. Steps open workshop pages (the section tab for a section) or a parent page, in place. The folders
stay until the path is known (`useNoteTrail` asks only when projects exist and keeps the last answer), and for every other note.
