import * as React from "react"
import type { TFunction } from "i18next"
import {
  deleteCustomProperty,
  reorderCustomProperties,
  type CustomProperty,
  type TreeItem,
  upsertCustomProperty,
} from "@/lib/storage"
import { countFolderContents } from "../folder-view-utils"
import type { Tab } from "../use-tabs-store"
import { useDocStore } from "../use-doc-store"
import { findTreeItem } from "../workspace-tree-utils"
import { workspaceRelativePath } from "../vault/use-vault-session"
import type { AttachmentItem } from "../panel-registry"

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
      }
    }
    if (!currentDoc) return null
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
    }
  }, [activeTab?.fileId, activeTab?.kind, currentDoc, displayTreeItems, linkGraph, t, vault])

  const attachments = React.useMemo<AttachmentItem[]>(() => {
    const source =
      activeTab?.kind === "folder"
        ? findTreeItem(displayTreeItems, activeTab.fileId)
        : currentDoc
          ? findTreeItem(displayTreeItems, currentDoc.id)
          : null
    return (source?.children ?? [])
      .filter((item) => item.type === "file")
      .map((item) => ({
        id: item.id,
        name: item.name.replace(/\.md$/iu, ""),
        icon: item.icon,
        kind: "note" as const,
      }))
  }, [activeTab?.fileId, activeTab?.kind, currentDoc, displayTreeItems])

  const attachmentImages = React.useMemo<AttachmentItem[]>(() => {
    if (!currentDoc) return []
    const notePath = currentDoc.path.replace(/\\/g, "/")
    const noteDir = notePath.slice(0, notePath.lastIndexOf("/"))
    const refs: string[] = []
    const markdownImage = /!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))/gu
    const htmlImage = /<img\b[^>]*\bsrc=["']([^"']+)["']/giu
    for (const match of currentDoc.content.matchAll(markdownImage)) refs.push(match[1] ?? match[2])
    for (const match of currentDoc.content.matchAll(htmlImage)) refs.push(match[1])
    const seen = new Set<string>()
    const items = refs.flatMap((ref) => {
      const cleanRef = ref.trim().replace(/[?#].*$/u, "")
      if (!cleanRef || /^(?:data:|https?:|mailto:)/iu.test(cleanRef)) return []
      const normalized = cleanRef.replace(/\\/g, "/")
      const name = normalized.split("/").pop() || normalized
      const key = normalized.toLocaleLowerCase()
      if (seen.has(key)) return []
      seen.add(key)
      const path = /^(?:\/[\s\S]*|[A-Za-z]:\/)/u.test(normalized)
        ? normalized
        : noteDir
          ? `${noteDir}/${normalized}`
          : normalized
      return [
        {
          id: `image:${currentDoc.id}:${normalized}`,
          name,
          icon: "🖼️",
          kind: "image" as const,
          path,
        },
      ]
    })
    return items
  }, [currentDoc])

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

  const handleReorderCustomProperties = React.useCallback(
    async (propertyIds: string[]) => {
      if (!vault || !currentDoc?.noteProperties) return
      await reorderCustomProperties(vault, currentDoc.id, propertyIds)
      const byId = new Map(
        currentDoc.noteProperties.customProperties.map((property) => [property.id, property]),
      )
      useDocStore.getState().patchDoc(currentDoc.id, {
        noteProperties: {
          ...currentDoc.noteProperties,
          customProperties: propertyIds.flatMap((id) => {
            const property = byId.get(id)
            return property ? [property] : []
          }),
        },
      })
    },
    [currentDoc, vault],
  )

  return {
    currentProperties,
    attachments,
    attachmentImages,
    handleUpsertCustomProperty,
    handleDeleteCustomProperty,
    handleReorderCustomProperties,
  }
}
