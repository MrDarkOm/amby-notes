"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import type { DatabaseRow } from "@/lib/storage"
import { useDocStore, type Document } from "../use-doc-store"

const PeekDocumentEditor = React.lazy(() =>
  import("../document-editor").then((module) => ({ default: module.DocumentEditor })),
)

export interface PeekRowEditorProps {
  row: DatabaseRow
  vault?: string
  onLoad: (row: DatabaseRow) => Promise<Document>
  onContentChange?: (fileId: string, content: string) => void
}

export function PeekRowEditor({ row, vault, onLoad, onContentChange }: PeekRowEditorProps) {
  const { t } = useTranslation()
  const document = useDocStore((state) => state.openDocs[row.noteId] ?? null)
  const [error, setError] = React.useState<string | null>(null)

  const onLoadRef = React.useRef(onLoad)
  const rowRef = React.useRef(row)
  React.useEffect(() => {
    onLoadRef.current = onLoad
    rowRef.current = row
  }, [onLoad, row])

  React.useEffect(() => {
    let cancelled = false
    setError(null)
    void onLoadRef.current(rowRef.current).catch((loadError) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError))
    })
    return () => {
      cancelled = true
    }
  }, [row.noteId])

  if (error) return <p className="p-4 text-xs text-destructive">{error}</p>
  if (!document) {
    return <p className="p-4 text-xs text-muted-foreground">{t("databasePeek.loading")}</p>
  }
  return (
    <React.Suspense
      fallback={<p className="p-4 text-xs text-muted-foreground">{t("databasePeek.loading")}</p>}
    >
      <PeekDocumentEditor
        document={document}
        vault={vault}
        hideNavigation
        editorSurfaceOwner="databasePeek"
        onContentChange={(content, sourceDocumentId) =>
          onContentChange?.(sourceDocumentId, content)
        }
      />
    </React.Suspense>
  )
}
