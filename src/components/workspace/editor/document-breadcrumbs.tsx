"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
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
}

export function DocumentBreadcrumbs({
  treeItems,
  docId,
  docTitle,
  docPath,
  onOpenItem,
}: DocumentBreadcrumbsProps) {
  const { t } = useTranslation()
  const breadcrumb = React.useMemo(() => buildBreadcrumb(treeItems, docId), [treeItems, docId])
  const isSuperNote = Boolean(docPath && isSuperNoteItem({ path: docPath, type: "file" }))

  if (!docId && !docTitle) return null

  const breadcrumbTrail =
    breadcrumb.length > 0 ? (
      breadcrumb.map((seg, idx) => {
        const isLast = idx === breadcrumb.length - 1
        const isClickable = !isLast && seg.kind === "file" && !!onOpenItem
        return (
          <React.Fragment key={seg.id}>
            {isClickable ? (
              <button
                type="button"
                className="max-w-[200px] truncate rounded px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => onOpenItem?.(seg.id)}
                title={seg.name}
              >
                {seg.name}
              </button>
            ) : (
              <span
                className={`max-w-[260px] truncate px-1 ${isLast ? "text-foreground" : "text-muted-foreground"}`}
                title={seg.name}
              >
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

  return (
    <>
      {breadcrumbTrail}
      {isSuperNote ? (
        <BookOpenText
          className="ml-1 size-3.5 shrink-0 text-muted-foreground"
          aria-label={t("docEditor.supernote")}
        />
      ) : (
        <FileText
          className="ml-1 size-3.5 shrink-0 text-muted-foreground"
          aria-label={t("docEditor.note")}
        />
      )}
    </>
  )
}
