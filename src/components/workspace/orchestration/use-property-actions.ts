import * as React from "react"
import type { TFunction } from "i18next"
import { errorType, logger } from "@/lib/logger"
import { useNoteNoticesStore } from "../note-notices/use-note-notices-store"
import { usePropertyMigrationStore } from "../note-notices/use-property-migration-store"
import {
  changePropertyType,
  createProperty,
  deleteCustomProperty,
  deletePropertyByName,
  getNoteProperties,
  isTauri,
  renameProperty,
  reorderCustomProperties,
  reorderProperties,
  setPropertyAppearance,
  setPropertyIcon,
  setPropertyList,
  setPropertySettings,
  setPropertyValue,
  type CustomProperty,
  type NoteProperties,
  type TreeItem,
  upsertCustomProperty,
} from "@/lib/storage"
import { countFolderContents } from "../folder-view-utils"
import type { Tab } from "../use-tabs-store"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import {
  beginPropertyMutation,
  enqueueNotePropertyMutation,
  propertyVersion,
} from "../note-mutation-queue"
import { workspaceRelativePath } from "../vault/use-vault-session"
import type { AttachmentItem } from "../panel-registry"
import { isNotFoundError, operationErrorCode } from "@/lib/operation-errors"

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

/** The optimistic view of an upsert: the key of the header and the entry of the look. */
function applyUpsert(current: NoteProperties, next: CustomProperty): NoteProperties {
  const properties = [...current.properties]
  const previousName = current.customProperties.find((item) => item.id === next.id)?.name
  const frontIndex = properties.findIndex(
    (item) => item.key === previousName || item.key.toLowerCase() === next.name.toLowerCase(),
  )
  const front = {
    key: next.name,
    value: next.value,
    valueKind: ["number", "date", "checkbox"].includes(next.propertyType)
      ? next.propertyType
      : "text",
  }
  if (frontIndex >= 0) properties[frontIndex] = front
  else properties.push(front)
  const custom = [...current.customProperties]
  const index = custom.findIndex(
    (item) => item.id === next.id || item.name.toLowerCase() === next.name.toLowerCase(),
  )
  if (index >= 0) custom[index] = next
  else custom.push(next)
  return { ...current, hasFrontmatter: true, properties, customProperties: custom }
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

  const [failure, setFailure] = React.useState<{
    generation: number
    noteId: string
    /** The property was changed or removed on another computer (З65). */
    changedElsewhere?: boolean
  } | null>(null)
  const generation = useVaultStore((state) => state.generation)
  const noteId = currentDoc?.noteId ?? currentDoc?.id

  const scope = React.useCallback(() => {
    if (!vault || !currentDoc || !noteId) throw new Error("No active document")
    if (useVaultStore.getState().switching) {
      setFailure({ generation, noteId })
      throw new Error("Vault switch in progress")
    }
    const isCurrent = () =>
      useVaultStore.getState().generation === generation && useVaultStore.getState().vault === vault
    const matches = (doc: OpenDocument) =>
      doc.path === currentDoc.path || (doc.noteId ?? doc.id) === noteId
    const patch = (update: (properties: NoteProperties) => NoteProperties) => {
      if (!isCurrent()) return
      const store = useDocStore.getState()
      for (const [key, doc] of Object.entries(store.openDocs)) {
        if (matches(doc))
          store.patchDoc(key, {
            noteProperties: update(
              doc.noteProperties ?? { hasFrontmatter: false, properties: [], customProperties: [] },
            ),
          })
      }
    }
    const reload = async (version: number) => {
      if (!isCurrent()) return
      const properties = await getNoteProperties(vault, noteId)
      if (!isCurrent()) return
      // Metadata must never overwrite the body or its external-edit revision.
      if (propertyVersion(generation, noteId) === version) patch(() => properties)
    }
    const run = <T>(
      optimistic: (properties: NoteProperties) => NoteProperties,
      write: () => Promise<T>,
    ) => {
      const mutation = beginPropertyMutation(generation, noteId)
      setFailure(null)
      patch(optimistic)
      return enqueueNotePropertyMutation(generation, noteId, async () => {
        try {
          if (!isCurrent()) throw new Error("Vault changed")
          const store = useDocStore.getState()
          if (
            Object.entries(store.openDocs).some(
              ([key, doc]) => matches(doc) && store.externalConflicts[key],
            )
          )
            throw new Error("Note has unresolved external edits")
          const result = await write()
          useNoteNoticesStore.getState().setPropertyFailed(currentDoc.id, false)
          await reload(mutation.version)
          return result
        } catch (error) {
          logger.error("property.mutation_failed", {
            noteId,
            errorType: errorType(error),
            failureCode: operationErrorCode(error),
          })
          // The property the person edited is gone under its old name: another computer changed it.
          const changedElsewhere = isNotFoundError(error)
          useNoteNoticesStore.getState().setPropertyFailed(currentDoc.id, !changedElsewhere)
          if (isCurrent()) {
            setFailure({ generation, noteId, changedElsewhere })
            // The edit failed and `failure` is already set; the original error is thrown right
            // below. A failed re-read only leaves the old view.
            await reload(mutation.version).catch(() => {})
          }
          throw error
        } finally {
          mutation.finish()
        }
      })
    }
    return { patch, run }
  }, [currentDoc, generation, noteId, vault])

  const handleUpsertCustomProperty = React.useCallback(
    async (property: CustomProperty) => {
      const { run } = scope()
      const latest = currentDoc
        ? useDocStore.getState().openDocs[currentDoc.id]?.noteProperties
        : undefined
      const previous = latest?.customProperties.find(
        (item) =>
          item.id === property.id || item.name.toLowerCase() === property.name.trim().toLowerCase(),
      )
      const next = {
        ...property,
        name: property.name.trim(),
        id: property.id || previous?.id || crypto.randomUUID(),
      }
      const optimistic = (current: NoteProperties) => applyUpsert(current, next)
      return run(optimistic, async () => {
        const saved = await upsertCustomProperty(vault!, noteId!, next)
        logger.info("property.upsert", { noteId, propertyId: saved.id })
        return saved
      })
    },
    [currentDoc, noteId, scope, vault],
  )

  const handleCreateProperty = React.useCallback(
    async (property: CustomProperty) => {
      const { run } = scope()
      const next = { ...property, name: property.name.trim(), id: property.name.trim() }
      await run(
        (current) => applyUpsert(current, next),
        () => createProperty(vault!, noteId!, next),
      )
    },
    [noteId, scope, vault],
  )

  const handleSetPropertyIcon = React.useCallback(
    async (name: string, icon: string) => {
      const { run } = scope()
      await run(
        (current) => ({
          ...current,
          customProperties: current.customProperties.map((item) =>
            item.name === name ? { ...item, icon } : item,
          ),
        }),
        () => setPropertyIcon(vault!, noteId!, name, icon),
      )
    },
    [noteId, scope, vault],
  )

  const handleSetPropertySettings = React.useCallback(
    async (name: string, settings: string) => {
      const { run } = scope()
      await run(
        (current) => ({
          ...current,
          customProperties: current.customProperties.map((item) =>
            item.name === name ? { ...item, settings } : item,
          ),
        }),
        () => setPropertySettings(vault!, noteId!, name, settings),
      )
    },
    [noteId, scope, vault],
  )

  const handleSetPropertyAppearance = React.useCallback(
    async (name: string, icon: string, settings: string) => {
      const { run } = scope()
      await run(
        (current) => ({
          ...current,
          customProperties: current.customProperties.map((item) =>
            item.name === name ? { ...item, icon, settings } : item,
          ),
        }),
        () => setPropertyAppearance(vault!, noteId!, name, icon, settings),
      )
    },
    [noteId, scope, vault],
  )

  const handleSetPropertyList = React.useCallback(
    async (name: string, items: string[]) => {
      const { run } = scope()
      await run(
        (current) => ({
          ...current,
          properties: current.properties.map((item) =>
            item.key === name ? { ...item, items, value: items.join(", ") } : item,
          ),
        }),
        () => setPropertyList(vault!, noteId!, name, items),
      )
    },
    [noteId, scope, vault],
  )

  const handleChangePropertyType = React.useCallback(
    async (name: string, propertyType: string) => {
      const { run } = scope()
      await run(
        (current) => ({
          ...current,
          customProperties: current.customProperties.map((item) =>
            item.name === name ? { ...item, propertyType } : item,
          ),
        }),
        () => changePropertyType(vault!, noteId!, name, propertyType),
      )
    },
    [noteId, scope, vault],
  )

  const handleSetPropertyValue = React.useCallback(
    async (name: string, value: string) => {
      const { run } = scope()
      await run(
        (current) => ({
          ...current,
          properties: current.properties.map((item) =>
            item.key === name ? { ...item, value } : item,
          ),
          customProperties: current.customProperties.map((item) =>
            item.name === name ? { ...item, value } : item,
          ),
        }),
        () => setPropertyValue(vault!, noteId!, name, value),
      )
    },
    [noteId, scope, vault],
  )

  const handleRenameProperty = React.useCallback(
    async (name: string, newName: string) => {
      const { run } = scope()
      await run(
        (current) => ({
          ...current,
          properties: current.properties.map((item) =>
            item.key === name ? { ...item, key: newName } : item,
          ),
          customProperties: current.customProperties.map((item) =>
            item.name === name ? { ...item, name: newName } : item,
          ),
        }),
        async () => {
          await renameProperty(vault!, noteId!, name, newName)
          // The notice of the migration follows the property to its new name.
          usePropertyMigrationStore.getState().rename(noteId!, name, newName)
        },
      )
    },
    [noteId, scope, vault],
  )

  const handleDeleteCustomProperty = React.useCallback(
    async (propertyId: string) => {
      const { run } = scope()
      await run(
        (current) => {
          const target = current.customProperties.find(
            (item) =>
              item.id === propertyId || item.name.toLowerCase() === propertyId.toLowerCase(),
          )
          const name = (target?.name ?? propertyId).toLowerCase()
          return {
            ...current,
            properties: current.properties.filter((item) => item.key.toLowerCase() !== name),
            customProperties: current.customProperties.filter(
              (item) => item.id !== propertyId && item.name.toLowerCase() !== name,
            ),
          }
        },
        () =>
          isTauri()
            ? deletePropertyByName(vault!, noteId!, propertyId)
            : deleteCustomProperty(vault!, noteId!, propertyId),
      )
    },
    [noteId, scope, vault],
  )

  const handleReorderCustomProperties = React.useCallback(
    async (propertyIds: string[]) => {
      const { run } = scope()
      const current = currentDoc
        ? (useDocStore.getState().openDocs[currentDoc.id]?.noteProperties?.customProperties ?? [])
        : []
      const byId = new Map(current.map((property) => [property.id, property]))
      // The backend order contract includes all sidecar properties, including
      // metadata for fields rendered from frontmatter in another section.
      const completeIds = [
        ...new Set([...propertyIds, ...current.map((property) => property.id)]),
      ].filter((id) => byId.has(id))
      await run(
        (properties) => ({
          ...properties,
          customProperties: completeIds.map((id) => byId.get(id)!),
        }),
        () =>
          isTauri()
            ? reorderProperties(vault!, noteId!, completeIds)
            : reorderCustomProperties(vault!, noteId!, completeIds),
      )
    },
    [currentDoc, noteId, scope, vault],
  )

  return {
    currentProperties,
    propertyError:
      failure?.generation === generation && failure.noteId === noteId
        ? t(failure.changedElsewhere ? "infoPanel.changedElsewhere" : "infoPanel.saveFailed")
        : null,
    attachments,
    attachmentImages,
    handleUpsertCustomProperty,
    handleDeleteCustomProperty,
    handleReorderCustomProperties,
    handleSetPropertyAppearance,
    handleCreateProperty,
    handleSetPropertyIcon,
    handleSetPropertySettings,
    handleRenameProperty,
    handleChangePropertyType,
    handleSetPropertyValue,
    handleSetPropertyList,
  }
}
