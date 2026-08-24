import * as React from "react"
import type { TFunction } from "i18next"
import {
  deleteCustomProperty,
  type CustomProperty,
  type TreeItem,
  upsertCustomProperty,
} from "@/lib/storage"
import { countFolderContents } from "../folder-view-utils"
import type { Tab } from "../use-tabs-store"
import { useDocStore } from "../use-doc-store"
import { findTreeItem } from "../workspace-tree-utils"
import { workspaceRelativePath } from "../vault/use-vault-session"

type OpenDocument = ReturnType<typeof useDocStore.getState>["openDocs"][string]

type UsePropertyActionsParams = {
  activeTab: Tab | null
  currentDoc: OpenDocument | null
  displayTreeItems: TreeItem[]
  linkGraph: { edges: Array<{ target: string }> }
  t: TFunction
  vault: string | null
}

/** Derives Info-panel metadata and applies durable custom-property mutations. */
export function usePropertyActions({
  activeTab,
  currentDoc,
  displayTreeItems,
  linkGraph,
  t,
  vault,
}: UsePropertyActionsParams) {
  const currentProperties = React.useMemo(() => {
    if (activeTab?.kind === "folder") {
      const folder = findTreeItem(displayTreeItems, activeTab.fileId)
      if (!folder || folder.type !== "folder") return null
      const counts = countFolderContents(folder)
      return {
        kind: "folder" as const,
        type: t("infoPanel.folderType"),
        id: folder.id,
        path: workspaceRelativePath(folder.path, vault ?? ""),
        noteCount: counts.notes,
        folderCount: counts.folders,
        nestedNotes: (folder.children ?? [])
          .filter((item) => item.type === "file")
          .map((item) => ({
            id: item.id,
            name: item.name.replace(/\.md$/iu, ""),
            icon: item.icon,
          })),
      }
    }
    if (!currentDoc) return null
    const treeItem = findTreeItem(displayTreeItems, currentDoc.id)
    const nestedNotes = (treeItem?.children ?? [])
      .filter((item) => item.type === "file")
      .map((item) => ({ id: item.id, name: item.name.replace(/\.md$/iu, ""), icon: item.icon }))
    return {
      kind: "document" as const,
      type: "Markdown",
      backlinks: linkGraph.edges.filter((edge) => edge.target === currentDoc.id).length,
      created: currentDoc.created,
      modified: currentDoc.modified,
      id: currentDoc.id,
      frontmatter: currentDoc.noteProperties ?? {
        hasFrontmatter: false,
        properties: [],
        customProperties: [],
      },
      nestedNotes,
    }
  }, [activeTab?.fileId, activeTab?.kind, currentDoc, displayTreeItems, linkGraph, t, vault])

  const handleUpsertCustomProperty = React.useCallback(
    async (property: CustomProperty) => {
      if (!vault || !currentDoc) throw new Error("No active document")
      const saved = await upsertCustomProperty(vault, currentDoc.id, property)
      const current = currentDoc.noteProperties ?? {
        hasFrontmatter: false,
        properties: [],
        customProperties: [],
      }
      const next = [...current.customProperties]
      const index = next.findIndex((item) => item.id === saved.id)
      if (index >= 0) next[index] = saved
      else next.push(saved)
      useDocStore.getState().patchDoc(currentDoc.id, {
        noteProperties: { ...current, customProperties: next },
      })
      return saved
    },
    [currentDoc, vault],
  )

  const handleDeleteCustomProperty = React.useCallback(
    async (propertyId: string) => {
      if (!vault || !currentDoc) return
      await deleteCustomProperty(vault, currentDoc.id, propertyId)
      const current = currentDoc.noteProperties
      if (!current) return
      useDocStore.getState().patchDoc(currentDoc.id, {
        noteProperties: {
          ...current,
          customProperties: current.customProperties.filter((item) => item.id !== propertyId),
        },
      })
    },
    [currentDoc, vault],
  )

  return { currentProperties, handleUpsertCustomProperty, handleDeleteCustomProperty }
}
