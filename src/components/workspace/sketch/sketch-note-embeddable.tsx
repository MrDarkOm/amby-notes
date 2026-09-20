"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { FileText, FileX } from "lucide-react"
import { cn } from "@/lib/utils"
import { readFile } from "@/lib/storage"
import { pathStem, renderCardHtml, resolveVaultFilePath } from "../canvas/canvas-markdown"
import { useViewStateStore } from "../use-view-state-store"
import { TreeIcon } from "../tree/tree-icons"

export interface SketchNoteEmbeddableProps {
  notePath: string
  vault?: string | null
  onOpenNote?: (file: string) => void
}

export function SketchNoteEmbeddable({ notePath, vault, onOpenNote }: SketchNoteEmbeddableProps) {
  const { t } = useTranslation()
  const title = notePath ? pathStem(notePath) : ""

  const [previewState, setPreviewState] = React.useState<{
    loading: boolean
    exists: boolean
    html: string
    hasHeading: boolean
  }>({
    loading: Boolean(notePath),
    exists: true,
    html: "",
    hasHeading: false,
  })

  const iconOverride = useViewStateStore(
    (s) => s.iconOverrides[notePath] ?? s.iconOverrides[title] ?? undefined,
  )

  React.useEffect(() => {
    if (!notePath) {
      setPreviewState({ loading: false, exists: true, html: "", hasHeading: false })
      return
    }

    let cancelled = false
    const abs = resolveVaultFilePath(notePath, vault ?? undefined)

    readFile(abs)
      .then((raw) => {
        if (cancelled) return
        const body = raw.replace(/^---[\s\S]*?---\n?/u, "").trim()
        // Check if markdown already starts with an H1 or H2 title
        const hasHeading = /^#{1,2}\s+/m.test(body)
        const rendered = renderCardHtml(body)
        setPreviewState({ loading: false, exists: true, html: rendered, hasHeading })
      })
      .catch(() => {
        if (cancelled) return
        setPreviewState({ loading: false, exists: false, html: "", hasHeading: false })
      })

    return () => {
      cancelled = true
    }
  }, [notePath, vault])

  const handleOpen = (e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (notePath && previewState.exists) {
      onOpenNote?.(notePath)
    }
  }

  return (
    <div
      className={cn(
        "group relative flex h-full w-full flex-col overflow-hidden text-foreground select-none p-4",
        !previewState.exists && "text-destructive",
      )}
      onDoubleClick={handleOpen}
      title={notePath}
    >
      {/* Title with icon if not already starting with H1/H2 */}
      {!previewState.hasHeading && previewState.exists && (
        <div className="mb-2 flex items-center gap-1.5 pr-6 shrink-0">
          {iconOverride ? (
            <TreeIcon icon={iconOverride} className="size-4 shrink-0" />
          ) : (
            <FileText className="size-4 shrink-0 text-primary" />
          )}
          <h2 className="truncate text-base font-bold leading-tight tracking-tight text-foreground">
            {title || t("canvas.noteNotSelected")}
          </h2>
        </div>
      )}

      {/* Content Preview (Scrollable, full markdown, no truncation) */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden [scrollbar-width:thin] nowheel min-h-0">
        {!previewState.exists ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center text-xs text-destructive py-4">
            <FileX className="size-5" />
            <span className="font-semibold">{t("canvas.fileNotFound")}</span>
            <span className="truncate max-w-[90%] text-[10px] text-muted-foreground">
              {notePath}
            </span>
          </div>
        ) : previewState.loading ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {t("canvas.loadingNote")}
          </div>
        ) : previewState.html ? (
          <div
            className="canvas-md text-xs leading-relaxed text-foreground/90 space-y-1.5"
            dangerouslySetInnerHTML={{ __html: previewState.html }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {notePath ? t("canvas.doubleClickOpen") : t("canvas.noteNotSelected")}
          </div>
        )}
      </div>
    </div>
  )
}
