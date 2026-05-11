"use client"

import * as React from "react"
import { FolderOpen } from "lucide-react"
import { AppSidebar } from "./app-sidebar"
import { DocumentEditor } from "./document-editor"
import { PropertiesPanel } from "./properties-panel"
import { HeaderTabs } from "./header-tabs"
import type { TreeItem } from "./sidebar-tree"
import {
  isTauri,
  openVault,
  listFiles,
  readFile,
  writeFile,
  getFileMetadata,
  createFile,
  renameItem,
  deleteItem,
} from "@/lib/storage"

interface Document {
  id: string
  title: string
  content: string
  modified: string
  wordCount: number
  path: string
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
  if (!ts) return "Just now"
  const date = new Date(ts * 1000)
  const diffMs = Date.now() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return "Just now"
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return "Yesterday"
  return `${diffDays}d ago`
}

export function Workspace() {
  const [vault, setVault] = React.useState<string | null>(null)
  const [treeItems, setTreeItems] = React.useState<TreeItem[]>([])
  const [openDocs, setOpenDocs] = React.useState<Record<string, Document>>({})
  const [selectedId, setSelectedId] = React.useState("")
  const [tabs, setTabs] = React.useState<{ id: string; title: string }[]>([])
  const [activeTabId, setActiveTabId] = React.useState("")
  const [unsavedIds, setUnsavedIds] = React.useState<Set<string>>(new Set())
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = React.useState(true)
  const [isRightSidebarOpen, setIsRightSidebarOpen] = React.useState(true)

  const openDocsRef = React.useRef(openDocs)
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    openDocsRef.current = openDocs
  }, [openDocs])

  // On mount: restore saved vault or auto-load web demo
  React.useEffect(() => {
    const saved = localStorage.getItem("amby:vault")
    if (saved) {
      loadVault(saved)
    } else if (!isTauri()) {
      loadVault("web-vault")
    }
  }, [])

  async function loadVault(path: string) {
    try {
      const tree = await listFiles(path)
      setVault(path)
      setTreeItems(tree)
      localStorage.setItem("amby:vault", path)
    } catch (err) {
      console.error("Failed to load vault:", err)
    }
  }

  async function handleOpenVault() {
    const path = await openVault()
    if (path) loadVault(path)
  }

  const handleSelect = async (id: string) => {
    const item = findTreeItem(treeItems, id)
    if (!item || item.type !== "file") return

    setSelectedId(id)
    setActiveTabId(id)

    if (!openDocs[id]) {
      try {
        const [content, meta] = await Promise.all([
          readFile(id),
          getFileMetadata(id),
        ])
        const doc: Document = {
          id,
          title: item.name,
          content,
          modified: formatModified(meta.modified),
          wordCount: meta.word_count,
          path: id,
        }
        setOpenDocs(prev => ({ ...prev, [id]: doc }))
        setTabs(prev => [...prev, { id, title: item.name }])
      } catch (err) {
        console.error("Failed to open file:", err)
      }
    }
  }

  const handleTabChange = (tabId: string) => {
    setActiveTabId(tabId)
    setSelectedId(tabId)
  }

  // helpers to mutate the tree immutably
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
      // update open doc/tab if affected
      if (openDocs[id]) {
        const doc = { ...openDocs[id], id: newPath, title: newName, path: newPath }
        setOpenDocs(prev => { const n = { ...prev }; delete n[id]; n[newPath] = doc; return n })
        setTabs(prev => prev.map(t => t.id === id ? { id: newPath, title: newName } : t))
        if (activeTabId === id) setActiveTabId(newPath)
        if (selectedId === id) setSelectedId(newPath)
      }
    } catch (err) {
      console.error("Failed to rename:", err)
    }
  }

  const handleDeleteFile = async (id: string) => {
    const item = findTreeItem(treeItems, id)
    if (!confirm(`Delete "${item?.name ?? id}"?`)) return
    try {
      await deleteItem(id)
      setTreeItems(prev => removeFromTree(prev, id))
      if (openDocs[id]) handleTabClose(id)
    } catch (err) {
      console.error("Failed to delete:", err)
    }
  }

  const handleNewFileIn = async (parentId: string | null) => {
    if (!vault) return
    const name = prompt("File name:")
    if (!name?.trim()) return
    const basePath = parentId ?? vault
    const path = await createFile(basePath, name.trim())
    const newItem: TreeItem = { id: path, name: name.trim(), type: "file", icon: "file" }
    if (parentId) {
      setTreeItems(prev => updateInTree(prev, parentId, folder => ({
        ...folder,
        children: [...(folder.children ?? []), newItem],
      })))
    } else {
      setTreeItems(prev => [...prev, newItem])
    }
    handleSelect(path)
  }

  const handleTabClose = (tabId: string) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    const newTabs = tabs.filter(t => t.id !== tabId)
    setTabs(newTabs)
    setUnsavedIds(prev => { const s = new Set(prev); s.delete(tabId); return s })
    if (activeTabId === tabId) {
      const next = newTabs[newTabs.length - 1]
      setActiveTabId(next?.id ?? "")
      setSelectedId(next?.id ?? "")
    }
  }

  const handleContentChange = (content: string) => {
    const id = activeTabId
    if (!id) return

    setOpenDocs(prev => ({
      ...prev,
      [id]: { ...prev[id], content, wordCount: content.split(/\s+/).filter(Boolean).length },
    }))
    setUnsavedIds(prev => new Set(prev).add(id))

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      const doc = openDocsRef.current[id]
      if (!doc) return
      try {
        await writeFile(doc.path, content)
        setUnsavedIds(prev => { const s = new Set(prev); s.delete(id); return s })
        setOpenDocs(prev => ({ ...prev, [id]: { ...prev[id], modified: "Just now" } }))
      } catch (err) {
        console.error("Failed to save:", err)
      }
    }, 500)
  }

  const currentDoc = openDocs[activeTabId] ?? null
  const currentProperties = currentDoc
    ? {
        type: "Markdown",
        status: "Draft",
        revisions: 0,
        backlinks: 0,
        created: "—",
        modified: currentDoc.modified,
        id: currentDoc.id,
      }
    : null

  if (!vault && isTauri()) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background">
        <p className="text-zinc-400">No vault open</p>
        <button
          onClick={handleOpenVault}
          className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-5 py-2.5 text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
        >
          <FolderOpen className="size-4" />
          Open Vault
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <HeaderTabs
        tabs={tabs}
        activeTabId={activeTabId}
        unsavedIds={unsavedIds}
        onTabChange={handleTabChange}
        onTabClose={handleTabClose}
        onToggleLeftSidebar={() => setIsLeftSidebarOpen(v => !v)}
        onToggleRightSidebar={() => setIsRightSidebarOpen(v => !v)}
        isLeftSidebarOpen={isLeftSidebarOpen}
        isRightSidebarOpen={isRightSidebarOpen}
      />

      <div className="flex flex-1 overflow-hidden">
        {isLeftSidebarOpen && (
          <AppSidebar
            treeItems={treeItems}
            selectedId={selectedId}
            vault={vault}
            onSelect={handleSelect}
            onOpenVault={handleOpenVault}
            onTreeChange={setTreeItems}
            onRename={handleRenameFile}
            onDelete={handleDeleteFile}
            onNewFile={handleNewFileIn}
          />
        )}

        <main className="flex flex-1 overflow-hidden">
          <DocumentEditor document={currentDoc} onContentChange={handleContentChange} />
        </main>

        {isRightSidebarOpen && (
          <PropertiesPanel
            properties={currentProperties}
            wordCount={currentDoc?.wordCount ?? 0}
          />
        )}
      </div>
    </div>
  )
}
