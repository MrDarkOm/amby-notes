import { BookOpenText, Database, FileText, LayoutGrid, PenLine } from "lucide-react"

import type { TreeItem } from "../sidebar-tree"
import type { PageCrumb } from "../page-chrome/page-chrome-types"
import { isSuperNoteItem } from "../workspace-tree-utils"
import { buildBreadcrumb, findBreadcrumbTrail } from "./document-breadcrumbs-utils"

/**
 * The crumbs of a note: the folders it lies in, then the note itself. The shared header draws
 * them; folders open when the surface can open an item.
 */
export function documentCrumbs(
  treeItems: TreeItem[] | undefined,
  docId: string | undefined,
  docPath: string | undefined,
  onOpenItem: ((id: string) => void) | undefined,
): PageCrumb[] {
  // Canvas and sketch documents are keyed by path while their tree rows are prefixed.
  const rowId =
    docId && treeItems
      ? [docId, `canvas:${docId}`, `sketch:${docId}`, `database:${docId}`].find((id) =>
          findBreadcrumbTrail(treeItems, id),
        )
      : undefined
  const rowTrail = rowId && treeItems ? findBreadcrumbTrail(treeItems, rowId) : null
  const rowType = rowTrail?.[rowTrail.length - 1]?.type
  const trail = buildBreadcrumb(treeItems, rowId ?? docId)
  const isSuperNote = Boolean(docPath && isSuperNoteItem({ path: docPath, type: "file" }))
  return trail.map((segment, index) => {
    const isLast = index === trail.length - 1
    return {
      key: segment.id,
      label: segment.name,
      icon: isLast ? (
        rowType === "sketch" ? (
          <PenLine className="size-3 shrink-0" />
        ) : rowType === "canvas" ? (
          <LayoutGrid className="size-3 shrink-0" />
        ) : rowType === "database" ? (
          <Database className="size-3 shrink-0" />
        ) : isSuperNote ? (
          <BookOpenText className="size-3 shrink-0" />
        ) : (
          <FileText className="size-3 shrink-0" />
        )
      ) : undefined,
      onOpen: onOpenItem ? () => onOpenItem(segment.id) : undefined,
    }
  })
}
