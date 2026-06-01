"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { FolderOpen } from "lucide-react"
import { ActivityBar } from "./activity-bar"
import { PanelHost } from "./panel-host"
import { ResizeHandle } from "./resize-handle"
// Lazy-loaded so @xyflow/react and d3-force are excluded from the initial bundle.
// They are fetched from their own chunks the first time the user opens a Canvas
// or Graph tab, then cached by the browser.
const GraphTabView = React.lazy(() =>
  import("./graph-tab-view").then((m) => ({ default: m.GraphTabView })),
)
const CanvasEditor = React.lazy(() =>
  import("./canvas-editor").then((m) => ({ default: m.CanvasEditor })),
)
import {
  buttonsForSide,
  findButtonDef,
  type ActionContext,
  type PanelId,
  type PanelRenderProps,
  type Side,
} from "./panel-registry"
import { usePresets } from "./use-presets"
import { useDocStore } from "./use-doc-store"
import { useTabsStore, type Tab } from "./use-tabs-store"
import { useVaultStore } from "./use-vault-store"
import { useActivityDnD } from "./use-activity-dnd"
import { DocumentEditor, type DocumentViewMode } from "./document-editor"
import { HeaderTabs, type HeaderTab } from "./header-tabs"
import { QuickOpenModal } from "./quick-open-modal"
import { SearchModal } from "./search-modal"
import { SettingsDialog } from "./settings-dialog"
import { useSettingsStore } from "./use-settings-store"
import { findWikiLinkItem } from "./wiki-links"
import { planMutation } from "./workspace-mutations"
import { useViewStateStore, type EditorLayer } from "./use-view-state-store"
import { useVaultData } from "./use-vault-data"
import { useFileActions } from "./use-file-actions"
import { wsPathStem, canvasLayerPath, findTreeItem, newTabKey } from "./workspace-tree-utils"
import type { VaultRecord } from "./workspace-picker"
import {
  isTauri,
  openVault,
  readFile,
  writeFile,
  readNote,
  createLayer,
  unlinkLayer,
  deleteLayer,
  noteLayers,
  openInExplorer,
  exportTextFile,
  importTextFile,
  type FsMutationResult,
  type LayerKind,
} from "@/lib/storage"
import { getCurrentWindow } from "@tauri-apps/api/window"

const GRAPH_TAB_FILE_ID = "__graph__"

/** Spinner shown while a lazy chunk (Canvas / Graph) is being fetched. */
function LazyEditorFallback() {
  return (
    <div className="flex h-full flex-1 items-center justify-center">
      <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
    </div>
  )
}

export function Workspace() {
  const { t } = useTranslation()
  const vault = useVaultStore((s) => s.vault)
  const vaults = useVaultStore((s) => s.vaults)
  const { setVaults } = useVaultStore.getState()

  const { treeItems, setTreeItems, displayTreeItems, linkGraph, loadVault, refreshTree } =
    useVaultData()

  const openDocs = useDocStore((s) => s.openDocs)
  // Action is stable in zustand, so read it once without subscribing.
  const { applyMutation } = useDocStore.getState()
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
  // Raw .canvas JSON keyed by canvas file path (covers both note layers and standalone canvases).
  const [openCanvases, setOpenCanvases] = React.useState<Record<string, string>>({})
  const canvasSaveTimers = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // Per-document view state (favorites, viewModes, lockedFileIds, iconOverrides,
  // activeLayers, linkedLayersByDoc) lives in useViewStateStore.
  const favorites = useViewStateStore((s) => s.favorites)
  const viewModes = useViewStateStore((s) => s.viewModes)
  const lockedFileIds = useViewStateStore((s) => s.lockedFileIds)
  const activeLayers = useViewStateStore((s) => s.activeLayers)
  const linkedLayersByDoc = useViewStateStore((s) => s.linkedLayersByDoc)
  // Stable store actions (never change reference).
  const {
    toggleFavorite,
    setIcon: setIconInStore,
    setViewMode,
    toggleLock,
    setActiveLayer,
    setLinkedLayers,
    applyMutation: applyViewMutation,
  } = useViewStateStore.getState()

  const handleToggleFavorite = React.useCallback((id: string) => toggleFavorite(id), [])

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
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const defaultViewMode = useSettingsStore((s) => s.prefs.editor.defaultViewMode)

  // Cmd/Ctrl + , opens application settings (desktop convention).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault()
        setSettingsOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  const [pendingRenameId, setPendingRenameId] = React.useState<string | null>(null)
  const [isFocusMode, setIsFocusMode] = React.useState(false)
  const {
    activityButtons,
    setActivityButtons,
    activeBySide,
    setActiveBySide,
    activePresetId,
    presets,
    panelScope,
    setPanelScope,
    switchPreset,
    importPreset,
    exportPreset,
  } = usePresets(vault)
  const presetOptions = React.useMemo(
    () => presets.map((p) => ({ id: p.id, label: p.label })),
    [presets],
  )

  async function handleExportPreset() {
    const json = exportPreset(activePresetId)
    if (!json) return
    try {
      await exportTextFile(json, `${activePresetId}.amby-preset.json`)
    } catch {
      /* dialog cancelled / write failed */
    }
  }

  async function handleImportPreset() {
    try {
      const text = await importTextFile()
      if (text) importPreset(text, { vault })
    } catch {
      /* dialog cancelled / unreadable file */
    }
  }
  const [focusShowLeft, setFocusShowLeft] = React.useState(false)
  const [focusShowRight, setFocusShowRight] = React.useState(false)
  const preFocusSidebars = React.useRef<{ left: boolean; right: boolean } | null>(null)

  // One debounce timer per open file, so editing or closing one document never
  // cancels another's pending save (also what an editor split relies on).
  const saveTimersRef = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const activeTab = tabs.find((t) => t.key === activeTabKey) ?? null
  const selectedId = activeTab && activeTab.kind === "document" ? activeTab.fileId : ""
  const canGoBack = (activeTab?.historyIndex ?? 0) > 0
  const canGoForward = activeTab ? activeTab.historyIndex < activeTab.history.length - 1 : false

  function openGraphTab() {
    const existing = tabs.find((t) => t.kind === "graph")
    if (existing) {
      setActiveTabKey(existing.key)
      return
    }
    const key = newTabKey()
    setTabs((prev) => [
      ...prev,
      {
        key,
        kind: "graph",
        fileId: GRAPH_TAB_FILE_ID,
        title: t("workspace.graphTab"),
        history: [],
        historyIndex: 0,
      },
    ])
    setActiveTabKey(key)
  }

  function openCanvasTab(path: string, title: string) {
    setOpenCanvases((prev) => {
      if (prev[path] !== undefined) return prev
      readFile(path)
        .then((c) => setOpenCanvases((p) => (p[path] !== undefined ? p : { ...p, [path]: c })))
        .catch(() => setOpenCanvases((p) => (p[path] !== undefined ? p : { ...p, [path]: "{}" })))
      return prev
    })
    const existing = tabs.find((t) => t.kind === "canvas" && t.fileId === path)
    if (existing) {
      setActiveTabKey(existing.key)
      return
    }
    const key = newTabKey()
    setTabs((prev) => [
      ...prev,
      { key, kind: "canvas", fileId: path, title, history: [], historyIndex: 0 },
    ])
    setActiveTabKey(key)
  }

  async function refreshVault() {
    if (!vault) return
    try {
      await refreshTree(vault)
    } catch {
      /* ignore */
    }
  }

  const actionContext: ActionContext = {
    openGraphTab,
    refreshVault,
    openSearch: () => setSearchOpen(true),
  }

  // Move a button to the opposite side (appended to that side's end).
  function moveButtonToSide(defId: string, targetSide: Side) {
    setActivityButtons((prev) => {
      const button = prev.find((b) => b.defId === defId)
      if (!button) return prev
      if (button.side === targetSide) return prev
      const targetOrders = prev.filter((b) => b.side === targetSide).map((b) => b.order)
      const nextOrder = targetOrders.length ? Math.max(...targetOrders) + 1 : 0
      return prev.map((b) => (b.defId === defId ? { ...b, side: targetSide, order: nextOrder } : b))
    })
    setActiveBySide((prev) => {
      const next = { ...prev }
      // If this view was active on its old side, fall back.
      const def = findButtonDef(defId)
      if (def?.kind === "view") {
        const otherSide: Side = targetSide === "left" ? "right" : "left"
        if (prev[otherSide] === defId) {
          const remaining = activityButtons
            .filter((b) => b.side === otherSide && b.defId !== defId)
            .sort((a, b) => a.order - b.order)
          const firstView = remaining.find((b) => findButtonDef(b.defId)?.kind === "view")
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
    setActivityButtons((prev) => {
      const moving = prev.find((b) => b.defId === defId)
      if (!moving) return prev
      // Build the target-side list without the moving button, sorted by current order.
      const others = prev
        .filter((b) => b.side === targetSide && b.defId !== defId)
        .sort((a, b) => a.order - b.order)
      let insertAt = others.length
      if (beforeDefId !== "__end__") {
        const idx = others.findIndex((b) => b.defId === beforeDefId)
        if (idx >= 0) insertAt = idx
      }
      const reorderedTarget = [
        ...others.slice(0, insertAt),
        { ...moving, side: targetSide },
        ...others.slice(insertAt),
      ].map((b, i) => ({ ...b, order: i }))
      const oppositeSide: Side = targetSide === "left" ? "right" : "left"
      const opposite = prev
        .filter((b) => b.side === oppositeSide && b.defId !== defId)
        .sort((a, b) => a.order - b.order)
        .map((b, i) => ({ ...b, order: i }))
      return [...reorderedTarget, ...opposite]
    })
    // Cross-side fallback for active view
    const movingDef = findButtonDef(defId)
    if (movingDef?.kind === "view") {
      const oldSide: Side = activityButtons.find((b) => b.defId === defId)?.side ?? targetSide
      if (oldSide !== targetSide) {
        setActiveBySide((prev) => {
          const next = { ...prev }
          if (prev[oldSide] === defId) {
            const remaining = activityButtons
              .filter((b) => b.side === oldSide && b.defId !== defId)
              .sort((a, b) => a.order - b.order)
            const firstView = remaining.find((b) => findButtonDef(b.defId)?.kind === "view")
            next[oldSide] = (firstView?.defId as PanelId | undefined) ?? null
          }
          next[targetSide] = movingDef.id as PanelId
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
    const button = activityButtons.find((b) => b.defId === defId)
    if (!button) return
    const side = button.side
    const isOpen = side === "left" ? isLeftSidebarOpen : isRightSidebarOpen
    const setOpen = side === "left" ? setIsLeftSidebarOpen : setIsRightSidebarOpen
    // Click on already-active view collapses the panel.
    if (isOpen && activeBySide[side] === def.id) {
      setOpen(false)
      return
    }
    setActiveBySide((prev) => ({ ...prev, [side]: def.id }))
    setOpen(true)
  }

  function activatePanelAnywhere(panelId: PanelId) {
    const button = activityButtons.find((b) => b.defId === panelId)
    if (!button) return
    if (button.side === "left") setIsLeftSidebarOpen(true)
    else setIsRightSidebarOpen(true)
    setActiveBySide((prev) => ({ ...prev, [button.side]: panelId }))
  }

  const vaultName = vault?.replace(/\\/g, "/").split("/").pop() ?? undefined

  // Current file icon (from iconOverrides or tree)
  const activeFileId = activeTab?.fileId ?? null
  const activeTreeItem = activeFileId ? findTreeItem(displayTreeItems, activeFileId) : null
  const currentFileIcon = activeTreeItem?.icon

  const handleSetIcon = React.useCallback(
    (id: string, icon: string) => setIconInStore(id, icon),
    [],
  )

  function saveVaults(next: VaultRecord[]) {
    setVaults(next)
  }

  async function refreshLinkedLayers(docId: string, notePath: string) {
    try {
      const layers = await noteLayers(notePath)
      setLinkedLayers(docId, layers)
    } catch (err) {
      console.error("Failed to load note layers:", err)
    }
  }

  function applyMutationResult(result: FsMutationResult) {
    const { deletedIds, remapFn, hasChanges } = planMutation(result)
    if (!hasChanges) return

    const deleted = new Set(deletedIds)
    // Fan out to each store with the same deletedIds.
    applyMutation(deletedIds, remapFn) // doc store: remaps content paths + drops deleted
    applyViewMutation(deletedIds) // view state store: drops deleted from all maps/sets

    setTabs((prev) => {
      const next = prev
        .filter((tab) => !deleted.has(tab.fileId))
        .map((tab) => ({
          ...tab,
          fileId: tab.fileId,
          history: tab.history.filter((path) => !deleted.has(path)).map((path) => path),
        }))
      if (next.length !== prev.length && activeTabKey) {
        const stillExists = next.find((tab) => tab.key === activeTabKey)
        if (!stillExists) setActiveTabKey(next[next.length - 1]?.key ?? "")
      }
      return next
    })
  }

  const {
    handleSelect,
    handleOpenInNewTab,
    navigateToFile,
    handleWikiLinkClick,
    handleRenameFile,
    handleDeleteFile,
    handleNewFileIn,
    handleNewFolderIn,
    handleNewCanvasIn,
    handleAttachCanvasToNote,
    handleMoveItem,
    handleContentChange,
  } = useFileActions({
    vault,
    treeItems,
    setTreeItems,
    refreshTree,
    applyMutationResult,
    openCanvasTab,
    setOpenCanvases,
    setPendingRenameId,
    saveTimersRef,
  })

  function handleRenameVault(id: string, name: string) {
    saveVaults(vaults.map((v) => (v.id === id ? { ...v, name } : v)))
  }

  function handleDeleteVault(id: string) {
    saveVaults(vaults.filter((v) => v.id !== id))
  }

  async function handleMoveVault(id: string) {
    const path = await openVault()
    if (!path) return
    saveVaults(
      vaults.map((v) =>
        v.id === id ? { ...v, path, name: path.replace(/\\/g, "/").split("/").pop() ?? v.name } : v,
      ),
    )
    const target = vaults.find((v) => v.id === id)
    if (target && vault === target.path) loadVault(path)
  }

  async function handleEnterFocusMode() {
    preFocusSidebars.current = { left: isLeftSidebarOpen, right: isRightSidebarOpen }
    setIsLeftSidebarOpen(false)
    setIsRightSidebarOpen(false)
    setIsFocusMode(true)
    if (isTauri())
      await getCurrentWindow()
        .setFullscreen(true)
        .catch(() => {})
  }

  async function handleExitFocusMode() {
    setIsFocusMode(false)
    if (preFocusSidebars.current) {
      setIsLeftSidebarOpen(preFocusSidebars.current.left)
      setIsRightSidebarOpen(preFocusSidebars.current.right)
      preFocusSidebars.current = null
    }
    if (isTauri())
      await getCurrentWindow()
        .setFullscreen(false)
        .catch(() => {})
  }

  function handleCloseAllTabs() {
    setTabs([])
    setActiveTabKey("")
  }

  const handleOpenVault = React.useCallback(async () => {
    const path = await openVault()
    if (path) loadVault(path)
    // loadVault reads vault via closure but is stable (defined once in module scope via
    // async function declaration — does not close over changing state after our ref fixes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleBack() {
    if (!activeTab || !canGoBack) return
    const newIndex = activeTab.historyIndex - 1
    const prevFileId = activeTab.history[newIndex]
    const item = findTreeItem(treeItems, prevFileId)
    setTabs((prev) =>
      prev.map((t) =>
        t.key !== activeTabKey
          ? t
          : {
              ...t,
              fileId: prevFileId,
              title: item?.name ?? t.title,
              historyIndex: newIndex,
            },
      ),
    )
    navigateToFile(prevFileId)
  }

  function handleForward() {
    if (!activeTab || !canGoForward) return
    const newIndex = activeTab.historyIndex + 1
    const nextFileId = activeTab.history[newIndex]
    const item = findTreeItem(treeItems, nextFileId)
    setTabs((prev) =>
      prev.map((t) =>
        t.key !== activeTabKey
          ? t
          : {
              ...t,
              fileId: nextFileId,
              title: item?.name ?? t.title,
              historyIndex: newIndex,
            },
      ),
    )
    navigateToFile(nextFileId)
  }

  const handleTabChange = (key: string) => setActiveTabKey(key)

  // Toggle the editor split: pin the active document into a second pane, or
  // collapse back to a single pane.
  function toggleSplit() {
    setSecondaryTabKey((prev) =>
      prev ? null : activeTab?.kind === "document" ? activeTabKey : null,
    )
  }

  const handleTabClose = (key: string) => {
    const closing = tabs.find((t) => t.key === key)
    if (closing) {
      const timer = saveTimersRef.current.get(closing.fileId)
      if (timer) {
        clearTimeout(timer)
        saveTimersRef.current.delete(closing.fileId)
      }
    }
    if (secondaryTabKey === key) setSecondaryTabKey(null)
    const remaining = tabs.filter((t) => t.key !== key)
    setTabs(remaining)
    if (activeTabKey === key) {
      const next = remaining[remaining.length - 1]
      setActiveTabKey(next?.key ?? "")
    }
  }

  const handleLayerChange = async (layer: EditorLayer) => {
    const doc = activeTab ? (openDocs[activeTab.fileId] ?? null) : null
    if (!doc) return
    if (layer === "editor") {
      setActiveLayer(doc.id, "editor")
      return
    }
    try {
      const result = await createLayer(doc.path, layer)
      applyMutationResult({
        primaryPath: result.notePath,
        pathChanges: result.pathChanges,
        deletedPaths: [],
      })
      setActiveLayer(doc.id, layer)
      await refreshTree()
      await refreshLinkedLayers(doc.id, result.notePath ?? doc.path)
    } catch (err) {
      console.error("Failed to create layer:", err)
    }
  }

  const handleViewModeChange = (mode: DocumentViewMode) => {
    if (!currentDoc) return
    setViewMode(currentDoc.id, mode)
  }

  const handleToggleLock = () => {
    if (!currentDoc) return
    toggleLock(currentDoc.id)
  }

  const currentDoc = activeTab ? (openDocs[activeTab.fileId] ?? null) : null

  React.useEffect(() => {
    if (!currentDoc) return
    if (linkedLayersByDoc[currentDoc.id]) return
    refreshLinkedLayers(currentDoc.id, currentDoc.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDoc?.id, currentDoc?.path])

  // Debounced persistence of any open canvas (note layer or standalone), keyed by file path.
  const handleCanvasSave = React.useCallback((path: string, json: string) => {
    setOpenCanvases((prev) => ({ ...prev, [path]: json }))
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
      .then((content) => {
        if (!cancelled) {
          setOpenCanvases((prev) =>
            prev[path] !== undefined ? prev : { ...prev, [path]: content },
          )
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOpenCanvases((prev) => (prev[path] !== undefined ? prev : { ...prev, [path]: "{}" }))
        }
      })
    return () => {
      cancelled = true
    }
  }, [currentDoc?.id, currentDoc?.path, activeLayers, openCanvases])

  // Resolve an Obsidian vault-relative file ref to a tree item and open it.
  const handleOpenCanvasNote = React.useCallback(
    (file: string) => {
      if (!file) return
      const norm = file.replace(/\\/g, "/")
      const stem = wsPathStem(norm)
      function find(items: typeof treeItems): (typeof treeItems)[number] | null {
        for (const it of items) {
          const p = (it.path ?? it.id).replace(/\\/g, "/")
          if (
            it.type === "file" &&
            (p === norm || p.endsWith(`/${norm}`) || wsPathStem(p) === stem)
          ) {
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
    },
    [treeItems],
  )

  // Memoised on the fields it actually reads — `currentDoc` gets a new identity on
  // every keystroke (content changes), but id/modified don't, so this keeps
  // panelRenderProps stable while typing.
  const currentProperties = React.useMemo(
    () =>
      currentDoc
        ? {
            type: "Markdown",
            status: "Draft",
            revisions: 0,
            backlinks: linkGraph.edges.filter((e) => e.target === currentDoc.id).length,
            created: "—",
            modified: currentDoc.modified,
            id: currentDoc.id,
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentDoc?.id, currentDoc?.modified, linkGraph],
  )

  const headerTabs: HeaderTab[] = tabs.map((t) => ({
    key: t.key,
    fileId: t.fileId,
    title: t.title,
  }))

  const handleAttachLayerToFile = React.useCallback(
    async (fileId: string, layer: "canvas" | "database") => {
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
    },
    [treeItems, vault],
  )

  const handleUnlinkLayer = async (layer: LayerKind) => {
    if (!currentDoc || !vault) return
    try {
      const result = await unlinkLayer(vault, currentDoc.path, layer)
      applyMutationResult(result)
      await refreshTree()
      await refreshLinkedLayers(currentDoc.id, result.primaryPath ?? currentDoc.path)
      // If the unlinked layer was active, fall back to the editor.
      if (activeLayers[currentDoc.id] === layer) setActiveLayer(currentDoc.id, "editor")
    } catch (err) {
      console.error("Failed to unlink layer:", err)
    }
  }

  const handleDeleteLayer = async (layer: LayerKind) => {
    if (!currentDoc || !vault) return
    if (
      !confirm(
        t("workspace.deleteLayerConfirm", { layer: t(`layer.${layer}`), title: currentDoc.title }),
      )
    )
      return
    try {
      const result = await deleteLayer(vault, currentDoc.path, layer)
      applyMutationResult(result)
      await refreshTree()
      await refreshLinkedLayers(currentDoc.id, result.primaryPath ?? currentDoc.path)
      if (activeLayers[currentDoc.id] === layer) setActiveLayer(currentDoc.id, "editor")
    } catch (err) {
      console.error("Failed to delete layer:", err)
    }
  }

  // panelRenderProps is memoised so that sidebar panels don't re-render when only
  // the editor content changes (openDocs/currentDoc). The deps list covers every value
  // the sidebar panels actually *display* or *act on*.
  const panelRenderProps: PanelRenderProps = React.useMemo(
    () => ({
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
      readFile: (id: string) => (vault ? readNote(vault, id) : readFile(id)),
      favorites,
      onToggleFavorite: handleToggleFavorite,
      onAttachLayer: handleAttachLayerToFile,
      linkedLayersByDoc,
      properties: currentProperties,
      linkGraph,
      currentDocId: currentDoc?.id ?? null,
      onSelectLink: handleSelect,
    }),
    [
      displayTreeItems,
      selectedId,
      vault,
      handleSelect,
      handleOpenVault,
      handleRenameFile,
      handleDeleteFile,
      handleNewFileIn,
      handleNewFolderIn,
      handleOpenInNewTab,
      handleMoveItem,
      handleSetIcon,
      pendingRenameId,
      favorites,
      handleToggleFavorite,
      handleAttachLayerToFile,
      linkedLayersByDoc,
      currentProperties,
      linkGraph,
      currentDoc?.id,
    ],
  )

  const leftButtons = buttonsForSide(activityButtons, "left")
  const rightButtons = buttonsForSide(activityButtons, "right")

  const NO_LAYERS = { canvas: false, sketch: false, database: false }

  // Build editor props for a given tab. The primary pane (active tab) keeps full
  // functionality; a secondary (split) pane gets editing + view-mode + autosave,
  // with layer/canvas/history scoped to the primary to keep the split coherent.
  function paneEditorProps(tab: Tab | null) {
    const doc = tab ? (openDocs[tab.fileId] ?? null) : null
    const isPrimary = !!tab && tab.key === activeTabKey
    return {
      document: doc,
      onContentChange: (content: string) => {
        if (tab) handleContentChange(tab.fileId, content)
      },
      onBack: isPrimary ? handleBack : () => {},
      onForward: isPrimary ? handleForward : () => {},
      canGoBack: isPrimary ? canGoBack : false,
      canGoForward: isPrimary ? canGoForward : false,
      onRenameTitle: (name: string) => {
        if (tab) handleRenameFile(tab.fileId, name)
      },
      vault: vault ?? undefined,
      fileIcon: isPrimary
        ? currentFileIcon
        : doc
          ? findTreeItem(displayTreeItems, doc.id)?.icon
          : undefined,
      onNewFile: () => handleNewFileIn(null),
      onOpenVault: handleOpenVault,
      onTagClick: (_tag: string) => {
        activatePanelAnywhere("tags")
      },
      onWikiLinkClick: handleWikiLinkClick,
      fetchTransclusion: async (target: string): Promise<string | null> => {
        if (!vault) return null
        const item = findWikiLinkItem(treeItems, target, vault)
        if (!item) return null
        try {
          return await readNote(vault, item.id)
        } catch {
          return null
        }
      },
      activeLayer: isPrimary && doc ? (activeLayers[doc.id] ?? "editor") : "editor",
      onLayerChange: isPrimary ? handleLayerChange : async (_layer: EditorLayer) => {},
      viewMode: doc ? (viewModes[doc.id] ?? defaultViewMode) : defaultViewMode,
      onViewModeChange: isPrimary
        ? handleViewModeChange
        : (mode: DocumentViewMode) => {
            if (doc) setViewMode(doc.id, mode)
          },
      linkedLayers: isPrimary && doc ? (linkedLayersByDoc[doc.id] ?? NO_LAYERS) : NO_LAYERS,
      isLocked: doc ? lockedFileIds.has(doc.id) : false,
      onToggleLock: isPrimary ? handleToggleLock : () => {},
      treeItems: displayTreeItems,
      onOpenItem: handleSelect,
      onUnlinkLayer: handleUnlinkLayer,
      onDeleteLayer: handleDeleteLayer,
      canvasValue: isPrimary && doc ? (openCanvases[canvasLayerPath(doc.path)] ?? "{}") : "{}",
      onCanvasChange: isPrimary
        ? (json: string) => {
            if (doc) handleCanvasSave(canvasLayerPath(doc.path), json)
          }
        : (_json: string) => {},
      onOpenCanvasNote: handleOpenCanvasNote,
    }
  }

  const editorProps = paneEditorProps(activeTab)
  const secondaryTab = secondaryTabKey
    ? (tabs.find((t) => t.key === secondaryTabKey && t.kind === "document") ?? null)
    : null
  const secondaryProps = secondaryTab ? paneEditorProps(secondaryTab) : null
  const showSplit = !!secondaryProps && activeTab?.kind === "document"

  if (!vault && isTauri()) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background">
        <p className="text-muted-foreground">{t("workspace.noVault")}</p>
        <button
          onClick={handleOpenVault}
          className="flex items-center gap-2 rounded-lg border border-border bg-card px-5 py-2.5 text-sm text-foreground transition-colors hover:bg-accent"
        >
          <FolderOpen className="size-4" />
          {t("workspace.openVault")}
        </button>
      </div>
    )
  }

  // ── Focus mode layout ──────────────────────────────────────────
  if (isFocusMode) {
    return (
      <div
        className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background"
        onMouseMove={(e) => {
          const w = window.innerWidth
          if (e.clientX < 20) setFocusShowLeft(true)
          if (e.clientX > w - 20) setFocusShowRight(true)
        }}
      >
        {activeTab?.kind === "graph" ? (
          <React.Suspense fallback={<LazyEditorFallback />}>
            <GraphTabView graph={linkGraph} selectedId={null} onSelect={handleSelect} />
          </React.Suspense>
        ) : activeTab?.kind === "canvas" ? (
          <React.Suspense fallback={<LazyEditorFallback />}>
            <CanvasEditor
              key={activeTab.fileId}
              value={openCanvases[activeTab.fileId] ?? "{}"}
              onChange={(json) => handleCanvasSave(activeTab.fileId, json)}
              vault={vault ?? null}
              notePath={activeTab.fileId}
              onOpenNote={handleOpenCanvasNote}
            />
          </React.Suspense>
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
            onMoveToOtherSide={(defId) => moveButtonToSide(defId, "right")}
            onPointerDownButton={dnd.onPointerDown}
            draggingId={dnd.draggingId}
            presets={presetOptions}
            activePresetId={activePresetId}
            onSwitchPreset={(id) => switchPreset(id, { vault })}
            onImportPreset={handleImportPreset}
            onExportPreset={handleExportPreset}
            panelScope={panelScope}
            onSetPanelScope={setPanelScope}
            onOpenSettings={() => setSettingsOpen(true)}
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
            onMoveToOtherSide={(defId) => moveButtonToSide(defId, "left")}
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
        onToggleLeftSidebar={() => setIsLeftSidebarOpen((v) => !v)}
        onToggleRightSidebar={() => setIsRightSidebarOpen((v) => !v)}
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
          onMoveToOtherSide={(defId) => moveButtonToSide(defId, "right")}
          onPointerDownButton={dnd.onPointerDown}
          draggingId={dnd.draggingId}
          presets={presetOptions}
          activePresetId={activePresetId}
          onSwitchPreset={(id) => switchPreset(id, { vault })}
          onImportPreset={handleImportPreset}
          onExportPreset={handleExportPreset}
          onOpenSettings={() => setSettingsOpen(true)}
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
            <React.Suspense fallback={<LazyEditorFallback />}>
              <GraphTabView graph={linkGraph} selectedId={null} onSelect={handleSelect} />
            </React.Suspense>
          ) : activeTab?.kind === "canvas" ? (
            <React.Suspense fallback={<LazyEditorFallback />}>
              <CanvasEditor
                key={activeTab.fileId}
                value={openCanvases[activeTab.fileId] ?? "{}"}
                onChange={(json) => handleCanvasSave(activeTab.fileId, json)}
                vault={vault ?? null}
                notePath={activeTab.fileId}
                onOpenNote={handleOpenCanvasNote}
              />
            </React.Suspense>
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
              <div className="w-px shrink-0 bg-accent" />
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
          onMoveToOtherSide={(defId) => moveButtonToSide(defId, "left")}
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

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}
