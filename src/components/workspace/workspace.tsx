"use client"

import * as React from "react"
import { FolderOpen } from "lucide-react"
import { ActivityBar } from "./activity-bar"
import { PanelHost } from "./panel-host"
import { GraphTabView } from "./graph-tab-view"
import {
  DEFAULT_BUTTONS,
  buttonsForSide,
  findButtonDef,
  loadActiveBySide,
  loadButtons,
  saveActiveBySide,
  saveButtons,
  type ActionContext,
  type ActivityButton,
  type PanelId,
  type PanelRenderProps,
  type Side,
} from "./panel-registry"
import { useActivityDnD } from "./use-activity-dnd"

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
import { DocumentEditor, type DocumentViewMode } from "./document-editor"
import { HeaderTabs, type HeaderTab } from "./header-tabs"
import { QuickOpenModal } from "./quick-open-modal"
import type { TreeItem } from "./sidebar-tree"
import type { VaultRecord } from "./workspace-picker"
import {
  isTauri,
  openVault,
  readFile,
  writeFile,
  readNote,
  writeNote,
  loadVaultData,
  getNoteMetadata,
  getLinkGraph,
  createNote,
  createFolder,
  renameItem,
  deleteItem,
  moveItem,
  createLayer,
  unlinkLayer,
  deleteLayer,
  noteLayers,
  type NoteLayers,
  openInExplorer,
  type FsMutationResult,
  type LayerKind,
  type LinkGraph,
  type LinkGraphNode,
  type LinkGraphEdge,
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

type TabKind = "document" | "graph"

interface Tab {
  key: string
  kind: TabKind
  fileId: string
  title: string
  history: string[]
  historyIndex: number
}

const GRAPH_TAB_FILE_ID = "__graph__"

type EditorLayer = "editor" | LayerKind

const WIKI_LINK_RE = /\[\[([^\]\r\n]+)\]\]/gu

function normalizeWikiLinkTarget(raw: string): string {
  return raw
    .split("|")[0]
    .split("#")[0]
    .trim()
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
}

function normalizeLookup(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase()
}

function extractWikiLinks(content: string): Array<{ raw: string; target: string; label: string }> {
  const links: Array<{ raw: string; target: string; label: string }> = []
  WIKI_LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WIKI_LINK_RE.exec(content)) !== null) {
    const raw = m[1]
    const [targetPart, aliasPart] = raw.split("|")
    const target = normalizeWikiLinkTarget(targetPart ?? "")
    if (!target) continue
    links.push({ raw, target, label: (aliasPart ?? targetPart ?? target).trim() || target })
  }
  return links
}

function flattenFileItems(items: TreeItem[]): TreeItem[] {
  const files: TreeItem[] = []
  function walk(list: TreeItem[]) {
    for (const item of list) {
      if (item.type === "file") files.push(item)
      if (item.children) walk(item.children)
    }
  }
  walk(items)
  return files
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

function remapStoredId(id: string, pathToId: Record<string, string>): string {
  return pathToId[id] ?? id
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

function findWikiLinkItem(items: TreeItem[], target: string, vault: string | null): TreeItem | null {
  const normalizedTarget = normalizeLookup(normalizeWikiLinkTarget(target))
  if (!normalizedTarget) return null
  const normalizedVault = vault?.replace(/\\/g, "/") ?? ""

  function walk(list: TreeItem[]): TreeItem | null {
    for (const item of list) {
      if (item.type === "file") {
        const id = (item.path ?? item.id).replace(/\\/g, "/")
        const relativePath = normalizedVault && id.startsWith(normalizedVault + "/")
          ? id.slice(normalizedVault.length + 1)
          : id.split("/").pop() ?? id
        const pathWithoutExt = relativePath.replace(/\.md$/i, "")
        if (normalizeLookup(item.name) === normalizedTarget || normalizeLookup(pathWithoutExt) === normalizedTarget) {
          return item
        }
      }
      if (item.children) {
        const found = walk(item.children)
        if (found) return found
      }
    }
    return null
  }

  return walk(items)
}

function buildLinkGraph(items: TreeItem[], contents: Record<string, string>, vault: string | null): LinkGraph {
  const files = flattenFileItems(items)
  const nodes = new Map<string, LinkGraphNode>()
  const edges: LinkGraphEdge[] = []

  for (const file of files) nodes.set(file.id, { id: file.id, label: file.name })

  for (const file of files) {
    const content = contents[file.id] ?? ""
    for (const link of extractWikiLinks(content)) {
      const targetItem = findWikiLinkItem(items, link.target, vault)
      const targetId = targetItem?.id ?? `missing:${normalizeLookup(link.target)}`
      if (!nodes.has(targetId)) nodes.set(targetId, { id: targetId, label: link.target, unresolved: true })
      edges.push({ source: file.id, target: targetId, label: link.label, unresolved: !targetItem })
    }
  }

  return { nodes: [...nodes.values()], edges }
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
  const [linkGraph, setLinkGraph] = React.useState<LinkGraph>({ nodes: [], edges: [] })
  const [activeLayers, setActiveLayers] = React.useState<Record<string, EditorLayer>>({})
  const [viewModes, setViewModes] = React.useState<Record<string, DocumentViewMode>>({})
  const [linkedLayersByDoc, setLinkedLayersByDoc] = React.useState<Record<string, NoteLayers>>({})
  const [lockedFileIds, setLockedFileIds] = React.useState<Set<string>>(new Set())

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
        // 44px activity bar + 20px threshold inside the panel.
        return side === "left" ? x < 44 + 20 : x > window.innerWidth - 44 - 20
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
  const [activityButtons, setActivityButtons] = React.useState<ActivityButton[]>(
    () => loadButtons() ?? DEFAULT_BUTTONS,
  )
  const [activeBySide, setActiveBySide] = React.useState<Record<Side, PanelId | null>>(
    () => loadActiveBySide() ?? { left: "files", right: "info" },
  )
  React.useEffect(() => { saveButtons(activityButtons) }, [activityButtons])
  React.useEffect(() => { saveActiveBySide(activeBySide) }, [activeBySide])
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
    if (!vault) { setLinkGraph({ nodes: [], edges: [] }); return }
    let cancelled = false
    const timer = setTimeout(async () => {
      if (isTauri()) {
        try {
          const graph = await getLinkGraph(vault)
          if (!cancelled) setLinkGraph(graph)
        } catch { /* index may be rebuilding */ }
        return
      }
      const files = flattenFileItems(treeItems)
      const contents: Record<string, string> = {}
      await Promise.allSettled(files.map(async file => {
        contents[file.id] = openDocsRef.current[file.id]?.content ?? await readFile(file.id)
      }))
      if (!cancelled) setLinkGraph(buildLinkGraph(treeItems, contents, vault))
    }, 150)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [treeItems, openDocs, vault])

  React.useEffect(() => {
    if (!vault || tabs.length === 0) return
    // Only persist document tabs (graph tab is ephemeral).
    const docTabs = tabs.filter(t => t.kind === "document")
    const entries = docTabs.map(t => ({ fileId: t.fileId, title: t.title }))
    const active = docTabs.find(t => t.key === activeTabKey)
    localStorage.setItem(`amby:tabs:${vault}`, JSON.stringify({
      entries,
      activeFileId: active?.fileId ?? entries[0]?.fileId ?? "",
    }))
  }, [tabs, activeTabKey, vault])

  const activeTab = tabs.find(t => t.key === activeTabKey) ?? null
  const selectedId = activeTab && activeTab.kind === "document" ? activeTab.fileId : ""
  const canGoBack = (activeTab?.historyIndex ?? 0) > 0
  const canGoForward = activeTab ? activeTab.historyIndex < activeTab.history.length - 1 : false

  function openGraphTab() {
    const existing = tabs.find(t => t.kind === "graph")
    if (existing) {
      setActiveTabKey(existing.key)
      return
    }
    const key = newTabKey()
    setTabs(prev => [...prev, {
      key, kind: "graph", fileId: GRAPH_TAB_FILE_ID,
      title: "Граф связей", history: [], historyIndex: 0,
    }])
    setActiveTabKey(key)
  }

  async function refreshVault() {
    if (!vault) return
    try { await refreshTree(vault) } catch { /* ignore */ }
  }

  const actionContext: ActionContext = { openGraphTab, refreshVault }

  // Move a button to the opposite side (appended to that side's end).
  function moveButtonToSide(defId: string, targetSide: Side) {
    setActivityButtons(prev => {
      const button = prev.find(b => b.defId === defId)
      if (!button) return prev
      if (button.side === targetSide) return prev
      const targetOrders = prev.filter(b => b.side === targetSide).map(b => b.order)
      const nextOrder = targetOrders.length ? Math.max(...targetOrders) + 1 : 0
      return prev.map(b => b.defId === defId ? { ...b, side: targetSide, order: nextOrder } : b)
    })
    setActiveBySide(prev => {
      const next = { ...prev }
      // If this view was active on its old side, fall back.
      const def = findButtonDef(defId)
      if (def?.kind === "view") {
        const otherSide: Side = targetSide === "left" ? "right" : "left"
        if (prev[otherSide] === defId) {
          const remaining = activityButtons
            .filter(b => b.side === otherSide && b.defId !== defId)
            .sort((a, b) => a.order - b.order)
          const firstView = remaining.find(b => findButtonDef(b.defId)?.kind === "view")
          next[otherSide] = (firstView?.defId as PanelId | undefined) ?? null
        }
        // Optionally make the moved view active on its new side.
        next[targetSide] = def.id
      }
      return next
    })
  }

  // Drop handler: place defId on `targetSide` before `beforeDefId` (or at end).
  function reorderButton(defId: string, targetSide: Side, beforeDefId: string | "__end__") {
    setActivityButtons(prev => {
      const moving = prev.find(b => b.defId === defId)
      if (!moving) return prev
      // Build the target-side list without the moving button, sorted by current order.
      const others = prev
        .filter(b => b.side === targetSide && b.defId !== defId)
        .sort((a, b) => a.order - b.order)
      let insertAt = others.length
      if (beforeDefId !== "__end__") {
        const idx = others.findIndex(b => b.defId === beforeDefId)
        if (idx >= 0) insertAt = idx
      }
      const reorderedTarget = [
        ...others.slice(0, insertAt),
        { ...moving, side: targetSide },
        ...others.slice(insertAt),
      ].map((b, i) => ({ ...b, order: i }))
      const oppositeSide: Side = targetSide === "left" ? "right" : "left"
      const opposite = prev
        .filter(b => b.side === oppositeSide && b.defId !== defId)
        .sort((a, b) => a.order - b.order)
        .map((b, i) => ({ ...b, order: i }))
      return [...reorderedTarget, ...opposite]
    })
    // Cross-side fallback for active view
    const movingDef = findButtonDef(defId)
    if (movingDef?.kind === "view") {
      const oldSide: Side = activityButtons.find(b => b.defId === defId)?.side ?? targetSide
      if (oldSide !== targetSide) {
        setActiveBySide(prev => {
          const next = { ...prev }
          if (prev[oldSide] === defId) {
            const remaining = activityButtons
              .filter(b => b.side === oldSide && b.defId !== defId)
              .sort((a, b) => a.order - b.order)
            const firstView = remaining.find(b => findButtonDef(b.defId)?.kind === "view")
            next[oldSide] = (firstView?.defId as PanelId | undefined) ?? null
          }
          next[targetSide] = (movingDef.id as PanelId)
          return next
        })
      }
    }
  }

  const dnd = useActivityDnD({ onDrop: reorderButton })

  function handleActivate(defId: string) {
    const def = findButtonDef(defId)
    if (!def) return
    if (def.kind === "action") {
      def.invoke(actionContext)
      return
    }
    const button = activityButtons.find(b => b.defId === defId)
    if (!button) return
    const side = button.side
    const isOpen = side === "left" ? isLeftSidebarOpen : isRightSidebarOpen
    const setOpen = side === "left" ? setIsLeftSidebarOpen : setIsRightSidebarOpen
    // Click on already-active view collapses the panel.
    if (isOpen && activeBySide[side] === def.id) {
      setOpen(false)
      return
    }
    setActiveBySide(prev => ({ ...prev, [side]: def.id }))
    setOpen(true)
  }

  function activatePanelAnywhere(panelId: PanelId) {
    const button = activityButtons.find(b => b.defId === panelId)
    if (!button) return
    if (button.side === "left") setIsLeftSidebarOpen(true)
    else setIsRightSidebarOpen(true)
    setActiveBySide(prev => ({ ...prev, [button.side]: panelId }))
  }

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

  function saveViewModes(path: string | null, next: Record<string, DocumentViewMode>) {
    setViewModes(next)
    if (path) localStorage.setItem(`amby:view-modes:${path}`, JSON.stringify(next))
  }

  function saveLockedFileIds(path: string | null, next: Set<string>) {
    setLockedFileIds(next)
    if (path) localStorage.setItem(`amby:locked:${path}`, JSON.stringify([...next]))
  }

  async function refreshLinkedLayers(docId: string, notePath: string) {
    try {
      const layers = await noteLayers(notePath)
      setLinkedLayersByDoc(prev => ({ ...prev, [docId]: layers }))
    } catch (err) {
      console.error("Failed to load note layers:", err)
    }
  }

  async function refreshTree(path = vault) {
    if (!path) return []
    const loaded = await loadVaultData(path)
    setTreeItems(loaded.tree)
    return loaded.tree
  }

  function remapPath(path: string, changes: FsMutationResult["pathChanges"]): string {
    const exact = changes.find(change => change.oldPath && change.oldPath === path)
    return exact?.newPath ?? path
  }

  function applyMutationResult(result: FsMutationResult) {
    const changes = result.pathChanges.filter(change => change.oldPath && change.newPath)
    const deleted = new Set(result.deletedIds ?? result.deletedPaths)

    if (changes.length > 0 || deleted.size > 0) {
      setOpenDocs(prev => {
        const next: Record<string, Document> = {}
        for (const [id, doc] of Object.entries(prev)) {
          if (deleted.has(id)) continue
          next[id] = { ...doc, path: remapPath(doc.path, changes) }
        }
        return next
      })

      setTabs(prev => {
        const next = prev
          .filter(tab => !deleted.has(tab.fileId))
          .map(tab => ({
            ...tab,
            fileId: tab.fileId,
            history: tab.history
              .filter(path => !deleted.has(path))
              .map(path => path),
          }))
        if (next.length !== prev.length && activeTabKey) {
          const stillExists = next.find(tab => tab.key === activeTabKey)
          if (!stillExists) setActiveTabKey(next[next.length - 1]?.key ?? "")
        }
        return next
      })

      setFavorites(prev => {
        const next = new Set<string>()
        for (const id of prev) if (!deleted.has(id)) next.add(id)
        if (vault) localStorage.setItem(`amby:favorites:${vault}`, JSON.stringify([...next]))
        return next
      })

      setIconOverrides(prev => {
        const next: Record<string, string> = {}
        for (const [id, icon] of Object.entries(prev)) {
          if (!deleted.has(id)) next[id] = icon
        }
        localStorage.setItem("amby:icons", JSON.stringify(next))
        return next
      })

      setActiveLayers(prev => {
        const next: Record<string, EditorLayer> = {}
        for (const [id, layer] of Object.entries(prev)) {
          if (!deleted.has(id)) next[id] = layer
        }
        return next
      })

      setViewModes(prev => {
        const next: Record<string, DocumentViewMode> = {}
        for (const [id, mode] of Object.entries(prev)) {
          if (!deleted.has(id)) next[id] = mode
        }
        if (vault) localStorage.setItem(`amby:view-modes:${vault}`, JSON.stringify(next))
        return next
      })

      setUnsavedFileIds(prev => {
        const next = new Set<string>()
        for (const id of prev) {
          if (!deleted.has(id)) next.add(id)
        }
        return next
      })
    }
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
          await refreshTree(vault)
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
      const loaded = await loadVaultData(path)
      const tree = loaded.tree
      const pathToId = loaded.sync.pathToId ?? {}
      const allIds = flattenTree(tree)
      setVault(path)
      setTreeItems(tree)
      localStorage.setItem("amby:vault", path)
      addVaultToList(path)

      setIconOverrides(prev => {
        const next: Record<string, string> = {}
        for (const [id, icon] of Object.entries(prev)) {
          const nextId = remapStoredId(id, pathToId)
          next[nextId] = icon
        }
        localStorage.setItem("amby:icons", JSON.stringify(next))
        return next
      })

      // Restore favorites
      try {
        const savedFavs = localStorage.getItem(`amby:favorites:${path}`)
        const favs = savedFavs ? JSON.parse(savedFavs) as string[] : []
        const next = new Set(favs.map(id => remapStoredId(id, pathToId)).filter(id => allIds.has(id)))
        setFavorites(next)
        localStorage.setItem(`amby:favorites:${path}`, JSON.stringify([...next]))
      } catch { setFavorites(new Set()) }

      // Restore per-note editor view modes
      try {
        const savedModes = localStorage.getItem(`amby:view-modes:${path}`)
        const modes = savedModes ? JSON.parse(savedModes) as Record<string, DocumentViewMode> : {}
        const next: Record<string, DocumentViewMode> = {}
        for (const [id, mode] of Object.entries(modes)) {
          const nextId = remapStoredId(id, pathToId)
          if (allIds.has(nextId)) next[nextId] = mode
        }
        setViewModes(next)
        localStorage.setItem(`amby:view-modes:${path}`, JSON.stringify(next))
      } catch { setViewModes({}) }

      // Restore locked notes
      try {
        const savedLocked = localStorage.getItem(`amby:locked:${path}`)
        const ids = savedLocked ? JSON.parse(savedLocked) as string[] : []
        const next = new Set(
          ids.map(id => remapStoredId(id, pathToId)).filter(id => allIds.has(id)),
        )
        setLockedFileIds(next)
        localStorage.setItem(`amby:locked:${path}`, JSON.stringify([...next]))
      } catch { setLockedFileIds(new Set()) }

      // Restore open tabs
      try {
        const savedTabs = localStorage.getItem(`amby:tabs:${path}`)
        if (savedTabs) {
          const { entries, activeFileId } = JSON.parse(savedTabs) as {
            entries: { fileId: string; title: string }[]
            activeFileId: string
          }
          const mappedEntries = entries.map(e => ({ ...e, fileId: remapStoredId(e.fileId, pathToId) }))
          const mappedActiveFileId = remapStoredId(activeFileId, pathToId)
          const valid = mappedEntries.filter(e => allIds.has(e.fileId))
          if (valid.length > 0) {
            const newTabs: Tab[] = valid.map(e => ({
              key: newTabKey(), kind: "document" as const, fileId: e.fileId, title: e.title,
              history: [e.fileId], historyIndex: 0,
            }))
            setTabs(newTabs)
            const activeTab = newTabs.find(t => t.fileId === mappedActiveFileId) ?? newTabs[0]
            setActiveTabKey(activeTab.key)
            // Load docs for restored tabs
            valid.forEach(e => {
              const item = findTreeItem(tree, e.fileId)
              readNote(path, e.fileId).then(content => {
                setOpenDocs(prev => ({
                  ...prev,
                  [e.fileId]: { id: e.fileId, title: e.title, content, modified: "", wordCount: 0, path: item?.path ?? e.fileId },
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
    const item = findTreeItem(treeItems, fileId)
    const [content, meta] = vault
      ? await Promise.all([readNote(vault, fileId), getNoteMetadata(vault, fileId)])
      : await Promise.all([readFile(item?.path ?? fileId), getNoteMetadata("", fileId)])
    const doc: Document = {
      id: fileId, title: itemName, content,
      modified: formatModified(meta.modified),
      wordCount: meta.word_count, path: item?.path ?? fileId,
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

    const active = tabs.find(t => t.key === activeTabKey)
    // If active tab is graph, don't overwrite — open a fresh document tab instead.
    if (active && active.kind === "document") {
      setTabs(prev => prev.map(t => {
        if (t.key !== activeTabKey) return t
        const newHistory = [...t.history.slice(0, t.historyIndex + 1), fileId]
        return { ...t, fileId, title: item.name, history: newHistory, historyIndex: newHistory.length - 1 }
      }))
    } else {
      const key = newTabKey()
      setTabs(prev => [...prev, { key, kind: "document", fileId, title: item.name, history: [fileId], historyIndex: 0 }])
      setActiveTabKey(key)
    }
  }

  const handleWikiLinkClick = async (rawTarget: string) => {
    if (!vault) return
    const target = normalizeWikiLinkTarget(rawTarget)
    if (!target) return

    const existing = findWikiLinkItem(treeItems, target, vault)
    if (existing) {
      await handleSelect(existing.id)
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
      const doc: Document = { id, title: name, content: "", modified: "Только что", wordCount: 0, path: item?.path ?? result.primaryPath ?? id }
      setOpenDocs(prev => ({ ...prev, [id]: doc }))
      const key = newTabKey()
      setTabs(prev => [...prev, { key, kind: "document", fileId: id, title: name, history: [id], historyIndex: 0 }])
      setActiveTabKey(key)
    } catch (err) {
      console.error("Failed to open wiki link:", err)
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
    setTabs(prev => [...prev, { key, kind: "document", fileId, title: item.name, history: [fileId], historyIndex: 0 }])
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

  const handleRenameFile = async (id: string, newName: string) => {
    const item = findTreeItem(treeItems, id)
    if (!item) return
    try {
      const result = await renameItem(vault ?? "", item.path ?? id, newName)
      applyMutationResult(result)
      const newPath = result.primaryPath ?? item.path ?? id
      setOpenDocs(prev => prev[id] ? ({
        ...prev,
        [id]: { ...prev[id], title: newName, path: newPath },
      }) : prev)
      setTabs(prev => prev.map(t => t.fileId === id ? { ...t, title: newName } : t))
      await refreshTree()
    } catch (err) {
      console.error("Failed to rename:", err)
    }
  }

  const handleDeleteFile = async (id: string) => {
    const item = findTreeItem(treeItems, id)
    if (!confirm(`Удалить "${item?.name ?? id}"?`)) return
    try {
      const result = await deleteItem(vault ?? "", item?.path ?? id)
      applyMutationResult(result)
      await refreshTree()
    } catch (err) {
      console.error("Failed to delete:", err)
    }
  }

  const handleNewFileIn = async (parentId: string | null) => {
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
      const doc: Document = { id, title: "Untitled", content: "", modified: "Только что", wordCount: 0, path: item?.path ?? result.primaryPath ?? id }
      setOpenDocs(prev => ({ ...prev, [id]: doc }))
      const key = newTabKey()
      setTabs(prev => [...prev, { key, kind: "document", fileId: id, title: "Untitled", history: [id], historyIndex: 0 }])
      setActiveTabKey(key)
      setPendingRenameId(id)
      setTimeout(() => setPendingRenameId(null), 500)
    } catch (err) {
      console.error("Failed to create file:", err)
    }
  }

  const handleNewFolderIn = async (parentId: string | null) => {
    if (!vault) return
    const basePath = parentId ?? vault
    const parent = parentId ? findTreeItem(treeItems, parentId) : null
    try {
      const path = await createFolder(parent?.path ?? basePath, "Untitled")
      const newItem: TreeItem = { id: `folder:${path}`, path, name: "Untitled", type: "folder", icon: "folder", children: [] }
      if (parentId) {
        setTreeItems(prev => updateInTree(prev, parentId, folder => ({
          ...folder, children: [...(folder.children ?? []), newItem],
        })))
      } else {
        setTreeItems(prev => [...prev, newItem])
      }
      setPendingRenameId(newItem.id)
      setTimeout(() => setPendingRenameId(null), 500)
    } catch (err) {
      console.error("Failed to create folder:", err)
    }
  }

  const handleMoveItem = async (sourceId: string, targetFolderId: string | null) => {
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
    const sourceRoot = sourceItem.type === "file" && basename(sourceParent) === stem(normSrc)
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
  }

  const handleLayerChange = async (layer: EditorLayer) => {
    const doc = activeTab ? openDocs[activeTab.fileId] ?? null : null
    if (!doc) return
    if (layer === "editor") {
      setActiveLayers(prev => ({ ...prev, [doc.id]: "editor" }))
      return
    }
    try {
      const result = await createLayer(doc.path, layer)
      applyMutationResult({
        primaryPath: result.notePath,
        pathChanges: result.pathChanges,
        deletedPaths: [],
      })
      setActiveLayers(prev => ({ ...prev, [doc.id]: layer }))
      await refreshTree()
      await refreshLinkedLayers(doc.id, result.notePath ?? doc.path)
    } catch (err) {
      console.error("Failed to create layer:", err)
    }
  }

  const handleViewModeChange = (mode: DocumentViewMode) => {
    if (!currentDoc) return
    saveViewModes(vault, { ...viewModes, [currentDoc.id]: mode })
  }

  const handleToggleLock = () => {
    if (!currentDoc) return
    const next = new Set(lockedFileIds)
    if (next.has(currentDoc.id)) next.delete(currentDoc.id); else next.add(currentDoc.id)
    saveLockedFileIds(vault, next)
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
        if (vault) await writeNote(vault, doc.id, content)
        else await writeFile(doc.path, content)
        setUnsavedFileIds(prev => { const s = new Set(prev); s.delete(fileId); return s })
        setOpenDocs(prev => ({ ...prev, [fileId]: { ...prev[fileId], modified: "Только что" } }))
      } catch (err) {
        console.error("Failed to save:", err)
      }
    }, 500)
  }

  const currentDoc = activeTab ? openDocs[activeTab.fileId] ?? null : null

  React.useEffect(() => {
    if (!currentDoc) return
    if (linkedLayersByDoc[currentDoc.id]) return
    refreshLinkedLayers(currentDoc.id, currentDoc.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDoc?.id, currentDoc?.path])

  const currentProperties = currentDoc ? {
    type: "Markdown", status: "Draft", revisions: 0, backlinks: linkGraph.edges.filter(e => e.target === currentDoc.id).length,
    created: "—", modified: currentDoc.modified, id: currentDoc.id,
  } : null

  const headerTabs: HeaderTab[] = tabs.map(t => ({ key: t.key, fileId: t.fileId, title: t.title }))

  const handleAttachLayerToFile = async (fileId: string, layer: "canvas" | "database") => {
    // Find the file path from the flat tree
    function findPath(items: typeof treeItems): string | null {
      for (const item of items) {
        if (item.id === fileId && item.type === "file") return item.path
        if (item.children) {
          const found = findPath(item.children)
          if (found) return found
        }
      }
      return null
    }
    const filePath = findPath(treeItems)
    if (!filePath) return
    try {
      const result = await createLayer(filePath, layer)
      applyMutationResult({
        primaryPath: result.notePath,
        pathChanges: result.pathChanges,
        deletedPaths: [],
      })
      await refreshTree()
      await refreshLinkedLayers(fileId, result.notePath ?? filePath)
    } catch (err) {
      console.error("Failed to attach layer:", err)
    }
  }

  const handleUnlinkLayer = async (layer: LayerKind) => {
    if (!currentDoc || !vault) return
    try {
      const result = await unlinkLayer(vault, currentDoc.path, layer)
      applyMutationResult(result)
      await refreshTree()
      await refreshLinkedLayers(currentDoc.id, result.primaryPath ?? currentDoc.path)
      // If the unlinked layer was active, fall back to the editor.
      setActiveLayers(prev => (prev[currentDoc.id] === layer ? { ...prev, [currentDoc.id]: "editor" } : prev))
    } catch (err) {
      console.error("Failed to unlink layer:", err)
    }
  }

  const handleDeleteLayer = async (layer: LayerKind) => {
    if (!currentDoc || !vault) return
    const labels: Record<LayerKind, string> = { canvas: "Canvas", database: "базу данных", sketch: "Excalidraw" }
    if (!confirm(`Удалить ${labels[layer]} у заметки "${currentDoc.title}"? Файл переедет в корзину.`)) return
    try {
      const result = await deleteLayer(vault, currentDoc.path, layer)
      applyMutationResult(result)
      await refreshTree()
      await refreshLinkedLayers(currentDoc.id, result.primaryPath ?? currentDoc.path)
      setActiveLayers(prev => (prev[currentDoc.id] === layer ? { ...prev, [currentDoc.id]: "editor" } : prev))
    } catch (err) {
      console.error("Failed to delete layer:", err)
    }
  }

  const panelRenderProps: PanelRenderProps = {
    treeItems: displayTreeItems,
    selectedId,
    vault,
    onSelect: handleSelect,
    onOpenVault: handleOpenVault,
    onRename: handleRenameFile,
    onDelete: handleDeleteFile,
    onNewFile: handleNewFileIn,
    onNewFolder: handleNewFolderIn,
    onOpenInNewTab: handleOpenInNewTab,
    onOpenInExplorer: openInExplorer,
    onMoveItem: handleMoveItem,
    onSetIcon: handleSetIcon,
    triggerRenameId: pendingRenameId,
    readFile: (id: string) => vault ? readNote(vault, id) : readFile(id),
    favorites,
    onToggleFavorite: handleToggleFavorite,
    onAttachLayer: handleAttachLayerToFile,
    linkedLayersByDoc,
    properties: currentProperties,
    linkGraph,
    currentDocId: currentDoc?.id ?? null,
    onSelectLink: handleSelect,
  }

  const leftButtons = buttonsForSide(activityButtons, "left")
  const rightButtons = buttonsForSide(activityButtons, "right")

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
      activatePanelAnywhere("tags")
    },
    onWikiLinkClick: handleWikiLinkClick,
    activeLayer: currentDoc ? activeLayers[currentDoc.id] ?? "editor" : "editor",
    onLayerChange: handleLayerChange,
    viewMode: currentDoc ? viewModes[currentDoc.id] ?? "live" : "live",
    onViewModeChange: handleViewModeChange,
    linkedLayers: currentDoc
      ? linkedLayersByDoc[currentDoc.id] ?? { canvas: false, sketch: false, database: false }
      : { canvas: false, sketch: false, database: false },
    isLocked: currentDoc ? lockedFileIds.has(currentDoc.id) : false,
    onToggleLock: handleToggleLock,
    treeItems: displayTreeItems,
    onOpenItem: handleSelect,
    onUnlinkLayer: handleUnlinkLayer,
    onDeleteLayer: handleDeleteLayer,
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
        {activeTab?.kind === "graph" ? (
          <GraphTabView graph={linkGraph} selectedId={null} onSelect={handleSelect} />
        ) : (
          <DocumentEditor
            {...editorProps}
            isFocusMode={true}
            onToggleFocusMode={handleExitFocusMode}
          />
        )}

        {/* Left sidebar overlay */}
        <div
          className={`fixed left-0 top-0 bottom-0 z-10 flex transition-transform duration-200 ease-out shadow-2xl ${focusShowLeft ? "translate-x-0" : "-translate-x-full"}`}
          onMouseLeave={() => setFocusShowLeft(false)}
        >
          <ActivityBar
            side="left"
            buttons={leftButtons}
            activeView={activeBySide.left}
            onActivate={handleActivate}
            onMoveToOtherSide={defId => moveButtonToSide(defId, "right")}
            onPointerDownButton={dnd.onPointerDown}
            draggingId={dnd.draggingId}
          />
          <div style={{ width: leftWidth }} className="shrink-0">
            <PanelHost side="left" activeId={activeBySide.left} props={panelRenderProps} />
          </div>
        </div>

        {/* Right sidebar overlay */}
        <div
          className={`fixed right-0 top-0 bottom-0 z-10 flex transition-transform duration-200 ease-out shadow-2xl ${focusShowRight ? "translate-x-0" : "translate-x-full"}`}
          onMouseLeave={() => setFocusShowRight(false)}
        >
          <div style={{ width: rightWidth }} className="shrink-0">
            <PanelHost side="right" activeId={activeBySide.right} props={panelRenderProps} />
          </div>
          <ActivityBar
            side="right"
            buttons={rightButtons}
            activeView={activeBySide.right}
            onActivate={handleActivate}
            onMoveToOtherSide={defId => moveButtonToSide(defId, "left")}
            onPointerDownButton={dnd.onPointerDown}
            draggingId={dnd.draggingId}
          />
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
        rightPanelWidth={rightWidth}
        activeFileId={activeTab?.fileId}
        favorites={favorites}
        onToggleFavorite={handleToggleFavorite}
      />

      <div className="flex flex-1 overflow-hidden">
        <ActivityBar
          side="left"
          buttons={leftButtons}
          activeView={activeBySide.left}
          onActivate={handleActivate}
          onMoveToOtherSide={defId => moveButtonToSide(defId, "right")}
          onPointerDownButton={dnd.onPointerDown}
          draggingId={dnd.draggingId}
        />

        {isLeftSidebarOpen && (
          <>
            <div style={{ width: leftWidth }} className="shrink-0">
              <PanelHost side="left" activeId={activeBySide.left} props={panelRenderProps} />
            </div>
            <ResizeHandle onMouseDown={startResize("left")} />
          </>
        )}

        <main className="flex flex-1 overflow-hidden">
          {activeTab?.kind === "graph" ? (
            <GraphTabView graph={linkGraph} selectedId={null} onSelect={handleSelect} />
          ) : (
            <DocumentEditor
              {...editorProps}
              isFocusMode={false}
              onToggleFocusMode={handleEnterFocusMode}
            />
          )}
        </main>

        {isRightSidebarOpen && (
          <>
            <ResizeHandle onMouseDown={startResize("right")} />
            <div style={{ width: rightWidth }} className="shrink-0">
              <PanelHost side="right" activeId={activeBySide.right} props={panelRenderProps} />
            </div>
          </>
        )}

        <ActivityBar
          side="right"
          buttons={rightButtons}
          activeView={activeBySide.right}
          onActivate={handleActivate}
          onMoveToOtherSide={defId => moveButtonToSide(defId, "left")}
          onPointerDownButton={dnd.onPointerDown}
          draggingId={dnd.draggingId}
        />
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
