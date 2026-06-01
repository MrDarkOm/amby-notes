import * as React from "react"
import i18n from "@/lib/i18n"
import { useDocStore, type Document } from "./use-doc-store"
import { useTabsStore } from "./use-tabs-store"
import { useViewStateStore } from "./use-view-state-store"
import { useSettingsStore } from "./use-settings-store"
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
  createNote,
  createFolder,
  createCanvasFile,
  attachCanvasToNote,
  renameItem,
  deleteItem,
  moveItem,
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
    const [content, meta] = vault
      ? await Promise.all([readNote(vault, fileId), getNoteMetadata(vault, fileId)])
      : await Promise.all([readFile(item?.path ?? fileId), getNoteMetadata("", fileId)])
    const doc: Document = {
      id: fileId,
      title: itemName,
      content,
      modified: formatModified(meta.modified),
      wordCount: meta.word_count,
      path: item?.path ?? fileId,
    }
    setDoc(fileId, doc)
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
      const prose = document.querySelector<HTMLElement>(".amby-tiptap-prose")
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
      const tree = await refreshTree()
      const id = result.primaryId ?? result.primaryPath
      if (!id) return
      const item = findTreeItem(tree, id)
      const name = target.split("/").pop() ?? target
      const doc: Document = {
        id,
        title: name,
        content: "",
        modified: t("time.justNow"),
        wordCount: 0,
        path: item?.path ?? result.primaryPath ?? id,
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
        const result = await renameItem(vault ?? "", item.path ?? id, newName)
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
      if (!confirm(t("workspace.deleteConfirm", { name: item?.name ?? id }))) return
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

  const handleNewFileIn = React.useCallback(
    async (parentId: string | null) => {
      if (!vault) return
      const basePath = parentId ?? vault
      const parent = parentId ? findTreeItem(treeItems, parentId) : null
      try {
        const result = await createNote(vault, parent?.path ?? basePath, "Untitled")
        applyMutationResult(result)
        const tree = await refreshTree()
        const id = result.primaryId ?? result.primaryPath
        if (!id) return
        const item = findTreeItem(tree, id)
        const doc: Document = {
          id,
          title: "Untitled",
          content: "",
          modified: t("time.justNow"),
          wordCount: 0,
          path: item?.path ?? result.primaryPath ?? id,
        }
        setDoc(id, doc)
        const key = newTabKey()
        setTabs((prev) => [
          ...prev,
          { key, kind: "document", fileId: id, title: "Untitled", history: [id], historyIndex: 0 },
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

  const handleNewFolderIn = React.useCallback(
    async (parentId: string | null) => {
      if (!vault) return
      const basePath = parentId ?? vault
      const parent = parentId ? findTreeItem(treeItems, parentId) : null
      try {
        const path = await createFolder(parent?.path ?? basePath, "Untitled")
        const newItem: TreeItem = {
          id: `folder:${path}`,
          path,
          name: "Untitled",
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
      const path = await createCanvasFile(vault, parent?.path ?? parentId ?? null, "Untitled")
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
      const tree = await refreshTree()
      // Close the now-promoted standalone canvas tab.
      setTabs((prev) => prev.filter((tb) => !(tb.kind === "canvas" && tb.fileId === canvasPath)))
      const notePath = result.primaryPath
      if (!notePath) return
      // Resolve the new note's tree id (ULID in Tauri) by path.
      const norm = notePath.replace(/\\/g, "/")
      function findByPath(items: TreeItem[]): TreeItem | null {
        for (const it of items) {
          if (it.type === "file" && (it.path ?? it.id).replace(/\\/g, "/") === norm) return it
          if (it.children) {
            const found = findByPath(it.children)
            if (found) return found
          }
        }
        return null
      }
      const noteItem = findByPath(tree)
      const id = noteItem?.id ?? result.primaryId ?? notePath
      const name = noteItem?.name ?? wsPathStem(notePath)
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
        const result = await moveItem(vault, sourceItem.path ?? sourceId, targetItem?.path ?? vault)
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
    // Store only content here; wordCount is derived lazily inside DocumentEditor
    // to avoid the O(n) split on every keystroke causing a Workspace re-render.
    patchDoc(fileId, { content })
    markUnsaved(fileId)

    const timers = saveTimersRef.current
    const existing = timers.get(fileId)
    if (existing) clearTimeout(existing)
    timers.set(
      fileId,
      setTimeout(async () => {
        timers.delete(fileId)
        const doc = useDocStore.getState().openDocs[fileId]
        if (!doc) return
        try {
          if (vault) await writeNote(vault, doc.id, content)
          else await writeFile(doc.path, content)
          markSaved(fileId)
        } catch (err) {
          console.error("Failed to save:", err)
        }
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
  }
}
