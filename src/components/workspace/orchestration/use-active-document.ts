import * as React from "react"
import { isLayerDocument, naturalDocumentLayer } from "../layer-documents"
import { useDocStore, type Document } from "../use-doc-store"
import type { Tab } from "../use-tabs-store"
import { useViewStateStore, type EditorLayer } from "../use-view-state-store"
import type { TreeItem } from "../sidebar-tree"
import { createFallbackDocument } from "./fallback-document"

export interface ActiveDocument {
  /** The open buffer of the active tab; a placeholder for a canvas or sketch page. */
  currentDoc: Document | null
  currentDocId: string | null
  currentDocPath: string | null
  /** The layer a page opens in when the person has not chosen one. */
  currentDocDefaultLayer: EditorLayer
}

/**
 * The document of the active tab and what is derived from it (SHELL-04). The text is not
 * subscribed to: the editors read their own buffers, and a keystroke does not render the caller.
 * Only whether the buffer exists is subscribed to, which fixes the startup race when the tab is
 * restored before its note is read.
 */
export function useActiveDocument(
  activeTab: Tab | null,
  treeItemById: Map<string, TreeItem>,
): ActiveDocument {
  const activeDocumentLoaded = useDocStore((state) => {
    if (!activeTab) return false
    if (isLayerDocument(activeTab)) return true
    return Boolean(state.openDocs[activeTab.fileId])
  })
  const openDocs = useDocStore.getState().openDocs

  const currentDoc = React.useMemo(() => {
    if (!activeTab) return null
    const existing = openDocs[activeTab.fileId] ?? null
    if (existing) return existing
    if (isLayerDocument(activeTab)) {
      const treeItem = treeItemById.get(activeTab.fileId)
      return createFallbackDocument(
        activeTab.fileId,
        activeTab.title,
        treeItem?.path ?? activeTab.fileId,
        treeItem?.created,
        treeItem?.modified,
      )
    }
    return activeDocumentLoaded ? (openDocs[activeTab.fileId] ?? null) : null
  }, [activeDocumentLoaded, activeTab, openDocs, treeItemById])
  const currentDocId = currentDoc?.id ?? null
  const currentDocPath = currentDoc?.path ?? null
  const currentDocDefaultLayer: EditorLayer =
    (currentDocId ? useViewStateStore.getState().primaryLayers[currentDocId] : undefined) ??
    (currentDocPath ? useViewStateStore.getState().primaryLayers[currentDocPath] : undefined) ??
    naturalDocumentLayer(activeTab, currentDocPath)

  // A canvas or sketch page has no note buffer yet: seed one, with the layer it opens in.
  React.useEffect(() => {
    if (!activeTab) return
    if (!isLayerDocument(activeTab)) return
    const docId = activeTab.fileId
    const existing = useDocStore.getState().openDocs[docId]
    if (!existing) {
      const treeItem = treeItemById.get(docId)
      const path = treeItem?.path ?? docId
      const docObj = createFallbackDocument(
        docId,
        activeTab.title,
        path,
        treeItem?.created,
        treeItem?.modified,
      )
      useDocStore.getState().setDoc(docId, docObj)
      if (path && path !== docId) {
        useDocStore.getState().setDoc(path, docObj)
      }
      const defaultLayer: EditorLayer =
        useViewStateStore.getState().primaryLayers[docId] ??
        (path ? useViewStateStore.getState().primaryLayers[path] : undefined) ??
        naturalDocumentLayer(activeTab, path)
      if (!useViewStateStore.getState().activeLayers[docId]) {
        useViewStateStore.getState().setActiveLayer(docId, defaultLayer)
      }
    }
  }, [activeTab, treeItemById])

  return { currentDoc, currentDocId, currentDocPath, currentDocDefaultLayer }
}
