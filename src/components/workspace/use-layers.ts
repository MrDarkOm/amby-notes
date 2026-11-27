import { findDocumentDatabaseLayer } from "./database/document-database-layer"
import * as React from "react"
import i18n from "@/lib/i18n"
import { confirm } from "@/lib/confirm"
import { confirmations } from "@/lib/confirmations"
import { useViewStateStore, type EditorLayer } from "./use-view-state-store"
import { useDocStore, type Document } from "./use-doc-store"
import type { TreeItem } from "./sidebar-tree"
import type { FsMutationResult, LayerKind, LayerResult, NoteProperties } from "@/lib/storage"
import {
  createDatabase,
  createLayer,
  unlinkLayer,
  deleteLayer,
  noteLayers,
  readFile,
  readNote,
} from "@/lib/storage"
import { splitWebFrontmatter } from "@/lib/storage/web-frontmatter"
import { useDatabaseStore } from "./database/database-store"
import { findTreeItem, noteLayerPath, wsPathDir } from "./workspace-tree-utils"
import { beginLocalTreeMutation, recordLocalTreePaths } from "./watcher-tree-reconciliation"
import { mutationPaths } from "./workspace-mutations"
import { flushEditorSerializations } from "./tiptap/editor-serialization-lifecycle"

/** The files a layer command changed, for asking the backend to refresh exactly those. */
function layerTouchedPaths(result: LayerResult): string[] {
  return [
    ...new Set(
      [
        result.notePath,
        result.layerPath,
        ...result.pathChanges.flatMap((change) => [change.oldPath, change.newPath]),
      ].filter(Boolean),
    ),
  ]
}

function patchDocBuffer(fileId: string, path: string | undefined, patch: Partial<Document>) {
  useDocStore.getState().patchDoc(fileId, patch)
  if (path && path !== fileId) {
    useDocStore.getState().patchDoc(path, patch)
  }
}

/** The layer has no ID or revision from the backend: the text is shown, nothing is written. */
const LAYER_UNRESOLVED_PROPERTIES: NoteProperties = {
  hasFrontmatter: false,
  bodyReadOnly: true,
  properties: [],
  customProperties: [],
}

type LoadedNoteLayer = {
  content: string
  source: string
  noteId?: string
  revision?: string
  readOnly: boolean
}

/**
 * The note layer of a container. Its ID is the one the backend's tree gives to the file and its
 * revision the one `read_note` returns; a pattern over the text would find ordinary `id:`
 * properties and body lines, and a revision of our own is not one the backend accepts. When the
 * backend does not know the layer yet (or does not answer), the text is shown read only.
 */
export async function loadNoteLayerContent(
  layerPath: string,
  vault: string | undefined,
  treeItems: TreeItem[],
): Promise<LoadedNoteLayer> {
  const item = vault ? findLayerItem(treeItems, layerPath) : null
  if (vault && item) {
    try {
      const note = await readNote(vault, item.id)
      return {
        content: note.content,
        source: note.source,
        noteId: item.id,
        revision: note.revision,
        readOnly: false,
      }
    } catch {
      // The layer can exist briefly before the index sees it; it stays read only.
    }
  }
  const source = await readFile(layerPath)
  const split = splitWebFrontmatter(source)
  // Without a vault the browser adapter writes the file itself and needs no revision.
  return { content: split ? split.body : source, source, readOnly: Boolean(vault) }
}

export function findLayerItem(items: TreeItem[], path: string): TreeItem | null {
  for (const item of items) {
    const member = item.bundleMembers?.find((layer) => layer.type === "file" && layer.path === path)
    if (member) return member
    if (item.path === path && path.endsWith(".md")) return item
    const found = item.children ? findLayerItem(item.children, path) : null
    if (found) return found
  }
  return null
}

/** What a loaded layer changes in the open document. */
function layerPatch(fileId: string, loaded: LoadedNoteLayer): Partial<Document> {
  const wasUnresolved =
    useDocStore.getState().openDocs[fileId]?.noteProperties === LAYER_UNRESOLVED_PROPERTIES
  return {
    content: loaded.content,
    source: loaded.source,
    noteId: loaded.noteId,
    ...(loaded.revision ? { revision: loaded.revision } : {}),
    ...(loaded.readOnly
      ? { noteProperties: LAYER_UNRESOLVED_PROPERTIES }
      : wasUnresolved
        ? { noteProperties: undefined }
        : {}),
  }
}

interface UseLayersParams {
  vault: string | null
  /** Database module state controls database-specific entry points. */
  databasesEnabled: boolean
  supernotesEnabled?: boolean
  backendGeneration: number | null
  currentDoc: Document | null
  treeItems: TreeItem[]
  refreshTreePaths: (paths: string[]) => Promise<TreeItem[]>
  refreshDatabaseCatalog?: () => Promise<void>
  onOpenDatabase?: (databaseId: string, title: string, inNewTab?: boolean) => void
  applyMutationResult: (result: FsMutationResult) => boolean
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
  supernotesEnabled = true,
  backendGeneration,
  currentDoc,
  treeItems,
  refreshTreePaths,
  refreshDatabaseCatalog,
  onOpenDatabase,
  applyMutationResult,
}: UseLayersParams) {
  const t = i18n.t.bind(i18n)
  // The latest tree for the loads that run after an await.
  const treeItemsRef = React.useRef(treeItems)
  treeItemsRef.current = treeItems
  const activeLayers = useViewStateStore((s) => s.activeLayers)
  const linkedLayersByDoc = useViewStateStore((s) => s.linkedLayersByDoc)
  const databaseInvalidationSeq = useDatabaseStore((state) => state.invalidationSeq)
  const { setActiveLayer, setLinkedLayers } = useViewStateStore.getState()

  const refreshLinkedLayers = React.useCallback(
    async (docId: string, notePath: string, isCurrent: () => boolean = () => true) => {
      try {
        const layers = await noteLayers(notePath)
        if (isCurrent()) setLinkedLayers(docId, layers)
      } catch (err) {
        console.error("Failed to load note layers:", err)
        if (!isCurrent()) return
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
      const finishMutation = beginLocalTreeMutation()
      try {
        const created = await createDatabase({
          expectedGeneration: backendGeneration,
          mode: "attached",
          notePath,
          name: title.replace(/\.md$/iu, "") || title,
        })
        const nextNotePath = created.notePath ?? notePath
        applyDatabasePathChange(notePath, nextNotePath)
        await refreshTreePaths([notePath, nextNotePath, created.manifestPath])
        await refreshLinkedLayers(noteId, nextNotePath)
        setActiveLayer(noteId, "database")
        await refreshDatabaseCatalog?.()
      } finally {
        finishMutation()
      }
    },
    [
      applyDatabasePathChange,
      backendGeneration,
      databasesEnabled,
      refreshDatabaseCatalog,
      refreshLinkedLayers,
      refreshTreePaths,
      setActiveLayer,
      vault,
    ],
  )

  const handleLayerChange = async (layer: EditorLayer) => {
    flushEditorSerializations()
    const doc = currentDoc
    if (!doc) return
    if (layer === "database") {
      try {
        const findAttached = () =>
          findDocumentDatabaseLayer(
            useDatabaseStore.getState().databases,
            doc,
            findTreeItem(treeItemsRef.current, doc.noteId ?? doc.id) ??
              findTreeItem(treeItemsRef.current, doc.path),
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
        if (supernotesEnabled) await createAttachedDatabase(doc.id, doc.path, doc.title)
      } catch (err) {
        console.error("Failed to create database layer:", err)
      }
      return
    }
    if (layer === "editor") {
      if (linkedLayersByDoc[doc.id] && !linkedLayersByDoc[doc.id]?.note) {
        if (!supernotesEnabled) return
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
          // The tree the backend returns after the refresh holds the ID of the new layer; the
          // `treeItems` of this closure predate it.
          const freshTree = await refreshTreePaths(layerTouchedPaths(result))
          setActiveLayer(doc.id, "editor")
          await refreshLinkedLayers(doc.id, result.notePath ?? doc.path)
          if (databasesEnabled) await refreshDatabaseCatalog?.()
          if (result.layerPath) {
            try {
              const loaded = await loadNoteLayerContent(
                result.layerPath,
                vault ?? undefined,
                freshTree,
              )
              patchDocBuffer(doc.id, doc.path, layerPatch(doc.id, loaded))
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
          const loaded = await loadNoteLayerContent(
            notePath,
            vault ?? undefined,
            treeItemsRef.current,
          )
          patchDocBuffer(doc.id, doc.path, layerPatch(doc.id, loaded))
        } catch (e) {
          console.error("Failed to load existing note layer:", e)
        }
      }
      setActiveLayer(doc.id, "editor")
      return
    }
    try {
      // Switching an existing layer is a view change. Only missing layers need
      // filesystem mutations and a vault tree refresh.
      let linkedLayers = useViewStateStore.getState().linkedLayersByDoc[doc.id]
      if (!linkedLayers) {
        linkedLayers = await noteLayers(doc.path)
        setLinkedLayers(doc.id, linkedLayers)
      }
      if (linkedLayers[layer]) {
        setActiveLayer(doc.id, layer)
        return
      }
      if (!supernotesEnabled) return
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
      await refreshTreePaths(layerTouchedPaths(result))
      setActiveLayer(doc.id, layer)
      await refreshLinkedLayers(doc.id, result.notePath ?? doc.path)
    } catch (err) {
      console.error("Failed to create layer:", err)
    }
  }

  const handleAttachLayerToFile = React.useCallback(
    async (fileId: string, layer: "canvas" | "database" | "sketch" | "note") => {
      if (!supernotesEnabled) return
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
      const databaseId =
        item.type === "database"
          ? item.id
          : item.bundleMembers?.find((member) => member.type === "database")?.id
      const openDoc =
        currentDoc &&
        (currentDoc.id === fileId ||
          currentDoc.path === item.path ||
          (databaseId && currentDoc.id.replace(/^database:/u, "") === databaseId))
          ? currentDoc
          : null
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
        const freshTree = await refreshTreePaths(layerTouchedPaths(result))
        await refreshLinkedLayers(fileId, result.notePath ?? filePath)
        if (layer === "note" && result.layerPath) {
          const documentId = openDoc?.id ?? fileId
          if (documentId !== fileId) {
            await refreshLinkedLayers(documentId, result.notePath ?? filePath)
          }
          try {
            const loaded = await loadNoteLayerContent(
              result.layerPath,
              vault ?? undefined,
              freshTree,
            )
            patchDocBuffer(documentId, openDoc?.path ?? filePath, layerPatch(documentId, loaded))
            setActiveLayer(documentId, "editor")
          } catch (e) {
            console.error("Failed to read newly created note layer:", e)
          }
          if (databasesEnabled) await refreshDatabaseCatalog?.()
        }
      } catch (err) {
        console.error("Failed to attach layer:", err)
      }
    },
    [
      applyMutationResult,
      createAttachedDatabase,
      currentDoc,
      databasesEnabled,
      refreshDatabaseCatalog,
      refreshLinkedLayers,
      refreshTreePaths,
      setActiveLayer,
      supernotesEnabled,
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
      await refreshTreePaths([created.manifestPath])
      await refreshDatabaseCatalog?.()
      onOpenDatabase?.(created.databaseId, created.title)
    },
    [
      backendGeneration,
      databasesEnabled,
      onOpenDatabase,
      refreshDatabaseCatalog,
      refreshTreePaths,
      treeItems,
      vault,
    ],
  )

  const handleUnlinkLayer = async (layer: LayerKind) => {
    if (!currentDoc || !vault || !supernotesEnabled) return
    if (layer === "database") return
    try {
      const result = await unlinkLayer(vault, currentDoc.path, layer)
      if (!applyMutationResult(result)) await refreshTreePaths(mutationPaths(result))
      await refreshLinkedLayers(currentDoc.id, result.primaryPath ?? currentDoc.path)
      // If the unlinked layer was active, fall back to a remaining layer.
      if (activeLayers[currentDoc.id] === (layer === "note" ? "editor" : layer)) {
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
    if (!currentDoc || !vault || !supernotesEnabled) return
    if (layer === "database") return
    if (
      !(await confirm(
        confirmations.deleteLayer({ layer: t(`layer.${layer}`), title: currentDoc.title }),
      ))
    )
      return
    try {
      const result = await deleteLayer(vault, currentDoc.path, layer)
      if (!applyMutationResult(result)) await refreshTreePaths(mutationPaths(result))
      await refreshLinkedLayers(currentDoc.id, result.primaryPath ?? currentDoc.path)
      if (activeLayers[currentDoc.id] === (layer === "note" ? "editor" : layer)) {
        const remaining = await noteLayers(result.primaryPath ?? currentDoc.path)
        if (remaining.database) setActiveLayer(currentDoc.id, "database")
        else if (remaining.note) setActiveLayer(currentDoc.id, "editor")
        else if (remaining.canvas) setActiveLayer(currentDoc.id, "canvas")
        else if (remaining.sketch) setActiveLayer(currentDoc.id, "sketch")
        else setActiveLayer(currentDoc.id, "editor")
      }
      if (layer === "note" && databasesEnabled) await refreshDatabaseCatalog?.()
    } catch (err) {
      console.error("Failed to delete layer:", err)
    }
  }

  // A remote attachment arrives independently of the Markdown move. Refresh presence after
  // catalog invalidation as well as relocation, even when this document already has a cache.
  const presenceCheckedRef = React.useRef(false)
  const presenceDocId = currentDoc?.id
  const presenceDocPath = currentDoc?.path
  React.useEffect(() => {
    if (!presenceDocId || !presenceDocPath) return
    const firstCheck = !presenceCheckedRef.current
    presenceCheckedRef.current = true
    if (firstCheck && useViewStateStore.getState().linkedLayersByDoc[presenceDocId]) return
    let cancelled = false
    void refreshLinkedLayers(presenceDocId, presenceDocPath, () => !cancelled)
    return () => {
      cancelled = true
    }
  }, [
    presenceDocId,
    presenceDocPath,
    databaseInvalidationSeq,
    refreshLinkedLayers,
    vault,
    backendGeneration,
  ])

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
    let settled = false
    const docId = currentDoc.id
    const loadedLayers = loadedNoteLayersRef.current
    void (async () => {
      try {
        const notePath = noteLayerPath(currentDoc.path)
        const loaded = await loadNoteLayerContent(
          notePath,
          vault ?? undefined,
          treeItemsRef.current,
        )
        if (cancelled) return
        settled = true
        patchDocBuffer(currentDoc.id, currentDoc.path, layerPatch(currentDoc.id, loaded))
      } catch (err) {
        settled = true
        console.error("Failed to load active note layer:", err)
      }
    })()
    return () => {
      cancelled = true
      // A load dropped by a dependency change never delivered its content; let the rerun retry it.
      if (!settled) loadedLayers.delete(docId)
    }
    // patchDocBuffer is module-level; the doc is read through its id and path above.
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
