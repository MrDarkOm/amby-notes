# Page chrome map

The header and the floating bar that every page of the app wears. A surface renders them inside itself
(so the header stays one piece with the page) and passes in what it has; the parts it does not pass are not
drawn. A note, the graph and a workshop page all use them; do not make a copy for a new surface.

| Concern                                                | Owner                                                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Header: back/forward, breadcrumb, focus, "⋯"           | [page-header-bar.tsx](page-header-bar.tsx) (`docked`, or `floating` over a canvas)                                                  |
| Breadcrumb: crumbs, folding of a long trail            | [page-breadcrumbs.tsx](page-breadcrumbs.tsx)                                                                                        |
| "⋯" menu from groups of rows                           | [page-menu.tsx](page-menu.tsx); the "Content width" and "Hide/Show the bottom bar" rows: [page-menu-items.tsx](page-menu-items.tsx) |
| Floating bar: change, words, undo/redo, lock, settings | [page-floating-bar.tsx](page-floating-bar.tsx)                                                                                      |
| Shapes: crumb, menu row and group, focus tab menu      | [page-chrome-types.ts](page-chrome-types.ts)                                                                                        |

**Adapters.** The note builds its crumbs from the tree and its menu groups in
[document-menu.tsx](../editor/document-menu.tsx) (`DocumentHeader`, `DocumentAreaControls`); the graph passes its own
buttons into the `floating` header and its counts and lock into the bar; a workshop page builds its crumbs
([page-crumbs.ts](../creative/page-crumbs.ts)) and menu in [project-page.tsx](../creative/project-page.tsx). A menu row is
data (`PageMenuItem`: icon, label, `checked`, `submenu`, `destructive`, `disabled`, `onSelect`); a separator stands between
two groups that have rows. Keep the note's markup: [document-header.test.tsx](../editor/document-header.test.tsx) holds
its menu, order and separators.

The bar's width decides what a docked header shows (`PageHeaderSize`: the path goes under 420 px, the layer switch folds
under 340, the focus button goes under 250). Tests: `*.test.tsx` beside the files.
