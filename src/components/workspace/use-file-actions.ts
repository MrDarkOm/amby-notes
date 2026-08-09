import * as React from "react"
import i18n from "@/lib/i18n"
import { errorType, logger } from "@/lib/logger"
import { PerKeySerialQueue } from "@/lib/per-key-queue"
import { discardRecoveryDraft, readRecoveryDraft, saveRecoveryDraft } from "@/lib/recovery-drafts"
import { useDocStore, type Document } from "./use-doc-store"
import { useTabsStore } from "./use-tabs-store"
import { useViewStateStore } from "./use-view-state-store"
import { useSettingsStore } from "./use-settings-store"
import { loadWorkspaceConfig, saveWorkspaceConfigPatch } from "./app-config"
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog"
import { normalizeWikiLinkTarget, findWikiLinkItem } from "./wiki-links"
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
  saveTimersRef: React.MutableRefObject<Map<string, ReturnType<typeof setTimeout>>>
}

/**
 * File/folder/canvas CRUD + navigation handlers, all of which share the shape
 *   findTreeItem(treeItems,…) → storage call → applyMutationResult → refreshTree.
 *
 * Owns no state of its own: it reads the doc/tabs/view/settings stores via
 * getState() and receives the tree + cross-cutting callbacks (applyMutationResult,
 * openCanvasTab, setOpenCanvases, setPendingRenameId, saveTimersRef) from Workspace.
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
  saveTimersRef,
}: UseFileActionsParams) {
  const t = i18n.t.bind(i18n)
  const saveQueueRef = React.useRef(new PerKeySerialQueue())
  const [pendingDelete, setPendingDelete] = React.useState<{
    id: string
    name: string
    resolve: (approved: boolean) => void
  } | null>(null)

  async function requestDeleteConfirmation(id: string, name: string): Promise<boolean> {
    const { confirmations } = await loadWorkspaceConfig()
    if (!confirmations.confirmFileDelete) return true
    return new Promise((resolve) => setPendingDelete({ id, name, resolve }))
  }

  function settleDeleteConfirmation(approved: boolean, dontAskAgain = false) {
    if (!pendingDelete) return
    if (dontAskAgain) {
      void saveWorkspaceConfigPatch({ confirmations: { confirmFileDelete: false } })
    }
    pendingDelete.resolve(approved)
    setPendingDelete(null)
  }

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
    const recovered = readRecoveryDraft(path)
    const shouldRecover =
      recovered && recovered.content !== content
        ? await confirmAction(t("recovery.restorePrompt"))
        : false
    const doc: Document = {
      id: fileId,
      title: itemName,
      content: shouldRecover ? recovered!.content : content,
      modified: formatModified(meta.modified),
      wordCount: meta.word_count,
      path,
      noteProperties,
    }
    setDoc(fileId, doc)
    if (shouldRecover) markUnsaved(fileId)
    else if (recovered) discardRecoveryDraft(path)
    return doc
  }

  const handleSelect = React.useCallback(
    async (fileId: string) => {
      const item = findTreeItem(treeItems, fileId)
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
      applyMutationResult(result)
      await refreshTree()
      const id = result.primaryId ?? result.primaryPath
      if (!id) return
      const name = target.split("/").pop() ?? target
      const doc: Document = {
        id,
        title: name,
        content: "",
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
        applyMutationResult(result)
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
    [treeItems, vault],
  )

  const handleDeleteFile = React.useCallback(
    async (id: string) => {
      const item = findTreeItem(treeItems, id)
      if (!(await requestDeleteConfirmation(id, item?.name ?? id))) return
      try {
        const result = await deleteItem(vault ?? "", item?.path ?? id)
        applyMutationResult(result)
        await refreshTree()
      } catch (err) {
        console.error("Failed to delete:", err)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [treeItems, vault],
  )

  const createDocumentIn = React.useCallback(
    async (parentId: string | null) => {
      if (!vault) return
      const basePath = parentId ?? vault
      const parent = parentId ? findTreeItem(treeItems, parentId) : null
      try {
        const untitled = t("defaults.untitled")
        const result = await createNote(vault, parent?.path ?? basePath, untitled)
        applyMutationResult(result)
        await refreshTree()
        const id = result.primaryId ?? result.primaryPath
        if (!id) return
        const doc: Document = {
          id,
          title: untitled,
          content: "",
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
    [vault, treeItems],
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
      applyMutationResult(result)
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
        applyMutationResult(result)
        await refreshTree()
      } catch (err) {
        console.error("Failed to move item:", err)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [treeItems, vault],
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
    if (path) saveRecoveryDraft(path, content)

    const timers = saveTimersRef.current
    const existing = timers.get(fileId)
    if (existing) clearTimeout(existing)
    timers.set(
      fileId,
      setTimeout(() => {
        timers.delete(fileId)
        void saveQueueRef.current
          .enqueue(fileId, async () => {
            const doc = useDocStore.getState().openDocs[fileId]
            // A later edit has already replaced this timer's buffer. Its own
            // timer will enqueue the current content, so never write stale text.
            if (!doc || doc.id !== fileId || doc.content !== content) return
            if (useDocStore.getState().externalConflicts[fileId]) return

            if (vault) await writeNote(vault, doc.id, content)
            else await writeFile(doc.path, content)

            // An edit may have happened while the disk write was in flight.
            // Only clear the dirty marker if this exact buffer remains current.
            const current = useDocStore.getState().openDocs[fileId]
            if (current?.content === content) {
              discardRecoveryDraft(current.path)
              markSaved(fileId)
            }
          })
          .catch((err) => logger.error("autosave.failed", { errorType: errorType(err) }))
      }, useSettingsStore.getState().prefs.editor.autosaveMs),
    )
  }

  return {
    loadDoc,
    handleSelect,
    handleOpenInNewTab,
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
    handleContentChange,
    deleteConfirmationDialog: pendingDelete
      ? React.createElement(DeleteConfirmationDialog, {
          name: pendingDelete.name,
          onCancel: () => settleDeleteConfirmation(false),
          onConfirm: (dontAskAgain: boolean) => settleDeleteConfirmation(true, dontAskAgain),
        })
      : null,
  }
}
