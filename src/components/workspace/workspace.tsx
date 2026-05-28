"use client"

import * as React from "react"
import { FolderOpen } from "lucide-react"
import { ActivityBar } from "./activity-bar"
import { PanelHost } from "./panel-host"
import { GraphTabView } from "./graph-tab-view"
import { CanvasEditor } from "./canvas-editor"
import {
  buttonsForSide,
  findButtonDef,
  type ActionContext,
  type PanelId,
  type PanelRenderProps,
  type Side,
} from "./panel-registry"
import { usePresets } from "./use-presets"
import { useDocStore, type Document } from "./use-doc-store"
import { useTabsStore, type Tab } from "./use-tabs-store"
import { useVaultStore } from "./use-vault-store"
import { loadSession, loadWorkspaces, saveSession, saveWorkspaces } from "./app-config"
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
import { SearchModal } from "./search-modal"
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
  createCanvasFile,
  attachCanvasToNote,
  unlinkLayer,
  deleteLayer,
  noteLayers,
  type NoteLayers,
  openInExplorer,
  exportTextFile,
  importTextFile,
  type FsMutationResult,
  type LayerKind,
  type LinkGraph,
  type LinkGraphNode,
  type LinkGraphEdge,
} from "@/lib/storage"
import { watch } from "@tauri-apps/plugin-fs"
import { getCurrentWindow } from "@tauri-apps/api/window"

const GRAPH_TAB_FILE_ID = "__graph__"

function wsPathDir(path: string): string {
  const idx = path.replace(/\\/g, "/").lastIndexOf("/")
  return idx === -1 ? "" : path.slice(0, idx)
}

function wsPathBase(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path
}

function wsPathStem(path: string): string {
  return wsPathBase(path).replace(/\.[^.]+$/u, "")
}

/** Path of a note's canvas layer sidecar file (<dir>/<stem>.canvas). */
function canvasLayerPath(notePath: string): string {
  const dir = wsPathDir(notePath)
  const stem = wsPathStem(notePath)
  return `${dir}/${stem}.canvas`
}

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
  const vault = useVaultStore((s) => s.vault)
  const { setVault, setVaults } = useVaultStore.getState()
  const [treeItems, setTreeItems] = React.useState<TreeItem[]>([])
  const openDocs = useDocStore((s) => s.openDocs)
  // Actions are stable in zustand, so read them once without subscribing.
  const { setDoc, patchDoc, clearDocs, markUnsaved, markSaved, applyMutation } =
    useDocStore.getState()
  const tabs = useTabsStore((s) => s.tabs)
  const activeTabKey = useTabsStore((s) => s.activeTabKey)
  const secondaryTabKey = useTabsStore((s) => s.secondaryTabKey)
  // Stable setters (value-or-updater, like setState); see use-tabs-store.
  const { setTabs, setActiveTabKey, setSecondaryTabKey } = useTabsStore.getState()
  const unsavedFileIds = useDocStore((s) => s.unsavedFileIds)
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
  // Raw .canvas JSON keyed by canvas file path (covers both note layers and standalone canvases).
  const [openCanvases, setOpenCanvases] = React.useState<Record<string, string>>({})
  const canvasSaveTimers = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const handleToggleFavorite = React.useCallback((id: string) => {
    setFavorites(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

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

      // Coalesce mousemove updates to one setState per animation frame so dragging
      // doesn't trigger a React re-render on every pixel.
      let frame = 0
      let pendingW = startW

      function onMove(ev: MouseEvent) {
        if (nearEdge(ev.clientX)) return
        pendingW = Math.max(200, Math.min(520, startW + sign * (ev.clientX - startX)))
        if (frame) return
        frame = requestAnimationFrame(() => {
          frame = 0
          setW(pendingW)
        })
      }

      function onUp(ev: MouseEvent) {
        if (frame) {
          cancelAnimationFrame(frame)
          frame = 0
        }
        if (nearEdge(ev.clientX)) {
          setW(208)
          if (side === "left") setIsLeftSidebarOpen(false)
          else setIsRightSidebarOpen(false)
        } else {
          setW(pendingW)
        }
        window.removeEventListener("mousemove", onMove)
        window.removeEventListener("mouseup", onUp)
      }

      window.addEventListener("mousemove", onMove)
      window.addEventListener("mouseup", onUp)
    }
  }
  const [quickOpenOpen, setQuickOpenOpen] = React.useState(false)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [pendingRenameId, setPendingRenameId] = React.useState<string | null>(null)
  const [isFocusMode, setIsFocusMode] = React.useState(false)
  const {
    activityButtons, setActivityButtons,
    activeBySide, setActiveBySide,
    activePresetId, presets, panelScope, setPanelScope,
    switchPreset, importPreset, exportPreset,
  } = usePresets(vault)
  const presetOptions = React.useMemo(
    () => presets.map(p => ({ id: p.id, label: p.label })),
    [presets],
  )

  async function handleExportPreset() {
    const json = exportPreset(activePresetId)
    if (!json) return
    try {
      await exportTextFile(json, `${activePresetId}.amby-preset.json`)
    } catch { /* dialog cancelled / write failed */ }
  }

  async function handleImportPreset() {
    try {
      const text = await importTextFile()
      if (text) importPreset(text, { vault })
    } catch { /* dialog cancelled / unreadable file */ }
  }
  const [focusShowLeft, setFocusShowLeft] = React.useState(false)
  const [focusShowRight, setFocusShowRight] = React.useState(false)
  const preFocusSidebars = React.useRef<{ left: boolean; right: boolean } | null>(null)
  // Hydrated per-vault from session.json when a vault opens (see loadVault).
  const [iconOverrides, setIconOverrides] = React.useState<Record<string, string>>({})
  const vaults = useVaultStore((s) => s.vaults)

  // One debounce timer per open file, so editing or closing one document never
  // cancels another's pending save (also what an editor split relies on).
  const saveTimersRef = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

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
        contents[file.id] = useDocStore.getState().openDocs[file.id]?.content ?? await readFile(file.id)
      }))
      if (!cancelled) setLinkGraph(buildLinkGraph(treeItems, contents, vault))
    }, 150)
    return () => { cancelled = true; clearTimeout(timer) }
  // openDocs intentionally excluded: web-mode already reads via openDocsRef; Tauri-mode
  // fetches from SQLite and doesn't need openDocs at all. Removing it prevents this effect
  // from re-running on every keystroke.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeItems, vault])

  // Debounced persistence of the whole per-vault session (tabs + favorites +
  // view-modes + locked + icons) into {vault}/.amby/session.json. Gated on
  // sessionHydratedRef so applying a freshly-restored session doesn't echo back.
  const sessionHydratedRef = React.useRef(false)
  React.useEffect(() => {
    if (!vault || !sessionHydratedRef.current) return
    const docTabs = tabs.filter(t => t.kind === "document")
    const entries = docTabs.map(t => ({ fileId: t.fileId, title: t.title }))
    const active = docTabs.find(t => t.key === activeTabKey)
    const timer = setTimeout(() => {
      saveSession({
        tabs: entries,
        activeFileId: active?.fileId ?? entries[0]?.fileId ?? "",
        favorites: [...favorites],
        viewModes,
        locked: [...lockedFileIds],
        icons: iconOverrides,
      })
    }, 400)
    return () => clearTimeout(timer)
  }, [vault, tabs, activeTabKey, favorites, viewModes, lockedFileIds, iconOverrides])

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

  function openCanvasTab(path: string, title: string) {
    setOpenCanvases(prev => {
      if (prev[path] !== undefined) return prev
      readFile(path)
        .then(c => setOpenCanvases(p => (p[path] !== undefined ? p : { ...p, [path]: c })))
        .catch(() => setOpenCanvases(p => (p[path] !== undefined ? p : { ...p, [path]: "{}" })))
      return prev
    })
    const existing = tabs.find(t => t.kind === "canvas" && t.fileId === path)
    if (existing) {
      setActiveTabKey(existing.key)
      return
    }
    const key = newTabKey()
    setTabs(prev => [...prev, { key, kind: "canvas", fileId: path, title, history: [], historyIndex: 0 }])
    setActiveTabKey(key)
  }

  async function refreshVault() {
    if (!vault) return
    try { await refreshTree(vault) } catch { /* ignore */ }
  }

  const actionContext: ActionContext = { openGraphTab, refreshVault, openSearch: () => setSearchOpen(true) }

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
  // Memoised so a keystroke (which changes openDocs, not the tree) doesn't produce a
  // fresh array and re-render every sidebar panel via panelRenderProps.
  const displayTreeItems = React.useMemo(
    () => applyIconOverrides(treeItems, iconOverrides),
    [treeItems, iconOverrides],
  )

  // Current file icon (from iconOverrides or tree)
  const activeFileId = activeTab?.fileId ?? null
  const activeTreeItem = activeFileId ? findTreeItem(displayTreeItems, activeFileId) : null
  const currentFileIcon = activeTreeItem?.icon

  const handleSetIcon = React.useCallback((id: string, icon: string) => {
    setIconOverrides(prev => ({ ...prev, [id]: icon }))
  }, [])

  function saveVaults(next: VaultRecord[]) {
    setVaults(next)
  }

  function saveViewModes(_path: string | null, next: Record<string, DocumentViewMode>) {
    setViewModes(next)
  }

  function saveLockedFileIds(_path: string | null, next: Set<string>) {
    setLockedFileIds(next)
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
      applyMutation([...deleted], path => remapPath(path, changes))

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
        return next
      })

      setIconOverrides(prev => {
        const next: Record<string, string> = {}
        for (const [id, icon] of Object.entries(prev)) {
          if (!deleted.has(id)) next[id] = icon
        }
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
        return next
      })

    }
  }

  function addVaultToList(path: string) {
    setVaults(prev => {
      if (prev.find(v => v.path === path)) return prev
      const name = path.replace(/\\/g, "/").split("/").pop() ?? path
      return [...prev, { id: crypto.randomUUID(), name, path }]
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

  // On mount: hydrate the known-vaults list from the global workspaces.json
  // (migrating pre-tier localStorage), then restore the last-opened vault.
  const workspacesHydrated = React.useRef(false)
  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      const file = await loadWorkspaces()
      if (cancelled) return
      setVaults(file.recent)
      workspacesHydrated.current = true
      if (file.lastOpened) loadVault(file.lastOpened)
      else if (!isTauri()) loadVault("web-vault")
    })()
    return () => { cancelled = true }
  }, [])

  // Persist the known-vaults list + last-opened together (after hydration, so we
  // never clobber the file with the empty initial state).
  React.useEffect(() => {
    if (!workspacesHydrated.current) return
    saveWorkspaces({ recent: vaults, lastOpened: vault })
  }, [vaults, vault])

  async function loadVault(path: string) {
    try {
      const loaded = await loadVaultData(path)
      const tree = loaded.tree
      const pathToId = loaded.sync.pathToId ?? {}
      const allIds = flattenTree(tree)
      setVault(path)
      setTreeItems(tree)
      addVaultToList(path)

      // Restore the per-vault session from {vault}/.amby/session.json (migrating
      // pre-tier localStorage on first read). Suppress session persistence until
      // the restored state is applied, so we don't immediately overwrite the file.
      sessionHydratedRef.current = false
      const session = await loadSession(path)

      setIconOverrides(() => {
        const next: Record<string, string> = {}
        for (const [id, icon] of Object.entries(session.icons)) {
          next[remapStoredId(id, pathToId)] = icon
        }
        return next
      })

      setFavorites(
        new Set(session.favorites.map(id => remapStoredId(id, pathToId)).filter(id => allIds.has(id))),
      )

      {
        const next: Record<string, DocumentViewMode> = {}
        for (const [id, mode] of Object.entries(session.viewModes)) {
          const nextId = remapStoredId(id, pathToId)
          if (allIds.has(nextId)) next[nextId] = mode as DocumentViewMode
        }
        setViewModes(next)
      }

      setLockedFileIds(
        new Set(session.locked.map(id => remapStoredId(id, pathToId)).filter(id => allIds.has(id))),
      )

      // Restore open tabs
      const mappedEntries = session.tabs.map(e => ({ ...e, fileId: remapStoredId(e.fileId, pathToId) }))
      const mappedActiveFileId = remapStoredId(session.activeFileId, pathToId)
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
            setDoc(e.fileId, { id: e.fileId, title: e.title, content, modified: "", wordCount: 0, path: item?.path ?? e.fileId })
          }).catch(() => {})
        })
      } else {
        setTabs([])
        clearDocs()
        setActiveTabKey("")
      }
      sessionHydratedRef.current = true
    } catch (err) {
      console.error("Failed to load vault:", err)
    }
  }

  const handleOpenVault = React.useCallback(async () => {
    const path = await openVault()
    if (path) loadVault(path)
  // loadVault reads vault via closure but is stable (defined once in module scope via
  // async function declaration — does not close over changing state after our ref fixes).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadDoc(fileId: string, itemName: string): Promise<Document> {
    // Use the ref so this function doesn't close over the openDocs state value and can
    // be stabilised later with useCallback without causing stale-closure issues.
    if (useDocStore.getState().openDocs[fileId]) return useDocStore.getState().openDocs[fileId]
    const item = findTreeItem(treeItems, fileId)
    const [content, meta] = vault
      ? await Promise.all([readNote(vault, fileId), getNoteMetadata(vault, fileId)])
      : await Promise.all([readFile(item?.path ?? fileId), getNoteMetadata("", fileId)])
    const doc: Document = {
      id: fileId, title: itemName, content,
      modified: formatModified(meta.modified),
      wordCount: meta.word_count, path: item?.path ?? fileId,
    }
    setDoc(fileId, doc)
    return doc
  }

  const handleSelect = React.useCallback(async (fileId: string) => {
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
  // loadDoc uses openDocsRef internally — safe to exclude openDocs from deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeItems, tabs, activeTabKey])

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
      setDoc(id, doc)
      const key = newTabKey()
      setTabs(prev => [...prev, { key, kind: "document", fileId: id, title: name, history: [id], historyIndex: 0 }])
      setActiveTabKey(key)
    } catch (err) {
      console.error("Failed to open wiki link:", err)
    }
  }

  const handleOpenInNewTab = React.useCallback(async (fileId: string) => {
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
    setTabs(prev => [...prev, { key, kind: "document", fileId, title: item.name, history: [fileId], historyIndex: 0 }])
    setActiveTabKey(key)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeItems])

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

  // Toggle the editor split: pin the active document into a second pane, or
  // collapse back to a single pane.
  function toggleSplit() {
    setSecondaryTabKey(prev =>
      prev ? null : activeTab?.kind === "document" ? activeTabKey : null,
    )
  }

  const handleTabClose = (key: string) => {
    const closing = tabs.find(t => t.key === key)
    if (closing) {
      const timer = saveTimersRef.current.get(closing.fileId)
      if (timer) { clearTimeout(timer); saveTimersRef.current.delete(closing.fileId) }
    }
    if (secondaryTabKey === key) setSecondaryTabKey(null)
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

  const handleRenameFile = React.useCallback(async (id: string, newName: string) => {
    const item = findTreeItem(treeItems, id)
    if (!item) return
    try {
      const result = await renameItem(vault ?? "", item.path ?? id, newName)
      applyMutationResult(result)
      const newPath = result.primaryPath ?? item.path ?? id
      patchDoc(id, { title: newName, path: newPath })
      setTabs(prev => prev.map(t => t.fileId === id ? { ...t, title: newName } : t))
      await refreshTree()
    } catch (err) {
      console.error("Failed to rename:", err)
    }
  // applyMutationResult closes over setters (stable); refreshTree closes over vault via
  // closure but vault is in deps. activeTabKey excluded — uses functional setTabs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeItems, vault])

  const handleDeleteFile = React.useCallback(async (id: string) => {
    const item = findTreeItem(treeItems, id)
    if (!confirm(`Удалить "${item?.name ?? id}"?`)) return
    try {
      const result = await deleteItem(vault ?? "", item?.path ?? id)
      applyMutationResult(result)
      await refreshTree()
    } catch (err) {
      console.error("Failed to delete:", err)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeItems, vault])

  const handleNewFileIn = React.useCallback(async (parentId: string | null) => {
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
      setDoc(id, doc)
      const key = newTabKey()
      setTabs(prev => [...prev, { key, kind: "document", fileId: id, title: "Untitled", history: [id], historyIndex: 0 }])
      setActiveTabKey(key)
      setPendingRenameId(id)
      setTimeout(() => setPendingRenameId(null), 500)
    } catch (err) {
      console.error("Failed to create file:", err)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, treeItems])

  const handleNewFolderIn = React.useCallback(async (parentId: string | null) => {
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
  // updateInTree is a pure helper (stable); eslint disabled to avoid listing it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, treeItems])

  const handleNewCanvasIn = async (parentId: string | null) => {
    if (!vault) return
    const parent = parentId ? findTreeItem(treeItems, parentId) : null
    try {
      const path = await createCanvasFile(vault, parent?.path ?? parentId ?? null, "Untitled")
      await refreshTree()
      setOpenCanvases(prev => ({ ...prev, [path]: "{}\n" }))
      const title = wsPathStem(path)
      const key = newTabKey()
      setTabs(prev => [...prev, { key, kind: "canvas", fileId: path, title, history: [], historyIndex: 0 }])
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
      setTabs(prev => prev.filter(t => !(t.kind === "canvas" && t.fileId === canvasPath)))
      const notePath = result.primaryPath
      if (!notePath) return
      // Resolve the new note's tree id (ULID in Tauri) by path.
      const norm = notePath.replace(/\\/g, "/")
      function findByPath(items: typeof treeItems): (typeof treeItems)[number] | null {
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
      } catch { /* ignore */ }
      setActiveLayers(prev => ({ ...prev, [id]: "canvas" }))
      const existing = tabs.find(t => t.kind === "document" && t.fileId === id)
      if (existing) {
        setActiveTabKey(existing.key)
      } else {
        const key = newTabKey()
        setTabs(prev => [...prev, { key, kind: "document", fileId: id, title: name, history: [id], historyIndex: 0 }])
        setActiveTabKey(key)
      }
    } catch (err) {
      console.error("Failed to attach canvas to note:", err)
    }
  }

  const handleMoveItem = React.useCallback(async (sourceId: string, targetFolderId: string | null) => {
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeItems, vault])

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

  const handleContentChange = (fileId: string, content: string) => {
    // Store only content here; wordCount is derived lazily inside DocumentEditor
    // to avoid the O(n) split on every keystroke causing a Workspace re-render.
    patchDoc(fileId, { content })
    markUnsaved(fileId)

    const timers = saveTimersRef.current
    const existing = timers.get(fileId)
    if (existing) clearTimeout(existing)
    timers.set(fileId, setTimeout(async () => {
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
    }, 500))
  }

  const currentDoc = activeTab ? openDocs[activeTab.fileId] ?? null : null

  React.useEffect(() => {
    if (!currentDoc) return
    if (linkedLayersByDoc[currentDoc.id]) return
    refreshLinkedLayers(currentDoc.id, currentDoc.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDoc?.id, currentDoc?.path])

  // Debounced persistence of any open canvas (note layer or standalone), keyed by file path.
  const handleCanvasSave = React.useCallback((path: string, json: string) => {
    setOpenCanvases(prev => ({ ...prev, [path]: json }))
    const timers = canvasSaveTimers.current
    if (timers[path]) clearTimeout(timers[path])
    timers[path] = setTimeout(async () => {
      try {
        await writeFile(path, json)
      } catch (err) {
        console.error("Failed to save canvas:", err)
      }
    }, 500)
  }, [])

  // Lazily load the canvas layer file when the canvas layer becomes active.
  React.useEffect(() => {
    if (!currentDoc) return
    if ((activeLayers[currentDoc.id] ?? "editor") !== "canvas") return
    const path = canvasLayerPath(currentDoc.path)
    if (openCanvases[path] !== undefined) return
    let cancelled = false
    readFile(path)
      .then(content => {
        if (!cancelled) {
          setOpenCanvases(prev => (prev[path] !== undefined ? prev : { ...prev, [path]: content }))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOpenCanvases(prev => (prev[path] !== undefined ? prev : { ...prev, [path]: "{}" }))
        }
      })
    return () => { cancelled = true }
  }, [currentDoc?.id, currentDoc?.path, activeLayers, openCanvases])

  // Resolve an Obsidian vault-relative file ref to a tree item and open it.
  const handleOpenCanvasNote = React.useCallback((file: string) => {
    if (!file) return
    const norm = file.replace(/\\/g, "/")
    const stem = wsPathStem(norm)
    function find(items: typeof treeItems): (typeof treeItems)[number] | null {
      for (const it of items) {
        const p = (it.path ?? it.id).replace(/\\/g, "/")
        if (it.type === "file" && (p === norm || p.endsWith(`/${norm}`) || wsPathStem(p) === stem)) {
          return it
        }
        if (it.children) {
          const found = find(it.children)
          if (found) return found
        }
      }
      return null
    }
    const target = find(treeItems)
    if (target) handleSelect(target.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeItems])

  // Memoised on the fields it actually reads — `currentDoc` gets a new identity on
  // every keystroke (content changes), but id/modified don't, so this keeps
  // panelRenderProps stable while typing.
  const currentProperties = React.useMemo(
    () => currentDoc ? {
      type: "Markdown", status: "Draft", revisions: 0,
      backlinks: linkGraph.edges.filter(e => e.target === currentDoc.id).length,
      created: "—", modified: currentDoc.modified, id: currentDoc.id,
    } : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentDoc?.id, currentDoc?.modified, linkGraph],
  )

  const headerTabs: HeaderTab[] = tabs.map(t => ({ key: t.key, fileId: t.fileId, title: t.title }))

  const handleAttachLayerToFile = React.useCallback(async (fileId: string, layer: "canvas" | "database") => {
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeItems, vault])

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

  // panelRenderProps is memoised so that sidebar panels don't re-render when only
  // the editor content changes (openDocs/currentDoc). The deps list covers every value
  // the sidebar panels actually *display* or *act on*.
  const panelRenderProps: PanelRenderProps = React.useMemo(() => ({
    treeItems: displayTreeItems,
    selectedId,
    vault,
    onSelect: handleSelect,
    onOpenVault: handleOpenVault,
    onRename: handleRenameFile,
    onDelete: handleDeleteFile,
    onNewFile: handleNewFileIn,
    onNewFolder: handleNewFolderIn,
    onNewCanvas: handleNewCanvasIn,
    onAttachCanvas: handleAttachCanvasToNote,
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [
    displayTreeItems, selectedId, vault,
    handleSelect, handleOpenVault, handleRenameFile, handleDeleteFile,
    handleNewFileIn, handleNewFolderIn, handleOpenInNewTab,
    handleMoveItem, handleSetIcon,
    pendingRenameId, favorites, handleToggleFavorite,
    handleAttachLayerToFile, linkedLayersByDoc,
    currentProperties, linkGraph, currentDoc?.id,
  ])

  const leftButtons = buttonsForSide(activityButtons, "left")
  const rightButtons = buttonsForSide(activityButtons, "right")

  const NO_LAYERS = { canvas: false, sketch: false, database: false }

  // Build editor props for a given tab. The primary pane (active tab) keeps full
  // functionality; a secondary (split) pane gets editing + view-mode + autosave,
  // with layer/canvas/history scoped to the primary to keep the split coherent.
  function paneEditorProps(tab: Tab | null) {
    const doc = tab ? openDocs[tab.fileId] ?? null : null
    const isPrimary = !!tab && tab.key === activeTabKey
    return {
      document: doc,
      onContentChange: (content: string) => { if (tab) handleContentChange(tab.fileId, content) },
      onBack: isPrimary ? handleBack : () => {},
      onForward: isPrimary ? handleForward : () => {},
      canGoBack: isPrimary ? canGoBack : false,
      canGoForward: isPrimary ? canGoForward : false,
      onRenameTitle: (name: string) => { if (tab) handleRenameFile(tab.fileId, name) },
      vault: vault ?? undefined,
      fileIcon: isPrimary
        ? currentFileIcon
        : doc ? findTreeItem(displayTreeItems, doc.id)?.icon : undefined,
      onNewFile: () => handleNewFileIn(null),
      onOpenVault: handleOpenVault,
      onTagClick: (_tag: string) => { activatePanelAnywhere("tags") },
      onWikiLinkClick: handleWikiLinkClick,
      activeLayer: isPrimary && doc ? activeLayers[doc.id] ?? "editor" : "editor",
      onLayerChange: isPrimary ? handleLayerChange : async (_layer: EditorLayer) => {},
      viewMode: doc ? viewModes[doc.id] ?? "live" : "live",
      onViewModeChange: isPrimary
        ? handleViewModeChange
        : (mode: DocumentViewMode) => { if (doc) saveViewModes(vault, { ...viewModes, [doc.id]: mode }) },
      linkedLayers: isPrimary && doc ? linkedLayersByDoc[doc.id] ?? NO_LAYERS : NO_LAYERS,
      isLocked: doc ? lockedFileIds.has(doc.id) : false,
      onToggleLock: isPrimary ? handleToggleLock : () => {},
      treeItems: displayTreeItems,
      onOpenItem: handleSelect,
      onUnlinkLayer: handleUnlinkLayer,
      onDeleteLayer: handleDeleteLayer,
      canvasValue: isPrimary && doc ? openCanvases[canvasLayerPath(doc.path)] ?? "{}" : "{}",
      onCanvasChange: isPrimary
        ? (json: string) => { if (doc) handleCanvasSave(canvasLayerPath(doc.path), json) }
        : (_json: string) => {},
      onOpenCanvasNote: handleOpenCanvasNote,
    }
  }

  const editorProps = paneEditorProps(activeTab)
  const secondaryTab = secondaryTabKey
    ? tabs.find(t => t.key === secondaryTabKey && t.kind === "document") ?? null
    : null
  const secondaryProps = secondaryTab ? paneEditorProps(secondaryTab) : null
  const showSplit = !!secondaryProps && activeTab?.kind === "document"

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
        ) : activeTab?.kind === "canvas" ? (
          <CanvasEditor
            key={activeTab.fileId}
            value={openCanvases[activeTab.fileId] ?? "{}"}
            onChange={(json) => handleCanvasSave(activeTab.fileId, json)}
            vault={vault ?? null}
            notePath={activeTab.fileId}
            onOpenNote={handleOpenCanvasNote}
          />
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
            presets={presetOptions}
            activePresetId={activePresetId}
            onSwitchPreset={(id) => switchPreset(id, { vault })}
            onImportPreset={handleImportPreset}
            onExportPreset={handleExportPreset}
            panelScope={panelScope}
            onSetPanelScope={setPanelScope}
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

        <SearchModal
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          items={displayTreeItems}
          onSelect={handleSelect}
          readFile={readFile}
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
        onToggleSplit={toggleSplit}
        isSplit={!!secondaryTabKey}
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
          presets={presetOptions}
          activePresetId={activePresetId}
          onSwitchPreset={(id) => switchPreset(id, { vault })}
          onImportPreset={handleImportPreset}
          onExportPreset={handleExportPreset}
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
          ) : activeTab?.kind === "canvas" ? (
            <CanvasEditor
              key={activeTab.fileId}
              value={openCanvases[activeTab.fileId] ?? "{}"}
              onChange={(json) => handleCanvasSave(activeTab.fileId, json)}
              vault={vault ?? null}
              notePath={activeTab.fileId}
              onOpenNote={handleOpenCanvasNote}
            />
          ) : showSplit ? (
            <>
              <div className="flex min-w-0 flex-1">
                <DocumentEditor
                  key="pane-primary"
                  {...editorProps}
                  isFocusMode={false}
                  onToggleFocusMode={handleEnterFocusMode}
                />
              </div>
              <div className="w-px shrink-0 bg-zinc-800" />
              <div className="flex min-w-0 flex-1">
                <DocumentEditor
                  key="pane-secondary"
                  {...secondaryProps!}
                  isFocusMode={false}
                  onToggleFocusMode={() => {}}
                />
              </div>
            </>
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

      <SearchModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        items={displayTreeItems}
        onSelect={handleSelect}
        readFile={readFile}
      />
    </div>
  )
}
