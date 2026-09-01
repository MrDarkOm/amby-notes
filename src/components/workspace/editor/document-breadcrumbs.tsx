"use client"

import * as React from "react"
import { BookOpenText, FileText } from "lucide-react"

import type { TreeItem } from "../sidebar-tree"
import { isSuperNoteItem } from "../workspace-tree-utils"
import { buildBreadcrumb } from "./document-breadcrumbs-utils"

export interface DocumentBreadcrumbsProps {
  treeItems?: TreeItem[]
  docId?: string
  docTitle?: string
  docPath?: string
  onOpenItem?: (id: string) => void
  expanded?: boolean
  onExpandChange?: (expanded: boolean) => void
}

export function DocumentBreadcrumbs({
  treeItems,
  docId,
  docTitle,
  docPath,
  onOpenItem,
  expanded = false,
  onExpandChange,
}: DocumentBreadcrumbsProps) {
  const breadcrumb = React.useMemo(() => buildBreadcrumb(treeItems, docId), [treeItems, docId])
  const isSuperNote = Boolean(docPath && isSuperNoteItem({ path: docPath, type: "file" }))

  if (!docId && !docTitle) return null

  const breadcrumbTrail =
    breadcrumb.length > 0 ? (
      (!expanded && breadcrumb.length > 4
        ? [
            breadcrumb[0],
            { id: "__ellipsis__", name: "…", kind: "folder" as const },
            ...breadcrumb.slice(-2),
          ]
        : breadcrumb
      ).map((seg, idx, visible) => {
        const isLast = idx === visible.length - 1
        const isEllipsis = seg.id === "__ellipsis__"
        const isClickable = !isLast && !!onOpenItem
        return (
          <React.Fragment key={seg.id}>
            {isEllipsis ? (
              <span
                className="shrink-0 px-1 text-muted-foreground"
                title={breadcrumb
                  .slice(1, -2)
                  .map((item) => item.name)
                  .join(" › ")}
                onMouseEnter={() => onExpandChange?.(true)}
                onMouseLeave={() => onExpandChange?.(false)}
              >
                …
              </span>
            ) : isClickable ? (
              <button
                type="button"
                data-breadcrumb-segment
                className="max-w-[200px] truncate rounded px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => onOpenItem?.(seg.id)}
                title={seg.name}
              >
                {isLast &&
                  (isSuperNote ? (
                    <BookOpenText className="mr-1 inline-block size-3 align-middle" />
                  ) : (
                    <FileText className="mr-1 inline-block size-3 align-middle" />
                  ))}
                {seg.name}
              </button>
            ) : (
              <span
                data-breadcrumb-segment
                className={`max-w-[260px] truncate px-1 ${isLast ? "inline-flex items-center gap-1 text-foreground" : "text-muted-foreground"}`}
                title={seg.name}
              >
                {isLast &&
                  (isSuperNote ? (
                    <BookOpenText className="size-3 shrink-0" />
                  ) : (
                    <FileText className="size-3 shrink-0" />
                  ))}
                {seg.name}
              </span>
            )}
            {!isLast && <span className="shrink-0 text-muted-foreground">›</span>}
          </React.Fragment>
        )
      })
    ) : docTitle ? (
      <span className="truncate text-muted-foreground">{docTitle}</span>
    ) : null

  return <>{breadcrumbTrail}</>
}
