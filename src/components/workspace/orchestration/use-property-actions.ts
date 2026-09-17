import * as React from "react"
import type { TFunction } from "i18next"
import {
  deleteCustomProperty,
  getNoteProperties,
  reorderCustomProperties,
  type CustomProperty,
  type NoteProperties,
  type TreeItem,
  upsertCustomProperty,
} from "@/lib/storage"
import { countFolderContents } from "../folder-view-utils"
import type { Tab } from "../use-tabs-store"
import { useDocStore } from "../use-doc-store"
import { workspaceRelativePath } from "../vault/use-vault-session"
import type { AttachmentItem } from "../panel-registry"

type OpenDocument = ReturnType<typeof useDocStore.getState>["openDocs"][string]

type UsePropertyActionsParams = {
  activeTab: Tab | null
  currentDoc: OpenDocument | null
  treeItemById: ReadonlyMap<string, TreeItem>
  linkGraph: { edges: Array<{ target: string }> }
  t: TFunction
  vault: string | null
  includeAttachmentImages?: boolean
}

/** Derives Info-panel metadata and applies durable custom-property mutations. */
export function usePropertyActions({
  activeTab,
  currentDoc,
  treeItemById,
  linkGraph,
  t,
  vault,
  includeAttachmentImages = true,
}: UsePropertyActionsParams) {
  const backlinkCounts = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const edge of linkGraph.edges) {
      counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1)
    }
    return counts
  }, [linkGraph])

  const currentProperties = React.useMemo(() => {
    if (activeTab?.kind === "folder") {
      const folder = treeItemById.get(activeTab.fileId)
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
      backlinks: backlinkCounts.get(currentDoc.id) ?? 0,
      created: currentDoc.created,
      modified: currentDoc.modified,
      id: currentDoc.id,
      frontmatter: currentDoc.noteProperties ?? {
        hasFrontmatter: false,
        properties: [],
        customProperties: [],
      },
    }
  }, [activeTab?.fileId, activeTab?.kind, backlinkCounts, currentDoc, t, treeItemById, vault])

  const attachments = React.useMemo<AttachmentItem[]>(() => {
    const source =
      activeTab?.kind === "folder"
        ? treeItemById.get(activeTab.fileId)
        : currentDoc
          ? treeItemById.get(currentDoc.id)
          : null
    return (source?.children ?? [])
      .filter((item) => item.type === "file")
      .map((item) => ({
        id: item.id,
        name: item.name.replace(/\.md$/iu, ""),
        icon: item.icon,
        kind: "note" as const,
      }))
  }, [activeTab?.fileId, activeTab?.kind, currentDoc, treeItemById])

  const attachmentImages = React.useMemo<AttachmentItem[]>(() => {
    if (!includeAttachmentImages || !currentDoc) return []
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
  }, [currentDoc, includeAttachmentImages])

  const patchAllDocKeys = React.useCallback(
    (updater: (current: NoteProperties) => NoteProperties) => {
      if (!currentDoc) return
      const store = useDocStore.getState()
      const keys = new Set<string>()
      if (currentDoc.id) keys.add(currentDoc.id)
      if (currentDoc.path) keys.add(currentDoc.path)
      if (currentDoc.noteId) keys.add(currentDoc.noteId)
      if (activeTab?.fileId) keys.add(activeTab.fileId)
      for (const key of keys) {
        const doc = store.openDocs[key]
        if (doc) {
          const current = doc.noteProperties ?? {
            hasFrontmatter: false,
            properties: [],
            customProperties: [],
          }
          store.patchDoc(key, { noteProperties: updater(current) })
        }
      }
    },
    [activeTab?.fileId, currentDoc],
  )

  const handleUpsertCustomProperty = React.useCallback(
    async (property: CustomProperty) => {
      if (!vault || !currentDoc) throw new Error("No active document")
      const noteId = currentDoc.noteId ?? currentDoc.id

      patchAllDocKeys((current: NoteProperties) => {
        const next = [...current.customProperties]
        const index = next.findIndex(
          (item: CustomProperty) =>
            item.id === property.id ||
            (property.name && item.name.toLowerCase() === property.name.toLowerCase()),
        )
        if (index >= 0) next[index] = { ...next[index], ...property }
        else next.push(property)
        return { ...current, customProperties: next }
      })

      const saved = await upsertCustomProperty(vault, noteId, property)
      try {
        const refreshed = await getNoteProperties(vault, noteId)
        patchAllDocKeys(() => refreshed)
      } catch {
        patchAllDocKeys((current: NoteProperties) => {
          const next = [...current.customProperties]
          const index = next.findIndex((item: CustomProperty) => item.id === saved.id)
          if (index >= 0) next[index] = saved
          else next.push(saved)
          return { ...current, customProperties: next }
        })
      }
      return saved
    },
    [currentDoc, patchAllDocKeys, vault],
  )

  const handleDeleteCustomProperty = React.useCallback(
    async (propertyId: string) => {
      if (!vault || !currentDoc) return
      const noteId = currentDoc.noteId ?? currentDoc.id

      patchAllDocKeys((current: NoteProperties) => ({
        ...current,
        properties: current.properties.filter((item: { key: string }) => item.key !== propertyId),
        customProperties: current.customProperties.filter(
          (item: CustomProperty) => item.id !== propertyId,
        ),
      }))

      await deleteCustomProperty(vault, noteId, propertyId)
      try {
        const refreshed = await getNoteProperties(vault, noteId)
        patchAllDocKeys(() => refreshed)
      } catch {
        // Optimistic state already set
      }
    },
    [currentDoc, patchAllDocKeys, vault],
  )

  const handleReorderCustomProperties = React.useCallback(
    async (propertyIds: string[]) => {
      if (!vault || !currentDoc?.noteProperties) return
      const noteId = currentDoc.noteId ?? currentDoc.id

      patchAllDocKeys((current: NoteProperties) => {
        const byId = new Map(
          current.customProperties.map((property: CustomProperty) => [property.id, property]),
        )
        return {
          ...current,
          customProperties: propertyIds.flatMap((id) => {
            const property = byId.get(id)
            return property ? [property] : []
          }),
        }
      })

      await reorderCustomProperties(vault, noteId, propertyIds)
      try {
        const refreshed = await getNoteProperties(vault, noteId)
        patchAllDocKeys(() => refreshed)
      } catch {
        // Optimistic state already set
      }
    },
    [currentDoc?.noteProperties, currentDoc?.noteId, currentDoc?.id, patchAllDocKeys, vault],
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
