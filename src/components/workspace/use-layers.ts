import * as React from "react"
import i18n from "@/lib/i18n"
import { useViewStateStore, type EditorLayer } from "./use-view-state-store"
import { useDocStore, type Document } from "./use-doc-store"
import type { TreeItem } from "./sidebar-tree"
import type { FsMutationResult, LayerKind } from "@/lib/storage"
import {
  confirmAction,
  createDatabase,
  createLayer,
  unlinkLayer,
  deleteLayer,
  noteLayers,
  readFile,
  readNote,
} from "@/lib/storage"
import { splitWebFrontmatter, webRevision } from "@/lib/storage/web-frontmatter"
import { useDatabaseStore } from "./database/database-store"
import { noteLayerPath, wsPathDir } from "./workspace-tree-utils"
import { recordLocalTreePaths } from "./watcher-tree-reconciliation"

function patchDocBuffer(fileId: string, path: string | undefined, patch: Partial<Document>) {
  useDocStore.getState().patchDoc(fileId, patch)
  if (path && path !== fileId) {
    useDocStore.getState().patchDoc(path, patch)
  }
}

export async function loadNoteLayerContent(
  layerPath: string,
  vault?: string,
): Promise<{ content: string; source: string; noteId?: string; revision?: string }> {
  const noteContent = await readFile(layerPath)
  const idMatch = noteContent.match(/^(?:amby-id|id):\s*([^\s]+)/m)
  const noteId = idMatch ? idMatch[1] : undefined
  let revision: string | undefined
  let content: string | undefined
  let source = noteContent

  if (noteId && vault) {
    try {
      const indexedNote = await readNote(vault, noteId)
      revision = indexedNote.revision
      content = indexedNote.content
      source = indexedNote.source
    } catch {
      // Fall back if SQLite indexer has not indexed yet
    }
  }

  if (content === undefined) {
    const split = splitWebFrontmatter(noteContent)
    content = split ? split.body : noteContent
    if (!revision) {
      revision = webRevision(content)
    }
  }

  return { content, source, noteId, revision }
}

interface UseLayersParams {
  vault: string | null
  /** Database module state controls database-specific entry points. */
  databasesEnabled: boolean
  backendGeneration: number | null
  currentDoc: Document | null
  treeItems: TreeItem[]
  refreshTree: (path?: string | null) => Promise<TreeItem[]>
  refreshDatabaseCatalog?: () => Promise<void>
  onOpenDatabase?: (databaseId: string, title: string, inNewTab?: boolean) => void
  applyMutationResult: (result: FsMutationResult) => void
}

/**
 * Layer lifecycle for the active document: create/attach/unlink/delete a
 * canvas/database/sketch layer, refresh the cached layer-presence map, and
 * lazily load it for the current document.
 *
 * Reads activeLayers + setActiveLayer/setLinkedLayers from useViewStateStore.
 */
export function useLayers({
  vault,
  databasesEnabled,
  backendGeneration,
  currentDoc,
  treeItems,
  refreshTree,
  refreshDatabaseCatalog,
  onOpenDatabase,
  applyMutationResult,
}: UseLayersParams) {
  const t = i18n.t.bind(i18n)
  const activeLayers = useViewStateStore((s) => s.activeLayers)
  const linkedLayersByDoc = useViewStateStore((s) => s.linkedLayersByDoc)
  const { setActiveLayer, setLinkedLayers } = useViewStateStore.getState()

  const refreshLinkedLayers = React.useCallback(
    async (docId: string, notePath: string) => {
      try {
        const layers = await noteLayers(notePath)
        setLinkedLayers(docId, layers)
      } catch (err) {
        console.error("Failed to load note layers:", err)
        setLinkedLayers(docId, {
          note: notePath.endsWith(".md"),
          canvas: false,
          sketch: false,
          database: false,
        })
      }
    },
    [setLinkedLayers],
  )

  const applyDatabasePathChange = React.useCallback(
    (oldPath: string, newPath: string) => {
      if (oldPath === newPath) return
      applyMutationResult({
        primaryPath: newPath,
        pathChanges: [{ oldPath, newPath }],
        deletedPaths: [],
      })
    },
    [applyMutationResult],
  )

  const createAttachedDatabase = React.useCallback(
    async (noteId: string, notePath: string, title: string) => {
      if (!vault || !databasesEnabled || backendGeneration === null) return
      const created = await createDatabase({
        expectedGeneration: backendGeneration,
        mode: "attached",
        notePath,
        name: title.replace(/\.md$/iu, "") || title,
      })
      const nextNotePath = created.notePath ?? notePath
      applyDatabasePathChange(notePath, nextNotePath)
      await refreshTree()
      await refreshDatabaseCatalog?.()
      await refreshLinkedLayers(noteId, nextNotePath)
      setActiveLayer(noteId, "database")
    },
    [
      applyDatabasePathChange,
      backendGeneration,
      databasesEnabled,
      refreshDatabaseCatalog,
      refreshLinkedLayers,
      refreshTree,
      setActiveLayer,
      vault,
    ],
  )

  const handleLayerChange = async (layer: EditorLayer) => {
    const doc = currentDoc
    if (!doc) return
    if (layer === "database") {
      try {
        const findAttached = () =>
          useDatabaseStore
            .getState()
            .databases.find(
              (database) => database.attachedNoteId === doc.id || database.databaseId === doc.id,
            )
        if (findAttached()) {
          setActiveLayer(doc.id, "database")
          return
        }
        if (linkedLayersByDoc[doc.id]?.database) {
          await refreshDatabaseCatalog?.()
          if (findAttached()) {
            setActiveLayer(doc.id, "database")
            return
          }
        }
        await createAttachedDatabase(doc.id, doc.path, doc.title)
      } catch (err) {
        console.error("Failed to create database layer:", err)
      }
      return
    }
    if (layer === "editor") {
      if (linkedLayersByDoc[doc.id] && !linkedLayersByDoc[doc.id]?.note) {
        try {
          const result = await createLayer(doc.path, "note")
          recordLocalTreePaths([
            result.notePath,
            result.layerPath,
            ...result.pathChanges.flatMap((c) => [c.oldPath, c.newPath]),
          ])
          applyMutationResult({
            primaryPath: result.notePath,
            pathChanges: result.pathChanges,
            deletedPaths: [],
          })
          await refreshTree()
          setActiveLayer(doc.id, "editor")
          await refreshLinkedLayers(doc.id, result.notePath ?? doc.path)
          if (result.layerPath) {
            try {
              const loaded = await loadNoteLayerContent(result.layerPath, vault ?? undefined)
              patchDocBuffer(doc.id, doc.path, {
                content: loaded.content,
                source: loaded.source,
                noteId: loaded.noteId,
                ...(loaded.revision ? { revision: loaded.revision } : {}),
              })
            } catch (e) {
              console.error("Failed to read newly created note layer:", e)
            }
          }
        } catch (err) {
          console.error("Failed to create note layer:", err)
        }
        return
      }
      const current = useDocStore.getState().openDocs[doc.id]
      if (
        current &&
        (!current.noteId ||
          current.content === current.source ||
          current.content.includes("amby-id:")) &&
        linkedLayersByDoc[doc.id]?.note
      ) {
        try {
          const notePath = noteLayerPath(current.path)
          const loaded = await loadNoteLayerContent(notePath, vault ?? undefined)
          patchDocBuffer(doc.id, doc.path, {
            content: loaded.content,
            source: loaded.source,
            noteId: loaded.noteId,
            ...(loaded.revision ? { revision: loaded.revision } : {}),
          })
        } catch (e) {
          console.error("Failed to load existing note layer:", e)
        }
      }
      setActiveLayer(doc.id, "editor")
      return
    }
    try {
      const result = await createLayer(doc.path, layer)
      recordLocalTreePaths([
        result.notePath,
        result.layerPath,
        ...result.pathChanges.flatMap((c) => [c.oldPath, c.newPath]),
      ])
      applyMutationResult({
        primaryPath: result.notePath,
        pathChanges: result.pathChanges,
        deletedPaths: [],
      })
      await refreshTree()
      setActiveLayer(doc.id, layer)
      await refreshLinkedLayers(doc.id, result.notePath ?? doc.path)
    } catch (err) {
      console.error("Failed to create layer:", err)
    }
  }

  const handleAttachLayerToFile = React.useCallback(
    async (fileId: string, layer: "canvas" | "database" | "sketch" | "note") => {
      function findFile(items: TreeItem[]): TreeItem | null {
        for (const item of items) {
          if (item.id === fileId && item.type !== "folder") return item
          if (item.children) {
            const found = findFile(item.children)
            if (found) return found
          }
        }
        return null
      }
      const item = findFile(treeItems)
      if (!item) return
      try {
        if (layer === "database") {
          await createAttachedDatabase(fileId, item.path, item.name)
          return
        }
        const filePath = item.path
        const result = await createLayer(filePath, layer)
        recordLocalTreePaths([
          result.notePath,
          result.layerPath,
          ...result.pathChanges.flatMap((c) => [c.oldPath, c.newPath]),
        ])
        applyMutationResult({
          primaryPath: result.notePath,
          pathChanges: result.pathChanges,
          deletedPaths: [],
        })
        await refreshTree()
        await refreshLinkedLayers(fileId, result.notePath ?? filePath)
        if (layer === "note" && result.layerPath) {
          try {
            const loaded = await loadNoteLayerContent(result.layerPath, vault ?? undefined)
            patchDocBuffer(fileId, item.path, {
              content: loaded.content,
              source: loaded.source,
              noteId: loaded.noteId,
              ...(loaded.revision ? { revision: loaded.revision } : {}),
            })
          } catch (e) {
            console.error("Failed to read newly created note layer:", e)
          }
        }
      } catch (err) {
        console.error("Failed to attach layer:", err)
      }
    },
    [
      applyMutationResult,
      createAttachedDatabase,
      refreshLinkedLayers,
      refreshTree,
      treeItems,
      vault,
    ],
  )

  const handleNewDatabase = React.useCallback(
    async (parentId: string | null, name: string) => {
      if (!vault || !databasesEnabled || backendGeneration === null) return
      const parent = parentId ? findFileOrFolder(treeItems, parentId) : null
      let parentPath = vault
      if (parent) {
        if (parent.type === "folder" || parent.type === "database") {
          parentPath = parent.path
        } else {
          parentPath = wsPathDir(parent.path) || vault
        }
      }
      const created = await createDatabase({
        expectedGeneration: backendGeneration,
        mode: "standalone",
        parentPath,
        name,
      })
      await refreshTree()
      await refreshDatabaseCatalog?.()
      onOpenDatabase?.(created.databaseId, created.title)
    },
    [
      backendGeneration,
      databasesEnabled,
      onOpenDatabase,
      refreshDatabaseCatalog,
      refreshTree,
      treeItems,
      vault,
    ],
  )

  const handleUnlinkLayer = async (layer: LayerKind) => {
    if (!currentDoc || !vault) return
    if (layer === "database") return
    try {
      const result = await unlinkLayer(vault, currentDoc.path, layer)
      applyMutationResult(result)
      await refreshTree()
      await refreshLinkedLayers(currentDoc.id, result.primaryPath ?? currentDoc.path)
      // If the unlinked layer was active, fall back to a remaining layer.
      if (activeLayers[currentDoc.id] === layer) {
        const remaining = await noteLayers(result.primaryPath ?? currentDoc.path)
        if (remaining.database) setActiveLayer(currentDoc.id, "database")
        else if (remaining.note) setActiveLayer(currentDoc.id, "editor")
        else if (remaining.canvas) setActiveLayer(currentDoc.id, "canvas")
        else if (remaining.sketch) setActiveLayer(currentDoc.id, "sketch")
        else setActiveLayer(currentDoc.id, "editor")
      }
    } catch (err) {
      console.error("Failed to unlink layer:", err)
    }
  }

  const handleDeleteLayer = async (layer: LayerKind) => {
    if (!currentDoc || !vault) return
    if (layer === "database") return
    if (
      !(await confirmAction(
        t("workspace.deleteLayerConfirm", { layer: t(`layer.${layer}`), title: currentDoc.title }),
      ))
    )
      return
    try {
      const result = await deleteLayer(vault, currentDoc.path, layer)
      applyMutationResult(result)
      await refreshTree()
      await refreshLinkedLayers(currentDoc.id, result.primaryPath ?? currentDoc.path)
      if (activeLayers[currentDoc.id] === layer) {
        const remaining = await noteLayers(result.primaryPath ?? currentDoc.path)
        if (remaining.database) setActiveLayer(currentDoc.id, "database")
        else if (remaining.note) setActiveLayer(currentDoc.id, "editor")
        else if (remaining.canvas) setActiveLayer(currentDoc.id, "canvas")
        else if (remaining.sketch) setActiveLayer(currentDoc.id, "sketch")
        else setActiveLayer(currentDoc.id, "editor")
      }
    } catch (err) {
      console.error("Failed to delete layer:", err)
    }
  }

  // Load the cached layer-presence map for a document the first time it opens.
  const requestedLayersRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    if (!currentDoc) return
    if (linkedLayersByDoc[currentDoc.id] || requestedLayersRef.current.has(currentDoc.id)) return
    requestedLayersRef.current.add(currentDoc.id)
    void refreshLinkedLayers(currentDoc.id, currentDoc.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDoc?.id, currentDoc?.path, linkedLayersByDoc])

  React.useEffect(() => {
    if (!currentDoc || databasesEnabled) return
    if (activeLayers[currentDoc.id] === "database") setActiveLayer(currentDoc.id, "editor")
  }, [activeLayers, currentDoc, databasesEnabled, setActiveLayer])

  // For container docs (like databases), lazily load the attached note layer once when editor layer is active.
  const loadedNoteLayersRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    if (!currentDoc || currentDoc.path.endsWith(".md")) return
    const isEditorActive = activeLayers[currentDoc.id] === "editor"
    if (!isEditorActive) return
    const hasNoteLayer = linkedLayersByDoc[currentDoc.id]?.note
    if (!hasNoteLayer) return
    if (loadedNoteLayersRef.current.has(currentDoc.id)) return
    loadedNoteLayersRef.current.add(currentDoc.id)
    let cancelled = false
    void (async () => {
      try {
        const notePath = noteLayerPath(currentDoc.path)
        const loaded = await loadNoteLayerContent(notePath, vault ?? undefined)
        if (cancelled) return
        patchDocBuffer(currentDoc.id, currentDoc.path, {
          content: loaded.content,
          source: loaded.source,
          noteId: loaded.noteId,
          ...(loaded.revision ? { revision: loaded.revision } : {}),
        })
      } catch (err) {
        console.error("Failed to load active note layer:", err)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLayers, currentDoc?.id, currentDoc?.path, linkedLayersByDoc, vault])

  return {
    refreshLinkedLayers,
    handleLayerChange,
    handleAttachLayerToFile,
    handleUnlinkLayer,
    handleDeleteLayer,
    handleNewDatabase,
  }
}

function findFileOrFolder(items: TreeItem[], id: string): TreeItem | null {
  for (const item of items) {
    if (item.id === id) return item
    if (item.children) {
      const found = findFileOrFolder(item.children, id)
      if (found) return found
    }
  }
  return null
}
