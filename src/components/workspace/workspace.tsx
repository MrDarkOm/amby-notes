"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { FolderOpen, Maximize2, Minimize2, Minus, X } from "lucide-react"
import { getCurrentWindow } from "@tauri-apps/api/window"
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
import { buttonsForSide, type ActionContext, type PanelRenderProps } from "./panel-registry"
import { usePresets } from "./use-presets"
import { useDocStore } from "./use-doc-store"
import { useTabsStore, type Tab } from "./use-tabs-store"
import { useVaultStore } from "./use-vault-store"
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
import { useSidebarLayout } from "./use-sidebar-layout"
import { useLayers } from "./use-layers"
import { useTabActions } from "./use-tab-actions"
import { wsPathStem, canvasLayerPath, findTreeItem, newTabKey } from "./workspace-tree-utils"
import type { VaultRecord } from "./workspace-picker"
import {
  isTauri,
  openVault,
  readFile,
  writeFile,
  readNote,
  openInExplorer,
  exportTextFile,
  importTextFile,
  type FsMutationResult,
} from "@/lib/storage"

const GRAPH_TAB_FILE_ID = "__graph__"
const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)

/** Minimal draggable header shown on the empty-vault screen. */
function EmptyStateHeader() {
  const [isMaximized, setIsMaximized] = React.useState(false)
  const lastClickRef = React.useRef(0)

  React.useEffect(() => {
    if (!isTauri()) return
    const win = getCurrentWindow()
    win
      .isMaximized()
      .then(setIsMaximized)
      .catch(() => {})
    let unlisten: (() => void) | undefined
    win
      .onResized(() =>
        win
          .isMaximized()
          .then(setIsMaximized)
          .catch(() => {}),
      )
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {})
    return () => {
      unlisten?.()
    }
  }, [])

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0 || !isTauri()) return
    e.preventDefault()
    const now = Date.now()
    const since = now - lastClickRef.current
    lastClickRef.current = now
    if (since < 300) {
      lastClickRef.current = 0
      getCurrentWindow().toggleMaximize()
    } else {
      getCurrentWindow()
        .startDragging()
        .catch(() => {})
    }
  }

  return (
    <header className="relative z-50 flex h-10 shrink-0 select-none items-stretch border-b border-border bg-background">
      {/* macOS traffic-light spacer */}
      {isMac && <div className="w-20 shrink-0" onMouseDown={handleMouseDown} />}

      {/* Logo / app name */}
      <div className="flex shrink-0 items-center gap-2 px-3" onMouseDown={handleMouseDown}>
        <span className="text-sm font-semibold text-foreground">Amby</span>
      </div>

      {/* Drag region fills the rest */}
      <div className="h-full flex-1 cursor-default" onMouseDown={handleMouseDown} />

      {/* Windows: window controls */}
      {!isMac && (
        <div className="flex shrink-0 items-center">
          <button
            onClick={() => isTauri() && getCurrentWindow().minimize()}
            className="flex h-10 w-12 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-white"
          >
            <Minus className="size-4" />
          </button>
          <button
            onClick={() => isTauri() && getCurrentWindow().toggleMaximize()}
            className="flex h-10 w-12 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-white"
          >
            {isMaximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
          <button
            onClick={() => isTauri() && getCurrentWindow().close()}
            className="flex h-10 w-12 items-center justify-center text-muted-foreground transition-colors hover:bg-red-600 hover:text-white"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </header>
  )
}

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
  const { setTabs, setActiveTabKey } = useTabsStore.getState()
  const unsavedFileIds = useDocStore((s) => s.unsavedFileIds)
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
    applyMutation: applyViewMutation,
  } = useViewStateStore.getState()

  const handleToggleFavorite = React.useCallback((id: string) => toggleFavorite(id), [])

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

  const {
    isLeftSidebarOpen,
    setIsLeftSidebarOpen,
    isRightSidebarOpen,
    setIsRightSidebarOpen,
    leftWidth,
    rightWidth,
    startResize,
    isFocusMode,
    focusShowLeft,
    setFocusShowLeft,
    focusShowRight,
    setFocusShowRight,
    handleEnterFocusMode,
    handleExitFocusMode,
    moveButtonToSide,
    dnd,
    handleActivate,
    activatePanelAnywhere,
  } = useSidebarLayout({
    activityButtons,
    setActivityButtons,
    activeBySide,
    setActiveBySide,
    actionContext,
  })

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

  const currentDoc = activeTab ? (openDocs[activeTab.fileId] ?? null) : null

  const { handleLayerChange, handleAttachLayerToFile, handleUnlinkLayer, handleDeleteLayer } =
    useLayers({ vault, currentDoc, treeItems, refreshTree, applyMutationResult })

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

  const {
    handleBack,
    handleForward,
    handleTabChange,
    toggleSplit,
    handleTabClose,
    handleCloseAllTabs,
  } = useTabActions({
    activeTab,
    activeTabKey,
    secondaryTabKey,
    tabs,
    treeItems,
    canGoBack,
    canGoForward,
    navigateToFile,
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

  const handleOpenVault = React.useCallback(async () => {
    const path = await openVault()
    if (path) loadVault(path)
    // loadVault reads vault via closure but is stable (defined once in module scope via
    // async function declaration — does not close over changing state after our ref fixes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleViewModeChange = (mode: DocumentViewMode) => {
    if (!currentDoc) return
    setViewMode(currentDoc.id, mode)
  }

  const handleToggleLock = () => {
    if (!currentDoc) return
    toggleLock(currentDoc.id)
  }

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
      <div className="flex h-screen flex-col bg-background">
        <EmptyStateHeader />
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <p className="text-muted-foreground">{t("workspace.noVault")}</p>
          <button
            onClick={handleOpenVault}
            className="flex items-center gap-2 rounded-lg border border-border bg-card px-5 py-2.5 text-sm text-foreground transition-colors hover:bg-accent"
          >
            <FolderOpen className="size-4" />
            {t("workspace.openVault")}
          </button>
        </div>
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
