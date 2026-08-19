import * as React from "react"
import i18n from "@/lib/i18n"
import { errorType, logger } from "@/lib/logger"
import {
  discardRecoveryDraft,
  readRecoveryDraft,
  remapRecoveryDraft,
  saveRecoveryDraft,
} from "@/lib/recovery-drafts"
import { AutosaveCoordinator, type AutosaveKey } from "./autosave/autosave-coordinator"
import { registerAutosaveLifecycle } from "./autosave/autosave-lifecycle"
import {
  AUTOSAVE_CONFLICT_RESOLVED_EVENT,
  type AutosaveConflictResolution,
} from "./autosave/conflict-events"
import { useDocStore, type Document } from "./use-doc-store"
import { useTabsStore } from "./use-tabs-store"
import { useViewStateStore } from "./use-view-state-store"
import { useSettingsStore } from "./use-settings-store"
import { loadWorkspaceConfig, saveWorkspaceConfigPatch } from "./app-config"
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog"
import { normalizeWikiLinkTarget, findWikiLinkItem } from "./wiki-links"
import { planMutation } from "./workspace-mutations"
import {
  findTreeItem,
  updateInTree,
  formatModified,
  newTabKey,
  wsPathStem,
} from "./workspace-tree-utils"
import type { TreeItem } from "./sidebar-tree"
import type { FsMutationResult } from "@/lib/storage"
import {
  readFile,
  readNote,
  writeFile,
  writeNote,
  getNoteMetadata,
  getNoteProperties,
  createNote,
  createFolder,
  createCanvasFile,
  attachCanvasToNote,
  renameItem,
  previewRenameRefactor,
  deleteItem,
  moveItem,
  previewMoveRefactor,
  confirmAction,
} from "@/lib/storage"

interface UseFileActionsParams {
  vault: string | null
  treeItems: TreeItem[]
  setTreeItems: React.Dispatch<React.SetStateAction<TreeItem[]>>
  refreshTree: (path?: string | null) => Promise<TreeItem[]>
  applyMutationResult: (result: FsMutationResult) => void
  openCanvasTab: (path: string, title: string) => void
  setOpenCanvases: React.Dispatch<React.SetStateAction<Record<string, string>>>
  setPendingRenameId: React.Dispatch<React.SetStateAction<string | null>>
  autosaveGeneration: number
  backendGeneration: number | null
}

interface MarkdownAutosavePayload {
  fileId: string
  path: string
  content: string
  backendGeneration: number | null
}

class AutosaveConflictPausedError extends Error {}

/**
 * File/folder/canvas CRUD + navigation handlers, all of which share the shape
 *   findTreeItem(treeItems,…) → storage call → applyMutationResult → refreshTree.
 *
 * Owns no state of its own: it reads the doc/tabs/view/settings stores via
 * getState() and receives the tree + cross-cutting callbacks (applyMutationResult,
 * openCanvasTab, setOpenCanvases, and setPendingRenameId) from Workspace.
 */
export function useFileActions({
  vault,
  treeItems,
  setTreeItems,
  refreshTree,
  applyMutationResult,
  openCanvasTab,
  setOpenCanvases,
  setPendingRenameId,
  autosaveGeneration,
  backendGeneration,
}: UseFileActionsParams) {
  const t = i18n.t.bind(i18n)
  const vaultRef = React.useRef(vault)
  vaultRef.current = vault
  const generationRef = React.useRef(autosaveGeneration)
  const autosaveRef = React.useRef<AutosaveCoordinator<MarkdownAutosavePayload> | null>(null)
  if (generationRef.current !== autosaveGeneration) {
    autosaveRef.current?.cancelGeneration(generationRef.current)
    generationRef.current = autosaveGeneration
  }
  if (!autosaveRef.current) {
    autosaveRef.current = new AutosaveCoordinator<MarkdownAutosavePayload>({
      delayMs: useSettingsStore.getState().prefs.editor.autosaveMs,
      save: async (snapshot) => {
        if (snapshot.key.generation !== generationRef.current) return
        if (useDocStore.getState().externalConflicts[snapshot.value.fileId]) {
          autosaveRef.current?.pause(snapshot.key)
          throw new AutosaveConflictPausedError()
        }
        const activeVault = vaultRef.current
        if (activeVault) {
          await writeNote(
            activeVault,
            snapshot.value.fileId,
            snapshot.value.content,
            snapshot.value.backendGeneration,
          )
        } else {
          await writeFile(snapshot.value.path, snapshot.value.content)
        }
      },
      onSaveSuccess: (snapshot) => {
        if (snapshot.key.generation !== generationRef.current) return
        const current = useDocStore.getState().openDocs[snapshot.value.fileId]
        if (
          !current ||
          current.content !== snapshot.value.content ||
          useDocStore.getState().externalConflicts[snapshot.value.fileId]
        )
          return
        void discardRecoveryDraft(current.path)
        markSaved(snapshot.value.fileId)
      },
      onSaveFailure: (snapshot, error) => {
        if (snapshot.key.generation !== generationRef.current) return
        if (error instanceof AutosaveConflictPausedError) return
        logger.error("autosave.failed", { errorType: errorType(error) })
      },
    })
  }
  const autosave = autosaveRef.current
  const autosaveKey = React.useCallback(
    (fileId: string): AutosaveKey => ({
      generation: autosaveGeneration,
      kind: "markdown",
      documentId: fileId,
    }),
    [autosaveGeneration],
  )
  React.useEffect(
    () =>
      registerAutosaveLifecycle({
        generation: autosaveGeneration,
        flush: () => autosave.flushAll(),
        cancel: () => autosave.cancelGeneration(autosaveGeneration),
        hasDirtyBuffers: () =>
          autosave
            .inspectAll()
            .some((state) => state.key.generation === autosaveGeneration && state.dirty),
      }),
    [autosave, autosaveGeneration],
  )
  const externalConflicts = useDocStore((s) => s.externalConflicts)
  React.useEffect(() => {
    for (const fileId of Object.keys(externalConflicts)) autosave.pause(autosaveKey(fileId))
  }, [autosave, autosaveKey, externalConflicts])
  React.useEffect(() => {
    const onConflictResolved = (event: Event) => {
      const detail = (
        event as CustomEvent<{ fileId: string; resolution: AutosaveConflictResolution }>
      ).detail
      if (!detail) return
      const key = autosaveKey(detail.fileId)
      if (detail.resolution === "discard") {
        autosave.discard(key)
        return
      }
      const document = useDocStore.getState().openDocs[detail.fileId]
      if (!document) return
      autosave.resume(key)
      autosave.enqueueImmediate(key, {
        fileId: detail.fileId,
        path: document.path,
        content: document.content,
        backendGeneration,
      })
    }
    window.addEventListener(AUTOSAVE_CONFLICT_RESOLVED_EVENT, onConflictResolved)
    return () => window.removeEventListener(AUTOSAVE_CONFLICT_RESOLVED_EVENT, onConflictResolved)
  }, [autosave, autosaveKey, backendGeneration])

  type DeleteResolution = "confirm" | "keep_recovery" | "discard" | "cancel"

  const [pendingDelete, setPendingDelete] = React.useState<{
    id: string
    name: string
    isDirtyOrConflicted: boolean
    resolve: (action: DeleteResolution, dontAskAgain?: boolean) => void
  } | null>(null)

  async function requestDeleteConfirmation(
    id: string,
    name: string,
    isDirtyOrConflicted: boolean,
  ): Promise<DeleteResolution> {
    if (isDirtyOrConflicted) {
      return new Promise((resolve) =>
        setPendingDelete({ id, name, isDirtyOrConflicted: true, resolve }),
      )
    }
    const { confirmations } = await loadWorkspaceConfig()
    if (!confirmations.confirmFileDelete) return "confirm"
    return new Promise((resolve) =>
      setPendingDelete({ id, name, isDirtyOrConflicted: false, resolve }),
    )
  }

  function settleDeleteConfirmation(action: DeleteResolution, dontAskAgain = false) {
    if (!pendingDelete) return
    if (dontAskAgain) {
      void saveWorkspaceConfigPatch({ confirmations: { confirmFileDelete: false } })
    }
    pendingDelete.resolve(action)
    setPendingDelete(null)
  }

  const handleApplyMutation = React.useCallback(
    (result: FsMutationResult) => {
      const { deletedIds, remapFn } = planMutation(result)
      for (const id of deletedIds) {
        autosave.discard(autosaveKey(id))
      }
      const openDocs = useDocStore.getState().openDocs
      for (const [id, doc] of Object.entries(openDocs)) {
        if (deletedIds.includes(id)) continue
        const nextPath = remapFn(doc.path)
        if (nextPath !== doc.path) {
          autosave.remapKey(autosaveKey(id), autosaveKey(id), (payload) => ({
            ...payload,
            path: nextPath,
          }))
          void remapRecoveryDraft(id, id, "markdown", nextPath)
          void remapRecoveryDraft(doc.path, nextPath, "markdown", nextPath)
        }
      }
      applyMutationResult(result)
    },
    [applyMutationResult, autosave, autosaveKey],
  )

  const tabs = useTabsStore((s) => s.tabs)
  const activeTabKey = useTabsStore((s) => s.activeTabKey)
  const { setTabs, setActiveTabKey } = useTabsStore.getState()
  const { setDoc, patchDoc, markUnsaved, markSaved } = useDocStore.getState()
  const { setActiveLayer } = useViewStateStore.getState()

  // ── Document loading ──────────────────────────────────────────────────────────

  async function loadDoc(fileId: string, itemName: string): Promise<Document> {
    // Read via getState() so this function doesn't close over the openDocs value.
    if (useDocStore.getState().openDocs[fileId]) return useDocStore.getState().openDocs[fileId]
    const item = findTreeItem(treeItems, fileId)
    const [content, meta, noteProperties] = vault
      ? await Promise.all([
          readNote(vault, fileId),
          getNoteMetadata(vault, fileId),
          getNoteProperties(vault, fileId),
        ])
      : await Promise.all([
          readFile(item?.path ?? fileId),
          getNoteMetadata("", fileId),
          getNoteProperties("", fileId),
        ])
    const path = item?.path ?? fileId
    const recovered = (await readRecoveryDraft(fileId)) ?? (await readRecoveryDraft(path))
    const shouldRecover =
      recovered && recovered.content !== content
        ? await confirmAction(t("recovery.restorePrompt"))
        : false
    const doc: Document = {
      id: fileId,
      title: itemName,
      content: shouldRecover ? recovered!.content : content,
      created: formatModified(meta.created),
      modified: formatModified(meta.modified),
      wordCount: meta.word_count,
      path,
      noteProperties,
    }
    setDoc(fileId, doc)
    if (shouldRecover) {
      markUnsaved(fileId)
    } else if (recovered) {
      void discardRecoveryDraft(fileId)
      void discardRecoveryDraft(path)
    }
    return doc
  }

  const handleSelect = React.useCallback(
    async (fileId: string) => {
      const item = findTreeItem(treeItems, fileId)
      if (item?.type === "folder") {
        const active = tabs.find((tab) => tab.key === activeTabKey)
        if (active?.kind === "folder") {
          setTabs((prev) =>
            prev.map((tab) =>
              tab.key === activeTabKey
                ? {
                    ...tab,
                    fileId,
                    title: item.name,
                    history: [...tab.history.slice(0, tab.historyIndex + 1), fileId],
                    historyIndex: tab.historyIndex + 1,
                  }
                : tab,
            ),
          )
        } else {
          const existing = tabs.find((tab) => tab.kind === "folder" && tab.fileId === fileId)
          if (existing) {
            setActiveTabKey(existing.key)
          } else {
            const key = newTabKey()
            setTabs((prev) => [
              ...prev,
              {
                key,
                kind: "folder",
                fileId,
                title: item.name,
                history: [fileId],
                historyIndex: 0,
              },
            ])
            setActiveTabKey(key)
          }
        }
        return
      }
      if (item && item.type === "canvas") {
        openCanvasTab(item.path, item.name)
        return
      }
      if (!item || item.type !== "file") return

      try {
        await loadDoc(fileId, item.name)
      } catch (err) {
        console.error("Failed to load file:", err)
        return
      }

      const active = tabs.find((tb) => tb.key === activeTabKey)
      // If active tab is graph, don't overwrite — open a fresh document tab instead.
      if (active && active.kind === "document") {
        setTabs((prev) =>
          prev.map((tb) => {
            if (tb.key !== activeTabKey) return tb
            const newHistory = [...tb.history.slice(0, tb.historyIndex + 1), fileId]
            return {
              ...tb,
              fileId,
              title: item.name,
              history: newHistory,
              historyIndex: newHistory.length - 1,
            }
          }),
        )
      } else {
        const key = newTabKey()
        setTabs((prev) => [
          ...prev,
          { key, kind: "document", fileId, title: item.name, history: [fileId], historyIndex: 0 },
        ])
        setActiveTabKey(key)
      }
      // loadDoc uses getState() internally — safe to exclude openDocs from deps.
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [treeItems, tabs, activeTabKey],
  )

  const handleOpenInNewTab = React.useCallback(
    async (fileId: string) => {
      const item = findTreeItem(treeItems, fileId)
      if (item?.type === "folder") {
        const key = newTabKey()
        setTabs((prev) => [
          ...prev,
          {
            key,
            kind: "folder",
            fileId,
            title: item.name,
            history: [fileId],
            historyIndex: 0,
          },
        ])
        setActiveTabKey(key)
        return
      }
      if (item && item.type === "canvas") {
        openCanvasTab(item.path, item.name)
        return
      }
      if (!item || item.type !== "file") return

      try {
        await loadDoc(fileId, item.name)
      } catch (err) {
        console.error("Failed to load file:", err)
        return
      }

      const key = newTabKey()
      setTabs((prev) => [
        ...prev,
        { key, kind: "document", fileId, title: item.name, history: [fileId], historyIndex: 0 },
      ])
      setActiveTabKey(key)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [treeItems],
  )

  const handleCloneFile = React.useCallback(
    async (fileId: string) => {
      if (!vault) return
      const item = findTreeItem(treeItems, fileId)
      if (!item || item.type !== "file") return

      try {
        const content = await readNote(vault, fileId)
        const normalizedPath = item.path.replace(/\\/gu, "/")
        const slash = normalizedPath.lastIndexOf("/")
        const parentPath = slash >= 0 ? normalizedPath.slice(0, slash) : vault
        const cloneName = t("tree.cloneName", { name: item.name })
        const result = await createNote(vault, parentPath, cloneName)
        const id = result.primaryId ?? result.primaryPath
        if (!id) return

        // writeNote preserves the fresh clone's generated frontmatter envelope,
        // so an Amby ID from the source note is never duplicated.
        await writeNote(vault, id, content, backendGeneration)
        handleApplyMutation(result)
        await refreshTree()
        setDoc(id, {
          id,
          title: cloneName,
          content,
          created: t("time.justNow"),
          modified: t("time.justNow"),
          wordCount: content.trim() ? content.trim().split(/\s+/u).length : 0,
          path: result.primaryPath ?? id,
        })
        const key = newTabKey()
        setTabs((prev) => [
          ...prev,
          { key, kind: "document", fileId: id, title: cloneName, history: [id], historyIndex: 0 },
        ])
        setActiveTabKey(key)
        setPendingRenameId(id)
        setTimeout(() => setPendingRenameId(null), 500)
      } catch (err) {
        console.error("Failed to clone file:", err)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vault, treeItems],
  )

  async function navigateToFile(fileId: string) {
    const item = findTreeItem(treeItems, fileId)
    if (!item) return
    try {
      await loadDoc(fileId, item.name)
    } catch {
      /* ok */
    }
  }

  // ── Wiki links + anchor scrolling ─────────────────────────────────────────────

  /**
   * Scroll the active Tiptap editor to the element matching `anchor`.
   *
   * `#Heading text` — first heading whose text matches (case-insensitive).
   * `^block-id`     — paragraph ending with ` ^block-id`.
   * null            — no-op.
   */
  function scrollEditorToAnchor(anchor: string | null) {
    if (!anchor) return
    // Give the editor 250 ms to paint the new content before scrolling.
    setTimeout(() => {
      const source = document.querySelector<HTMLElement>(".amby-source-editor")
      if (source) {
        source.dispatchEvent(new CustomEvent("amby:navigate-markdown-anchor", { detail: anchor }))
        return
      }

      const prose = document.querySelector<HTMLElement>(
        ".obsidian-reading-view, .amby-tiptap-prose",
      )
      if (!prose) return

      if (anchor.startsWith("#")) {
        const headingText = anchor.slice(1).trim().toLowerCase()
        const headings = prose.querySelectorAll("h1, h2, h3, h4, h5, h6")
        for (const h of Array.from(headings)) {
          if (h.textContent?.trim().toLowerCase() === headingText) {
            h.scrollIntoView({ behavior: "smooth", block: "start" })
            return
          }
        }
      } else if (anchor.startsWith("^")) {
        const blockId = anchor.slice(1).toLowerCase()
        const indexedBlocks = prose.querySelectorAll<HTMLElement>("[data-block-id]")
        for (const block of Array.from(indexedBlocks)) {
          if (block.dataset.blockId?.toLowerCase() === blockId) {
            block.scrollIntoView({ behavior: "smooth", block: "start" })
            return
          }
        }
        // Obsidian appends ` ^block-id` at the very end of a paragraph's text.
        const blocks = prose.querySelectorAll("p, li, blockquote")
        for (const el of Array.from(blocks)) {
          if (el.textContent?.trimEnd().toLowerCase().endsWith(` ^${blockId}`)) {
            el.scrollIntoView({ behavior: "smooth", block: "start" })
            return
          }
        }
      }
    }, 250)
  }

  const handleWikiLinkClick = async (rawLink: string) => {
    if (!vault) return
    // rawLink = full inner content of [[ ]], e.g. "Note#Heading|Alias"
    const target = normalizeWikiLinkTarget(rawLink)
    if (!target) return

    // Extract the in-note anchor (#heading or ^block-id) for scroll-on-open.
    const [targetPart] = rawLink.split("|")
    const clean = (targetPart ?? rawLink).trim()
    const hashIdx = clean.indexOf("#")
    const caretIdx = clean.indexOf("^")
    const anchorStart =
      hashIdx !== -1 && caretIdx !== -1
        ? Math.min(hashIdx, caretIdx)
        : hashIdx !== -1
          ? hashIdx
          : caretIdx !== -1
            ? caretIdx
            : -1
    const anchor: string | null = anchorStart !== -1 ? clean.slice(anchorStart) : null

    const existing = findWikiLinkItem(treeItems, target, vault)
    if (existing) {
      await handleSelect(existing.id)
      scrollEditorToAnchor(anchor)
      return
    }

    try {
      const result = await createNote(vault, vault, target.split("/").pop() ?? target)
      handleApplyMutation(result)
      await refreshTree()
      const id = result.primaryId ?? result.primaryPath
      if (!id) return
      const name = target.split("/").pop() ?? target
      const doc: Document = {
        id,
        title: name,
        content: "",
        created: t("time.justNow"),
        modified: t("time.justNow"),
        wordCount: 0,
        path: result.primaryPath ?? id,
      }
      setDoc(id, doc)
      const key = newTabKey()
      setTabs((prev) => [
        ...prev,
        { key, kind: "document", fileId: id, title: name, history: [id], historyIndex: 0 },
      ])
      setActiveTabKey(key)
      // New note has no anchors — no scroll needed.
    } catch (err) {
      console.error("Failed to open wiki link:", err)
    }
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────────

  const handleRenameFile = React.useCallback(
    async (id: string, newName: string) => {
      const item = findTreeItem(treeItems, id)
      if (!item) return
      try {
        const path = item.path ?? id
        const preview = await previewRenameRefactor(vault ?? "", path, newName)
        if (
          preview.replacements > 0 &&
          !(await confirmAction(
            t("workspace.renameRefactorConfirm", {
              replacements: preview.replacements,
              notes: preview.notes,
            }),
          ))
        )
          return
        const result = await renameItem(vault ?? "", path, newName)
        handleApplyMutation(result)
        const newPath = result.primaryPath ?? item.path ?? id
        patchDoc(id, { title: newName, path: newPath })
        setTabs((prev) => prev.map((tb) => (tb.fileId === id ? { ...tb, title: newName } : tb)))
        await refreshTree()
      } catch (err) {
        console.error("Failed to rename:", err)
      }
      // Injected collaborators (applyMutationResult/refreshTree/t) are recreated each
      // render but treated as stable; activeTabKey excluded (functional setTabs).
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [treeItems, vault, handleApplyMutation],
  )

  const handleDeleteFile = React.useCallback(
    async (id: string) => {
      const item = findTreeItem(treeItems, id)
      const name = item?.name ?? id
      const normFolder = (item?.path ?? id).replace(/\\/g, "/").replace(/\/+$/, "")
      const affectedDocs = Object.values(useDocStore.getState().openDocs).filter(
        (doc) => doc.id === id || doc.path.replace(/\\/g, "/").startsWith(`${normFolder}/`),
      )
      const isDirtyOrConflicted = affectedDocs.some(
        (doc) =>
          useDocStore.getState().unsavedFileIds.has(doc.id) ||
          Boolean(useDocStore.getState().externalConflicts[doc.id]),
      )

      const resolution = await requestDeleteConfirmation(id, name, isDirtyOrConflicted)
      if (resolution === "cancel") return

      try {
        for (const doc of affectedDocs) {
          autosave.discard(autosaveKey(doc.id))
          useDocStore.getState().clearExternalConflict(doc.id)
          if (resolution === "keep_recovery") {
            void saveRecoveryDraft(doc.id, doc.content, "markdown", doc.path)
          } else {
            void discardRecoveryDraft(doc.id)
            void discardRecoveryDraft(doc.path)
          }
        }
        const result = await deleteItem(vault ?? "", item?.path ?? id)
        handleApplyMutation(result)
        await refreshTree()
      } catch (err) {
        console.error("Failed to delete:", err)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [treeItems, vault, autosave, autosaveKey, handleApplyMutation],
  )

  const createDocumentIn = React.useCallback(
    async (parentId: string | null) => {
      if (!vault) return
      const basePath = parentId ?? vault
      const parent = parentId ? findTreeItem(treeItems, parentId) : null
      try {
        const untitled = t("defaults.untitled")
        const result = await createNote(vault, parent?.path ?? basePath, untitled)
        handleApplyMutation(result)
        await refreshTree()
        const id = result.primaryId ?? result.primaryPath
        if (!id) return
        const doc: Document = {
          id,
          title: untitled,
          content: "",
          created: t("time.justNow"),
          modified: t("time.justNow"),
          wordCount: 0,
          path: result.primaryPath ?? id,
        }
        setDoc(id, doc)
        const key = newTabKey()
        setTabs((prev) => [
          ...prev,
          { key, kind: "document", fileId: id, title: untitled, history: [id], historyIndex: 0 },
        ])
        setActiveTabKey(key)
        setPendingRenameId(id)
        setTimeout(() => setPendingRenameId(null), 500)
      } catch (err) {
        console.error("Failed to create file:", err)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vault, treeItems, handleApplyMutation],
  )

  const handleNewFileIn = React.useCallback(
    (parentId: string | null) => createDocumentIn(parentId),
    [createDocumentIn],
  )

  const handleNewFolderIn = React.useCallback(
    async (parentId: string | null) => {
      if (!vault) return
      const basePath = parentId ?? vault
      const parent = parentId ? findTreeItem(treeItems, parentId) : null
      try {
        const untitled = t("defaults.untitled")
        const path = await createFolder(parent?.path ?? basePath, untitled)
        const newItem: TreeItem = {
          id: `folder:${path}`,
          path,
          name: untitled,
          type: "folder",
          icon: "folder",
          children: [],
        }
        if (parentId) {
          setTreeItems((prev) =>
            updateInTree(prev, parentId, (folder) => ({
              ...folder,
              children: [...(folder.children ?? []), newItem],
            })),
          )
        } else {
          setTreeItems((prev) => [...prev, newItem])
        }
        setPendingRenameId(newItem.id)
        setTimeout(() => setPendingRenameId(null), 500)
      } catch (err) {
        console.error("Failed to create folder:", err)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vault, treeItems],
  )

  const handleNewCanvasIn = async (parentId: string | null) => {
    if (!vault) return
    const parent = parentId ? findTreeItem(treeItems, parentId) : null
    try {
      const path = await createCanvasFile(
        vault,
        parent?.path ?? parentId ?? null,
        t("defaults.untitled"),
      )
      await refreshTree()
      setOpenCanvases((prev) => ({ ...prev, [path]: "{}\n" }))
      const title = wsPathStem(path)
      const key = newTabKey()
      setTabs((prev) => [
        ...prev,
        { key, kind: "canvas", fileId: path, title, history: [], historyIndex: 0 },
      ])
      setActiveTabKey(key)
    } catch (err) {
      console.error("Failed to create canvas:", err)
    }
  }

  const handleAttachCanvasToNote = async (canvasId: string) => {
    if (!vault) return
    const item = findTreeItem(treeItems, canvasId)
    const canvasPath = item?.path ?? canvasId.replace(/^canvas:/u, "")
    try {
      const result = await attachCanvasToNote(vault, canvasPath)
      handleApplyMutation(result)
      await refreshTree()
      // Close the now-promoted standalone canvas tab.
      setTabs((prev) => prev.filter((tb) => !(tb.kind === "canvas" && tb.fileId === canvasPath)))
      const notePath = result.primaryPath
      if (!notePath) return
      const id = result.primaryId ?? notePath
      const name = wsPathStem(notePath)
      try {
        await loadDoc(id, name)
      } catch {
        /* ignore */
      }
      setActiveLayer(id, "canvas")
      const existing = tabs.find((tb) => tb.kind === "document" && tb.fileId === id)
      if (existing) {
        setActiveTabKey(existing.key)
      } else {
        const key = newTabKey()
        setTabs((prev) => [
          ...prev,
          { key, kind: "document", fileId: id, title: name, history: [id], historyIndex: 0 },
        ])
        setActiveTabKey(key)
      }
    } catch (err) {
      console.error("Failed to attach canvas to note:", err)
    }
  }

  const handleMoveItem = React.useCallback(
    async (sourceId: string, targetFolderId: string | null) => {
      const sourceItem = findTreeItem(treeItems, sourceId)
      if (!sourceItem || !vault) return
      const targetItem = targetFolderId ? findTreeItem(treeItems, targetFolderId) : null
      if (targetFolderId && !targetItem) return
      const norm = (p: string) => p.replace(/\\/g, "/")
      const dirname = (p: string) => {
        const value = norm(p).replace(/\/+$/, "")
        const index = value.lastIndexOf("/")
        return index === -1 ? "" : value.slice(0, index)
      }
      const basename = (p: string) => norm(p).replace(/\/+$/, "").split("/").pop() ?? ""
      const stem = (p: string) => basename(p).replace(/\.[^.]+$/, "")
      const normSrc = norm(sourceItem.path ?? sourceId)
      const normTgt = targetItem ? norm(targetItem.path ?? targetFolderId ?? "") : norm(vault)
      const sourceParent = dirname(normSrc)
      const sourceRoot =
        sourceItem.type === "file" && basename(sourceParent) === stem(normSrc)
          ? sourceParent
          : normSrc
      if (normTgt.startsWith(sourceRoot + "/") || normTgt === sourceRoot) return
      if (!targetFolderId && dirname(sourceRoot) === norm(vault)) return
      try {
        const sourcePath = sourceItem.path ?? sourceId
        const targetPath = targetItem?.path ?? vault
        const preview = await previewMoveRefactor(vault, sourcePath, targetPath)
        if (
          preview.replacements > 0 &&
          !(await confirmAction(
            t("workspace.moveRefactorConfirm", {
              replacements: preview.replacements,
              notes: preview.notes,
            }),
          ))
        )
          return
        const result = await moveItem(vault, sourcePath, targetPath)
        handleApplyMutation(result)
        await refreshTree()
      } catch (err) {
        console.error("Failed to move item:", err)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [treeItems, vault, handleApplyMutation],
  )

  const handleMergeFile = React.useCallback(
    async (sourceId: string, targetId: string) => {
      if (!vault || sourceId === targetId) return
      const sourceItem = findTreeItem(treeItems, sourceId)
      const targetItem = findTreeItem(treeItems, targetId)
      if (sourceItem?.type !== "file" || targetItem?.type !== "file") return
      if (
        !(await confirmAction(
          t("workspace.mergeFilesConfirm", { source: sourceItem.name, target: targetItem.name }),
        ))
      )
        return

      try {
        // Drain already queued autosaves first so none can overwrite the merge.
        await Promise.all([
          autosave.flush(autosaveKey(sourceId)),
          autosave.flush(autosaveKey(targetId)),
        ])
        const openDocs = useDocStore.getState().openDocs
        const sourceContent = openDocs[sourceId]?.content ?? (await readNote(vault, sourceId))
        const targetContent = openDocs[targetId]?.content ?? (await readNote(vault, targetId))
        const merged = [targetContent.trimEnd(), sourceContent.trimStart()]
          .filter(Boolean)
          .join("\n\n")
        const targetDocument = openDocs[targetId]
        const targetPath = targetDocument?.path ?? targetItem.path
        if (targetDocument) {
          patchDoc(targetId, {
            content: merged,
            wordCount: merged.trim() ? merged.trim().split(/\s+/u).length : 0,
          })
          markUnsaved(targetId)
        }
        void saveRecoveryDraft(targetId, merged, "markdown", targetPath)
        autosave.enqueueImmediate(autosaveKey(targetId), {
          fileId: targetId,
          path: targetPath,
          content: merged,
          backendGeneration,
        })
        await autosave.flush(autosaveKey(targetId))
        const result = await deleteItem(vault, sourceItem.path)
        handleApplyMutation(result)
        await refreshTree()
        await handleSelect(targetId)
      } catch (err) {
        console.error("Failed to merge files:", err)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [autosave, autosaveKey, treeItems, vault, handleApplyMutation],
  )

  // ── Content autosave ──────────────────────────────────────────────────────────

  const handleContentChange = (fileId: string, content: string) => {
    const editedDoc = useDocStore.getState().openDocs[fileId]
    if (!editedDoc || editedDoc.id !== fileId) {
      logger.error("autosave.rejected_document_mismatch", { fileId })
      return
    }
    // Store only content here; wordCount is derived lazily inside DocumentEditor
    // to avoid the O(n) split on every keystroke causing a Workspace re-render.
    patchDoc(fileId, { content })
    markUnsaved(fileId)
    const path = editedDoc.path
    if (path) void saveRecoveryDraft(fileId, content, "markdown", path)

    const key = autosaveKey(fileId)
    if (useDocStore.getState().externalConflicts[fileId]) {
      autosave.pause(key)
      return
    }
    autosave.resume(key)
    autosave.schedule(
      key,
      { fileId, path, content, backendGeneration },
      useSettingsStore.getState().prefs.editor.autosaveMs,
    )
  }

  return {
    loadDoc,
    handleSelect,
    handleOpenInNewTab,
    handleCloneFile,
    navigateToFile,
    scrollEditorToAnchor,
    handleWikiLinkClick,
    handleRenameFile,
    handleDeleteFile,
    handleNewFileIn,
    handleNewFolderIn,
    handleNewCanvasIn,
    handleAttachCanvasToNote,
    handleMoveItem,
    handleMergeFile,
    handleContentChange,
    deleteConfirmationDialog: pendingDelete
      ? React.createElement(DeleteConfirmationDialog, {
          name: pendingDelete.name,
          isDirtyOrConflicted: pendingDelete.isDirtyOrConflicted,
          onCancel: () => settleDeleteConfirmation("cancel"),
          onConfirm: (dontAskAgain: boolean) => settleDeleteConfirmation("confirm", dontAskAgain),
          onKeepRecovery: () => settleDeleteConfirmation("keep_recovery"),
          onDiscard: () => settleDeleteConfirmation("discard"),
        })
      : null,
  }
}
