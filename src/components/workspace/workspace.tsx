"use client"

import * as React from "react"
import { FolderOpen } from "lucide-react"
import { AppSidebar } from "./app-sidebar"

function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      className="relative z-10 w-px shrink-0 cursor-col-resize bg-zinc-800 transition-colors hover:bg-zinc-500"
      onMouseDown={onMouseDown}
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  )
}
import { DocumentEditor } from "./document-editor"
import { PropertiesPanel } from "./properties-panel"
import { HeaderTabs, type HeaderTab } from "./header-tabs"
import { QuickOpenModal } from "./quick-open-modal"
import type { TreeItem } from "./sidebar-tree"
import type { VaultRecord } from "./workspace-picker"
import {
  isTauri,
  openVault,
  listFiles,
  readFile,
  writeFile,
  getFileMetadata,
  createFile,
  createFolder,
  renameItem,
  deleteItem,
  openInExplorer,
} from "@/lib/storage"
import { watch } from "@tauri-apps/plugin-fs"
import { getCurrentWindow } from "@tauri-apps/api/window"

interface Document {
  id: string
  title: string
  content: string
  modified: string
  wordCount: number
  path: string
}

interface Tab {
  key: string
  fileId: string
  title: string
  history: string[]
  historyIndex: number
}

function flattenTree(items: TreeItem[]): Set<string> {
  const ids = new Set<string>()
  function walk(list: TreeItem[]) {
    for (const item of list) {
      ids.add(item.id)
      if (item.children) walk(item.children)
    }
  }
  walk(items)
  return ids
}

function findTreeItem(items: TreeItem[], id: string): TreeItem | null {
  for (const item of items) {
    if (item.id === id) return item
    if (item.children) {
      const found = findTreeItem(item.children, id)
      if (found) return found
    }
  }
  return null
}

function formatModified(ts?: number): string {
  if (!ts) return "Только что"
  const date = new Date(ts * 1000)
  const diffMs = Date.now() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return "Только что"
  if (diffMins < 60) return `${diffMins} мин назад`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}ч назад`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return "Вчера"
  return `${diffDays}д назад`
}

function newTabKey() {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function applyIconOverrides(items: TreeItem[], overrides: Record<string, string>): TreeItem[] {
  return items.map(item => ({
    ...item,
    icon: overrides[item.id] ?? item.icon,
    children: item.children ? applyIconOverrides(item.children, overrides) : undefined,
  }))
}

export function Workspace() {
  const [vault, setVault] = React.useState<string | null>(null)
  const [treeItems, setTreeItems] = React.useState<TreeItem[]>([])
  const [openDocs, setOpenDocs] = React.useState<Record<string, Document>>({})
  const [tabs, setTabs] = React.useState<Tab[]>([])
  const [activeTabKey, setActiveTabKey] = React.useState<string>("")
  const [unsavedFileIds, setUnsavedFileIds] = React.useState<Set<string>>(new Set())
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = React.useState(true)
  const [isRightSidebarOpen, setIsRightSidebarOpen] = React.useState(true)
  const [leftWidth, setLeftWidth] = React.useState(208)
  const [rightWidth, setRightWidth] = React.useState(256)
  const [favorites, setFavorites] = React.useState<Set<string>>(new Set())

  function handleToggleFavorite(id: string) {
    setFavorites(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      if (vault) localStorage.setItem(`amby:favorites:${vault}`, JSON.stringify([...next]))
      return next
    })
  }

  function startResize(side: "left" | "right") {
    return (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = side === "left" ? leftWidth : rightWidth
      const setW = side === "left" ? setLeftWidth : setRightWidth
      const sign = side === "left" ? 1 : -1

      function nearEdge(x: number) {
        return side === "left" ? x < 20 : x > window.innerWidth - 20
      }

      function onMove(ev: MouseEvent) {
        if (nearEdge(ev.clientX)) return
        const newW = startW + sign * (ev.clientX - startX)
        setW(Math.max(200, Math.min(520, newW)))
      }

      function onUp(ev: MouseEvent) {
        if (nearEdge(ev.clientX)) {
          setW(208)
          if (side === "left") setIsLeftSidebarOpen(false)
          else setIsRightSidebarOpen(false)
        }
        window.removeEventListener("mousemove", onMove)
        window.removeEventListener("mouseup", onUp)
      }

      window.addEventListener("mousemove", onMove)
      window.addEventListener("mouseup", onUp)
    }
  }
  const [quickOpenOpen, setQuickOpenOpen] = React.useState(false)
  const [pendingRenameId, setPendingRenameId] = React.useState<string | null>(null)
  const [isFocusMode, setIsFocusMode] = React.useState(false)
  const [sidebarActiveView, setSidebarActiveView] = React.useState<"files" | "search" | "tags" | "favorites" | "databases" | "archive">("files")
  const [focusShowLeft, setFocusShowLeft] = React.useState(false)
  const [focusShowRight, setFocusShowRight] = React.useState(false)
  const preFocusSidebars = React.useRef<{ left: boolean; right: boolean } | null>(null)
  const [iconOverrides, setIconOverrides] = React.useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("amby:icons") ?? "{}") } catch { return {} }
  })
  const [vaults, setVaults] = React.useState<VaultRecord[]>(() => {
    try { return JSON.parse(localStorage.getItem("amby:vaults") ?? "[]") } catch { return [] }
  })

  const openDocsRef = React.useRef(openDocs)
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => { openDocsRef.current = openDocs }, [openDocs])

  React.useEffect(() => {
    if (!vault || tabs.length === 0) return
    const entries = tabs.map(t => ({ fileId: t.fileId, title: t.title }))
    const active = tabs.find(t => t.key === activeTabKey)
    localStorage.setItem(`amby:tabs:${vault}`, JSON.stringify({
      entries,
      activeFileId: active?.fileId ?? entries[0]?.fileId ?? "",
    }))
  }, [tabs, activeTabKey, vault])

  const activeTab = tabs.find(t => t.key === activeTabKey) ?? null
  const selectedId = activeTab?.fileId ?? ""
  const canGoBack = (activeTab?.historyIndex ?? 0) > 0
  const canGoForward = activeTab ? activeTab.historyIndex < activeTab.history.length - 1 : false

  const vaultName = vault?.replace(/\\/g, "/").split("/").pop() ?? undefined
  const displayTreeItems = applyIconOverrides(treeItems, iconOverrides)

  // Current file icon (from iconOverrides or tree)
  const activeFileId = activeTab?.fileId ?? null
  const activeTreeItem = activeFileId ? findTreeItem(displayTreeItems, activeFileId) : null
  const currentFileIcon = activeTreeItem?.icon

  function handleSetIcon(id: string, icon: string) {
    const next = { ...iconOverrides, [id]: icon }
    setIconOverrides(next)
    localStorage.setItem("amby:icons", JSON.stringify(next))
  }

  function saveVaults(next: VaultRecord[]) {
    setVaults(next)
    localStorage.setItem("amby:vaults", JSON.stringify(next))
  }

  function addVaultToList(path: string) {
    setVaults(prev => {
      if (prev.find(v => v.path === path)) return prev
      const name = path.replace(/\\/g, "/").split("/").pop() ?? path
      const next = [...prev, { id: crypto.randomUUID(), name, path }]
      localStorage.setItem("amby:vaults", JSON.stringify(next))
      return next
    })
  }

  function handleRenameVault(id: string, name: string) {
    saveVaults(vaults.map(v => v.id === id ? { ...v, name } : v))
  }

  function handleDeleteVault(id: string) {
    saveVaults(vaults.filter(v => v.id !== id))
  }

  async function handleMoveVault(id: string) {
    const path = await openVault()
    if (!path) return
    saveVaults(vaults.map(v => v.id === id ? { ...v, path, name: path.replace(/\\/g, "/").split("/").pop() ?? v.name } : v))
    const target = vaults.find(v => v.id === id)
    if (target && vault === target.path) loadVault(path)
  }

  async function handleEnterFocusMode() {
    preFocusSidebars.current = { left: isLeftSidebarOpen, right: isRightSidebarOpen }
    setIsLeftSidebarOpen(false)
    setIsRightSidebarOpen(false)
    setIsFocusMode(true)
    if (isTauri()) await getCurrentWindow().setFullscreen(true).catch(() => {})
  }

  async function handleExitFocusMode() {
    setIsFocusMode(false)
    if (preFocusSidebars.current) {
      setIsLeftSidebarOpen(preFocusSidebars.current.left)
      setIsRightSidebarOpen(preFocusSidebars.current.right)
      preFocusSidebars.current = null
    }
    if (isTauri()) await getCurrentWindow().setFullscreen(false).catch(() => {})
  }

  function handleCloseAllTabs() {
    setTabs([])
    setActiveTabKey("")
  }

  // Watch vault for external changes
  React.useEffect(() => {
    if (!vault || !isTauri()) return
    let unwatch: (() => void) | undefined
    let refreshTimer: ReturnType<typeof setTimeout> | null = null

    watch(vault, () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(async () => {
        try {
          const tree = await listFiles(vault)
          setTreeItems(tree)
        } catch { /* vault may be temporarily inaccessible */ }
      }, 300)
    }, { recursive: true })
      .then(fn => { unwatch = fn })
      .catch(console.error)

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      unwatch?.()
    }
  }, [vault])

  // On mount: restore saved vault
  React.useEffect(() => {
    const saved = localStorage.getItem("amby:vault")
    if (saved) loadVault(saved)
    else if (!isTauri()) loadVault("web-vault")
  }, [])

  async function loadVault(path: string) {
    try {
      const tree = await listFiles(path)
      setVault(path)
      setTreeItems(tree)
      localStorage.setItem("amby:vault", path)
      addVaultToList(path)

      // Restore favorites
      try {
        const savedFavs = localStorage.getItem(`amby:favorites:${path}`)
        setFavorites(savedFavs ? new Set(JSON.parse(savedFavs)) : new Set())
      } catch { setFavorites(new Set()) }

      // Restore open tabs
      try {
        const savedTabs = localStorage.getItem(`amby:tabs:${path}`)
        if (savedTabs) {
          const { entries, activeFileId } = JSON.parse(savedTabs) as {
            entries: { fileId: string; title: string }[]
            activeFileId: string
          }
          const allIds = flattenTree(tree)
          const valid = entries.filter(e => allIds.has(e.fileId))
          if (valid.length > 0) {
            const newTabs: Tab[] = valid.map(e => ({
              key: newTabKey(), fileId: e.fileId, title: e.title,
              history: [e.fileId], historyIndex: 0,
            }))
            setTabs(newTabs)
            const activeTab = newTabs.find(t => t.fileId === activeFileId) ?? newTabs[0]
            setActiveTabKey(activeTab.key)
            // Load docs for restored tabs
            valid.forEach(e => {
              readFile(e.fileId).then(content => {
                setOpenDocs(prev => ({
                  ...prev,
                  [e.fileId]: { id: e.fileId, title: e.title, content, modified: "", wordCount: 0, path: e.fileId },
                }))
              }).catch(() => {})
            })
            return
          }
        }
      } catch { /* ignore */ }
      setTabs([])
      setOpenDocs({})
      setActiveTabKey("")
    } catch (err) {
      console.error("Failed to load vault:", err)
    }
  }

  async function handleOpenVault() {
    const path = await openVault()
    if (path) loadVault(path)
  }

  async function loadDoc(fileId: string, itemName: string): Promise<Document> {
    if (openDocs[fileId]) return openDocs[fileId]
    const [content, meta] = await Promise.all([readFile(fileId), getFileMetadata(fileId)])
    const doc: Document = {
      id: fileId, title: itemName, content,
      modified: formatModified(meta.modified),
      wordCount: meta.word_count, path: fileId,
    }
    setOpenDocs(prev => ({ ...prev, [fileId]: doc }))
    return doc
  }

  const handleSelect = async (fileId: string) => {
    const item = findTreeItem(treeItems, fileId)
    if (!item || item.type !== "file") return

    try {
      await loadDoc(fileId, item.name)
    } catch (err) {
      console.error("Failed to load file:", err)
      return
    }

    if (activeTabKey) {
      setTabs(prev => prev.map(t => {
        if (t.key !== activeTabKey) return t
        const newHistory = [...t.history.slice(0, t.historyIndex + 1), fileId]
        return { ...t, fileId, title: item.name, history: newHistory, historyIndex: newHistory.length - 1 }
      }))
    } else {
      const key = newTabKey()
      setTabs([{ key, fileId, title: item.name, history: [fileId], historyIndex: 0 }])
      setActiveTabKey(key)
    }
  }

  const handleOpenInNewTab = async (fileId: string) => {
    const item = findTreeItem(treeItems, fileId)
    if (!item || item.type !== "file") return

    try {
      await loadDoc(fileId, item.name)
    } catch (err) {
      console.error("Failed to load file:", err)
      return
    }

    const key = newTabKey()
    setTabs(prev => [...prev, { key, fileId, title: item.name, history: [fileId], historyIndex: 0 }])
    setActiveTabKey(key)
  }

  async function navigateToFile(fileId: string) {
    const item = findTreeItem(treeItems, fileId)
    if (!item) return
    try { await loadDoc(fileId, item.name) } catch { /* ok */ }
  }

  function handleBack() {
    if (!activeTab || !canGoBack) return
    const newIndex = activeTab.historyIndex - 1
    const prevFileId = activeTab.history[newIndex]
    const item = findTreeItem(treeItems, prevFileId)
    setTabs(prev => prev.map(t => t.key !== activeTabKey ? t : {
      ...t, fileId: prevFileId, title: item?.name ?? t.title, historyIndex: newIndex,
    }))
    navigateToFile(prevFileId)
  }

  function handleForward() {
    if (!activeTab || !canGoForward) return
    const newIndex = activeTab.historyIndex + 1
    const nextFileId = activeTab.history[newIndex]
    const item = findTreeItem(treeItems, nextFileId)
    setTabs(prev => prev.map(t => t.key !== activeTabKey ? t : {
      ...t, fileId: nextFileId, title: item?.name ?? t.title, historyIndex: newIndex,
    }))
    navigateToFile(nextFileId)
  }

  const handleTabChange = (key: string) => setActiveTabKey(key)

  const handleTabClose = (key: string) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    const remaining = tabs.filter(t => t.key !== key)
    setTabs(remaining)
    if (activeTabKey === key) {
      const next = remaining[remaining.length - 1]
      setActiveTabKey(next?.key ?? "")
    }
  }

  function updateInTree(items: TreeItem[], id: string, updater: (item: TreeItem) => TreeItem): TreeItem[] {
    return items.map(item => {
      if (item.id === id) return updater(item)
      if (item.children) return { ...item, children: updateInTree(item.children, id, updater) }
      return item
    })
  }

  function removeFromTree(items: TreeItem[], id: string): TreeItem[] {
    return items
      .filter(item => item.id !== id)
      .map(item => ({ ...item, children: item.children ? removeFromTree(item.children, id) : undefined }))
  }

  const handleRenameFile = async (id: string, newName: string) => {
    const item = findTreeItem(treeItems, id)
    if (!item) return
    const parts = id.split("/")
    parts[parts.length - 1] = item.type === "file" ? `${newName}.md` : newName
    const newPath = parts.join("/")
    try {
      await renameItem(id, newPath)
      setTreeItems(prev => updateInTree(prev, id, i => ({ ...i, id: newPath, name: newName })))
      setOpenDocs(prev => {
        if (!prev[id]) return prev
        const doc = { ...prev[id], id: newPath, title: newName, path: newPath }
        const next = { ...prev }
        delete next[id]
        next[newPath] = doc
        return next
      })
      setTabs(prev => prev.map(t => t.fileId === id
        ? { ...t, fileId: newPath, title: newName, history: t.history.map(h => h === id ? newPath : h) }
        : t))
    } catch (err) {
      console.error("Failed to rename:", err)
    }
  }

  const handleDeleteFile = async (id: string) => {
    const item = findTreeItem(treeItems, id)
    if (!confirm(`Удалить "${item?.name ?? id}"?`)) return
    try {
      await deleteItem(id)
      setTreeItems(prev => removeFromTree(prev, id))
      setTabs(prev => {
        const remaining = prev.filter(t => t.fileId !== id)
        if (remaining.length !== prev.length && activeTabKey) {
          const stillExists = remaining.find(t => t.key === activeTabKey)
          if (!stillExists) setActiveTabKey(remaining[remaining.length - 1]?.key ?? "")
        }
        return remaining
      })
    } catch (err) {
      console.error("Failed to delete:", err)
    }
  }

  const handleNewFileIn = async (parentId: string | null) => {
    if (!vault) return
    const basePath = parentId ?? vault
    try {
      const path = await createFile(basePath, "Untitled")
      const newItem: TreeItem = { id: path, name: "Untitled", type: "file", icon: "file" }
      if (parentId) {
        setTreeItems(prev => updateInTree(prev, parentId, folder => ({
          ...folder, children: [...(folder.children ?? []), newItem],
        })))
      } else {
        setTreeItems(prev => [...prev, newItem])
      }
      const doc: Document = { id: path, title: "Untitled", content: "", modified: "Только что", wordCount: 0, path }
      setOpenDocs(prev => ({ ...prev, [path]: doc }))
      const key = newTabKey()
      setTabs(prev => [...prev, { key, fileId: path, title: "Untitled", history: [path], historyIndex: 0 }])
      setActiveTabKey(key)
      setPendingRenameId(path)
      setTimeout(() => setPendingRenameId(null), 500)
    } catch (err) {
      console.error("Failed to create file:", err)
    }
  }

  const handleNewFolderIn = async (parentId: string | null) => {
    if (!vault) return
    const basePath = parentId ?? vault
    try {
      const path = await createFolder(basePath, "Untitled")
      const newItem: TreeItem = { id: path, name: "Untitled", type: "folder", icon: "folder", children: [] }
      if (parentId) {
        setTreeItems(prev => updateInTree(prev, parentId, folder => ({
          ...folder, children: [...(folder.children ?? []), newItem],
        })))
      } else {
        setTreeItems(prev => [...prev, newItem])
      }
      setPendingRenameId(path)
      setTimeout(() => setPendingRenameId(null), 500)
    } catch (err) {
      console.error("Failed to create folder:", err)
    }
  }

  const handleMoveItem = async (sourceId: string, targetFolderId: string) => {
    const sourceItem = findTreeItem(treeItems, sourceId)
    if (!sourceItem) return
    const norm = (p: string) => p.replace(/\\/g, "/")
    const normSrc = norm(sourceId)
    const normTgt = norm(targetFolderId)
    if (normTgt.startsWith(normSrc + "/") || normTgt === normSrc) return
    const sourceName = normSrc.split("/").pop()!
    const sep = targetFolderId.includes("\\") ? "\\" : "/"
    const newPath = `${targetFolderId}${sep}${sourceName}`
    try {
      await renameItem(sourceId, newPath)
      const withoutSource = removeFromTree(treeItems, sourceId)
      const moved: TreeItem = { ...sourceItem, id: newPath }
      const updated = updateInTree(withoutSource, targetFolderId, folder => ({
        ...folder, children: [...(folder.children ?? []), moved],
      }))
      setTreeItems(updated)
      setTabs(prev => prev.map(t => t.fileId === sourceId
        ? { ...t, fileId: newPath, title: sourceItem.name, history: t.history.map(h => h === sourceId ? newPath : h) }
        : t))
      setOpenDocs(prev => {
        if (!prev[sourceId]) return prev
        const doc = { ...prev[sourceId], id: newPath, path: newPath }
        const next = { ...prev }
        delete next[sourceId]
        next[newPath] = doc
        return next
      })
    } catch (err) {
      console.error("Failed to move item:", err)
    }
  }

  const handleContentChange = (content: string) => {
    if (!activeTab) return
    const fileId = activeTab.fileId

    setOpenDocs(prev => ({
      ...prev,
      [fileId]: { ...prev[fileId], content, wordCount: content.split(/\s+/).filter(Boolean).length },
    }))
    setUnsavedFileIds(prev => new Set(prev).add(fileId))

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      const doc = openDocsRef.current[fileId]
      if (!doc) return
      try {
        await writeFile(doc.path, content)
        setUnsavedFileIds(prev => { const s = new Set(prev); s.delete(fileId); return s })
        setOpenDocs(prev => ({ ...prev, [fileId]: { ...prev[fileId], modified: "Только что" } }))
      } catch (err) {
        console.error("Failed to save:", err)
      }
    }, 500)
  }

  const currentDoc = activeTab ? openDocs[activeTab.fileId] ?? null : null

  const currentProperties = currentDoc ? {
    type: "Markdown", status: "Draft", revisions: 0, backlinks: 0,
    created: "—", modified: currentDoc.modified, id: currentDoc.id,
  } : null

  const headerTabs: HeaderTab[] = tabs.map(t => ({ key: t.key, fileId: t.fileId, title: t.title }))

  const sidebarProps = {
    treeItems: displayTreeItems,
    selectedId,
    vault,
    onSelect: handleSelect,
    onOpenVault: handleOpenVault,
    onTreeChange: setTreeItems,
    onRename: handleRenameFile,
    onDelete: handleDeleteFile,
    onNewFile: handleNewFileIn,
    onNewFolder: handleNewFolderIn,
    activeView: sidebarActiveView,
    onActiveViewChange: setSidebarActiveView,
    onOpenInNewTab: handleOpenInNewTab,
    onOpenInExplorer: openInExplorer,
    onMoveItem: handleMoveItem,
    onSetIcon: handleSetIcon,
    triggerRenameId: pendingRenameId,
    readFile,
    favorites,
    onToggleFavorite: handleToggleFavorite,
  }

  const editorProps = {
    document: currentDoc,
    onContentChange: handleContentChange,
    onBack: handleBack,
    onForward: handleForward,
    canGoBack,
    canGoForward,
    onRenameTitle: (name: string) => activeTab && handleRenameFile(activeTab.fileId, name),
    vault: vault ?? undefined,
    fileIcon: currentFileIcon,
    onNewFile: () => handleNewFileIn(null),
    onOpenVault: handleOpenVault,
    onTagClick: (_tag: string) => {
      setIsLeftSidebarOpen(true)
      setSidebarActiveView("tags")
    },
  }

  if (!vault && isTauri()) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background">
        <p className="text-zinc-400">Хранилище не открыто</p>
        <button
          onClick={handleOpenVault}
          className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-5 py-2.5 text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
        >
          <FolderOpen className="size-4" />
          Открыть хранилище
        </button>
      </div>
    )
  }

  // ── Focus mode layout ──────────────────────────────────────────
  if (isFocusMode) {
    return (
      <div
        className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background"
        onMouseMove={e => {
          const w = window.innerWidth
          if (e.clientX < 20) setFocusShowLeft(true)
          if (e.clientX > w - 20) setFocusShowRight(true)
        }}
      >
        <DocumentEditor
          {...editorProps}
          isFocusMode={true}
          onToggleFocusMode={handleExitFocusMode}
        />

        {/* Left sidebar overlay */}
        <div
          className={`fixed left-0 top-0 bottom-0 z-10 flex transition-transform duration-200 ease-out shadow-2xl ${focusShowLeft ? "translate-x-0" : "-translate-x-full"}`}
          onMouseLeave={() => setFocusShowLeft(false)}
        >
          <AppSidebar {...sidebarProps} isTreeOpen={true} />
        </div>

        {/* Right sidebar overlay */}
        <div
          className={`fixed right-0 top-0 bottom-0 z-10 transition-transform duration-200 ease-out shadow-2xl ${focusShowRight ? "translate-x-0" : "translate-x-full"}`}
          onMouseLeave={() => setFocusShowRight(false)}
        >
          <PropertiesPanel properties={currentProperties}  />
        </div>

        <QuickOpenModal
          open={quickOpenOpen}
          onClose={() => setQuickOpenOpen(false)}
          treeItems={displayTreeItems}
          onSelectFile={handleOpenInNewTab}
          onNewNote={() => handleNewFileIn(null)}
        />
      </div>
    )
  }

  // ── Normal layout ──────────────────────────────────────────────
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <HeaderTabs
        tabs={headerTabs}
        activeTabKey={activeTabKey}
        unsavedFileIds={unsavedFileIds}
        onTabChange={handleTabChange}
        onTabClose={handleTabClose}
        onToggleLeftSidebar={() => setIsLeftSidebarOpen(v => !v)}
        onToggleRightSidebar={() => setIsRightSidebarOpen(v => !v)}
        isLeftSidebarOpen={isLeftSidebarOpen}
        isRightSidebarOpen={isRightSidebarOpen}
        onOpenPlusModal={() => setQuickOpenOpen(true)}
        vaultName={vaultName}
        vaults={vaults}
        currentVaultPath={vault}
        onSwitchVault={loadVault}
        onAddVault={handleOpenVault}
        onRenameVault={handleRenameVault}
        onDeleteVault={handleDeleteVault}
        onMoveVault={handleMoveVault}
        onOpenVaultInExplorer={openInExplorer}
        onCloseAllTabs={handleCloseAllTabs}
        leftTreeWidth={leftWidth}
        activeFileId={activeTab?.fileId}
        favorites={favorites}
        onToggleFavorite={handleToggleFavorite}
      />

      <div className="flex flex-1 overflow-hidden">
        <AppSidebar
          {...sidebarProps}
          isTreeOpen={isLeftSidebarOpen}
          treeWidth={leftWidth}
        />

        {isLeftSidebarOpen && (
          <ResizeHandle onMouseDown={startResize("left")} />
        )}

        <main className="flex flex-1 overflow-hidden">
          <DocumentEditor
            {...editorProps}
            isFocusMode={false}
            onToggleFocusMode={handleEnterFocusMode}
          />
        </main>

        {isRightSidebarOpen && (
          <>
            <ResizeHandle onMouseDown={startResize("right")} />
            <div style={{ width: rightWidth }} className="shrink-0">
              <PropertiesPanel properties={currentProperties} />
            </div>
          </>
        )}
      </div>

      <QuickOpenModal
        open={quickOpenOpen}
        onClose={() => setQuickOpenOpen(false)}
        treeItems={displayTreeItems}
        onSelectFile={handleOpenInNewTab}
        onNewNote={() => handleNewFileIn(null)}
      />
    </div>
  )
}
