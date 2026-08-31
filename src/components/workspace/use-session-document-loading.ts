import * as React from "react"
import { errorType, logger } from "@/lib/logger"
import type { Document } from "./use-doc-store"
import { useDocStore } from "./use-doc-store"
import { useTabsStore, type Tab } from "./use-tabs-store"
import { useVaultStore } from "./use-vault-store"

interface SessionDocumentLoadingOptions {
  tabs: Tab[]
  isLoaded: (fileId: string) => boolean
  isCurrent: () => boolean
  loadDocument: (fileId: string, title: string) => Promise<Document>
  onLoadError?: (fileId: string, error: unknown) => void
}

/** Sequential loading prevents restored tabs from opening concurrent native prompts. */
export async function loadMissingSessionDocuments({
  tabs,
  isLoaded,
  isCurrent,
  loadDocument,
  onLoadError,
}: SessionDocumentLoadingOptions): Promise<void> {
  const seen = new Set<string>()
  for (const tab of tabs) {
    if (!isCurrent()) return
    if (tab.kind !== "document" || seen.has(tab.fileId) || isLoaded(tab.fileId)) continue
    seen.add(tab.fileId)
    try {
      await loadDocument(tab.fileId, tab.title)
    } catch (error) {
      if (isCurrent()) onLoadError?.(tab.fileId, error)
    }
  }
}

/** Loads restored document tabs through the same recovery-aware path as a user click. */
export function useSessionDocumentLoading(
  loadDocument: (fileId: string, title: string) => Promise<Document>,
): void {
  const tabs = useTabsStore((state) => state.tabs)
  const generation = useVaultStore((state) => state.generation)

  React.useEffect(() => {
    let current = true
    void loadMissingSessionDocuments({
      tabs,
      isLoaded: (fileId) => Boolean(useDocStore.getState().openDocs[fileId]),
      isCurrent: () => current && useVaultStore.getState().generation === generation,
      loadDocument,
      onLoadError: (fileId, error) =>
        logger.warn("session.document_load_failed", { fileId, errorType: errorType(error) }),
    })
    return () => {
      current = false
    }
  }, [generation, loadDocument, tabs])
}
