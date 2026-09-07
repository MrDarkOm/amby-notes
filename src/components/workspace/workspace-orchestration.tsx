"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, FolderOpen } from "lucide-react"
import { motion } from "motion/react"
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
// The rich-text/source editor pulls in Tiptap, CodeMirror, and emoji-mart.
// Keep those libraries out of the startup path until a document is rendered.
const DocumentEditor = React.lazy(() =>
  import("./document-editor").then((m) => ({ default: m.DocumentEditor })),
)
const MemoizedDocumentEditor = React.memo(DocumentEditor)
import type { ActionContext, PanelRenderProps } from "./panel-registry"
import { buttonsForSide } from "./panel-definitions"
import { usePresets } from "./use-presets"
import { useDocStore } from "./use-doc-store"
import { useTabsStore, type Tab } from "./use-tabs-store"
import { useVaultStore } from "./use-vault-store"
import type { DocumentEditorProps, DocumentViewMode } from "./document-editor"
import type { ContentWidth } from "./app-config"
import { HeaderTabs, type HeaderTab } from "./header-tabs"
import { QuickOpenModal } from "./quick-open-modal"
import { SearchModal } from "./search-modal"
import { SettingsDialog } from "./settings-dialog"
import type { SettingsNavigationTarget } from "./settings-navigation"
import { useSettingsStore } from "./use-settings-store"
import { findWikiLinkItem } from "./wiki-links"
import { applyTreePatch, planMutation } from "./workspace-mutations"
import { useViewStateStore, type EditorLayer } from "./use-view-state-store"
import { useVaultData } from "./use-vault-data"
import { useFileActions } from "./use-file-actions"
import { useSidebarLayout } from "./use-sidebar-layout"
import { useLayers } from "./use-layers"
import { useTabActions } from "./use-tab-actions"
import { canRenderSplit } from "./document-buffer-lifecycle"
import { wsPathStem, canvasLayerPath, newTabKey } from "./workspace-tree-utils"
import { WorkspacePicker } from "./workspace-picker"
import { FolderView } from "./folder-view"
import type { TreeItem } from "./sidebar-tree"
import { DatabaseWorkspace } from "./database/database-workspace"
import { useDatabaseController } from "./database/use-database-controller"
import { useDatabaseStore } from "./database/database-store"
import { discardRecoveryDraft, remapRecoveryDraft } from "@/lib/recovery-drafts"
import {
  isTauri,
  readFile,
  readNote,
  restoreDeletedNote,
  searchNotes,
  openInExplorer,
  exportTextFile,
  importTextFile,
  type FsMutationResult,
} from "@/lib/storage"
import { useCanvasWorkspace } from "./orchestration/use-canvas-workspace"
import { usePropertyActions } from "./orchestration/use-property-actions"
import { useVaultActions } from "./orchestration/use-vault-actions"
import { WorkspaceLayout } from "./workspace-layout"
import { matchesShortcut } from "./keyboard-shortcuts"
import { DATABASE_LAYER_CREATION_AVAILABLE } from "./modules"

import { EmptyStateHeader, workspaceRelativePath } from "./vault/use-vault-session"
import { useNoteWindows } from "./windows/use-note-windows"
import { MotionSpinner } from "@/lib/motion"
import { motionTransitions } from "@/lib/motion-config"

const GRAPH_TAB_FILE_ID = "__graph__"
const databaseContentWidthKey = (databaseId: string) => `database:${databaseId}`
const EMPTY_CONTENT_WIDTHS: Record<string, ContentWidth> = {}
const EMPTY_DATABASE_TITLE_LABELS: Record<string, string> = {}
const EMPTY_LAYERS = { canvas: false, sketch: false, database: false }
const NOOP = () => {}

/** Spinner shown while a lazy chunk (Canvas / Graph) is being fetched. */
function LazyEditorFallback() {
  return (
    <div className="flex h-full flex-1 items-center justify-center">
      <MotionSpinner>
        <span className="size-5 rounded-full border-2 border-muted-foreground border-t-transparent" />
      </MotionSpinner>
    </div>
  )
}

interface CachedDocumentEditorProps {
  editorProps: DocumentEditorProps
  visible: boolean
  isFocusMode: boolean
  hideNavigation: boolean
  focusTabs: HeaderTab[]
  activeTabKey?: string
  onFocusTabChange?: (key: string) => void
  focusFavorites?: Set<string>
  onFocusToggleFavorite?: (id: string) => void
  onFocusCloseAllTabs?: () => void
  onToggleFocusMode: () => void
}

interface CachedTabContentProps {
  content: React.ReactElement
  visible: boolean
  signature: readonly unknown[]
}

/** Keep a heavy non-document tab mounted and reuse its last visible render. */
const CachedTabContent = React.memo(
  function CachedTabContent({ content }: CachedTabContentProps) {
    return content
  },
  (previous, next) => {
    if (!next.visible) return true
    if (!previous.visible) return false
    return (
      previous.signature.length === next.signature.length &&
      previous.signature.every((value, index) => value === next.signature[index])
    )
  },
)

/**
 * Hidden tabs keep their editor state, but should not rerender when unrelated
 * workspace state changes. They receive fresh props as soon as they become
 * visible again.
 */
const CachedDocumentEditor = React.memo(
  function CachedDocumentEditor({
    editorProps,
    visible,
    isFocusMode,
    hideNavigation,
    focusTabs,
    activeTabKey,
    onFocusTabChange,
    focusFavorites,
    onFocusToggleFavorite,
    onFocusCloseAllTabs,
    onToggleFocusMode,
  }: CachedDocumentEditorProps) {
    const editorRootRef = React.useRef<HTMLDivElement>(null)
    const controlsRef = React.useRef({
      isFocusMode,
      hideNavigation,
      focusTabs,
      activeTabKey,
      onFocusTabChange,
      focusFavorites,
      onFocusToggleFavorite,
      onFocusCloseAllTabs,
      onToggleFocusMode,
    })
    // A pane that is being hidden keeps the last visible editor controls. The
    // wrapper still updates its visibility and scroll restoration, while the
    // expensive editor subtree can bail out through React.memo.
    if (visible) {
      controlsRef.current = {
        isFocusMode,
        hideNavigation,
        focusTabs,
        activeTabKey,
        onFocusTabChange,
        focusFavorites,
        onFocusToggleFavorite,
        onFocusCloseAllTabs,
        onToggleFocusMode,
      }
    }
    const controls = controlsRef.current

    React.useLayoutEffect(() => {
      if (!visible) return
      const top = Math.max(0, editorProps.scrollPosition ?? 0)
      const restore = () => {
        const element = editorRootRef.current?.querySelector<HTMLElement>(".amby-editor-scroll")
        if (element) element.scrollTop = top
      }
      restore()
      const frame = requestAnimationFrame(restore)
      return () => cancelAnimationFrame(frame)
    }, [editorProps.scrollPosition, editorProps.scrollPositionKey, visible])

    return (
      <div ref={editorRootRef} className="flex min-h-0 min-w-0 flex-1">
        <MemoizedDocumentEditor
          {...editorProps}
          isFocusMode={controls.isFocusMode}
          isLocked={editorProps.isLocked}
          hideNavigation={controls.hideNavigation}
          focusTabs={controls.focusTabs}
          activeTabKey={controls.activeTabKey}
          onFocusTabChange={controls.onFocusTabChange}
          focusFavorites={controls.focusFavorites}
          onFocusToggleFavorite={controls.onFocusToggleFavorite}
          onFocusCloseAllTabs={controls.onFocusCloseAllTabs}
          onToggleFocusMode={controls.onToggleFocusMode}
        />
      </div>
    )
  },
  (previous, next) => {
    if (!next.visible) return true
    if (!previous.visible) return false
    return (
      previous.editorProps === next.editorProps &&
      previous.isFocusMode === next.isFocusMode &&
      previous.hideNavigation === next.hideNavigation &&
      previous.focusTabs === next.focusTabs &&
      previous.activeTabKey === next.activeTabKey &&
      previous.focusFavorites === next.focusFavorites &&
      previous.onFocusTabChange === next.onFocusTabChange &&
      previous.onFocusToggleFavorite === next.onFocusToggleFavorite &&
      previous.onFocusCloseAllTabs === next.onFocusCloseAllTabs &&
      previous.onToggleFocusMode === next.onToggleFocusMode
    )
  },
)

export function WorkspaceOrchestration() {
  const { t } = useTranslation()
  const vault = useVaultStore((s) => s.vault)
  const autosaveGeneration = useVaultStore((s) => s.generation)
  const backendGeneration = useVaultStore((s) => s.backendGeneration)
  const vaults = useVaultStore((s) => s.vaults)
  const { setVaults } = useVaultStore.getState()

  const {
    treeItems,
    setTreeItems,
    displayTreeItems,
    linkGraph,
    loadVault,
    refreshTree,
    reloadVaultData,
    windowLabel,
  } = useVaultData()

  const openDocs = useDocStore((s) => s.openDocs)
  // Action is stable in zustand, so read it once without subscribing.
  const { applyMutation, patchDoc, markSaved, clearExternalConflict } = useDocStore.getState()
  const tabs = useTabsStore((s) => s.tabs)
  const activeTabKey = useTabsStore((s) => s.activeTabKey)
  const secondaryTabKey = useTabsStore((s) => s.secondaryTabKey)
  // Stable setters (value-or-updater, like setState); see use-tabs-store.
  const { setTabs, setActiveTabKey } = useTabsStore.getState()
  const unsavedFileIds = useDocStore((s) => s.unsavedFileIds)
  // Keep editor scroll offsets outside the keyed editor components so a tab can
  // be temporarily hidden or remounted without losing the user's position.
  const scrollPositionsRef = React.useRef<Record<string, number>>({})

  // Per-document view state (favorites, viewModes, lockedFileIds, iconOverrides,
  // activeLayers, linkedLayersByDoc) lives in useViewStateStore.
  const favorites = useViewStateStore((s) => s.favorites)
  const viewModes = useViewStateStore((s) => s.viewModes)
  const nestedNotesPlacements = useViewStateStore((s) => s.nestedNotesPlacements)
  const contentWidths = useViewStateStore((s) => s.contentWidths ?? EMPTY_CONTENT_WIDTHS)
  const databaseTitleLabels = useViewStateStore(
    (s) => s.databaseTitleLabels ?? EMPTY_DATABASE_TITLE_LABELS,
  )
  const lockedFileIds = useViewStateStore((s) => s.lockedFileIds)
  const iconOverrides = useViewStateStore((s) => s.iconOverrides)
  const activeLayers = useViewStateStore((s) => s.activeLayers)
  const linkedLayersByDoc = useViewStateStore((s) => s.linkedLayersByDoc)
  // Stable store actions (never change reference).
  const {
    toggleFavorite,
    setIcon: setIconInStore,
    setViewMode,
    setContentWidth,
    setDatabaseTitleLabel,
    setNestedNotesPlacement,
    toggleLock,
    applyMutation: applyViewMutation,
  } = useViewStateStore.getState()

  const handleToggleFavorite = React.useCallback(
    (id: string) => toggleFavorite(id),
    [toggleFavorite],
  )

  const [quickOpenMode, setQuickOpenMode] = React.useState<"current" | "new" | null>(null)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [settingsTarget, setSettingsTarget] = React.useState<SettingsNavigationTarget | null>(null)
  const defaultViewMode = useSettingsStore((s) => s.prefs.editor.defaultViewMode)
  const defaultContentWidth = useSettingsStore((s) => s.prefs.editor.contentWidth)
  const dockPrefs = useSettingsStore((s) => s.prefs.docks)
  const shortcuts = useSettingsStore((s) => s.prefs.shortcuts)
  const experimental = useSettingsStore((s) => s.experimental)
  const setPrefs = useSettingsStore((s) => s.setPrefs)
  const [dockNotice, setDockNotice] = React.useState<string | null>(null)

  const updateDockPrefs = React.useCallback(
    (patch: Partial<typeof dockPrefs>) => setPrefs({ docks: { ...dockPrefs, ...patch } }),
    [dockPrefs, setPrefs],
  )

  const openSettings = React.useCallback((target: SettingsNavigationTarget | null = null) => {
    setSettingsTarget(target)
    setSettingsOpen(true)
  }, [])

  React.useEffect(() => {
    if (!dockNotice) return
    const timer = window.setTimeout(() => setDockNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [dockNotice])

  const [pendingRenameId, setPendingRenameId] = React.useState<string | null>(null)
  const {
    activityButtons,
    setActivityButtons,
    activeBySide,
    setActiveBySide,
    activePresetId,
    activeModules,
    presets,
    panelScope,
    setPanelScope,
    setModuleEnabled,
    switchPreset,
    importPreset,
    exportPreset,
  } = usePresets(vault, experimental)
  const databasesEnabled = activeModules.includes("databases")
  const databases = useDatabaseStore((state) => state.databases)
  const { refreshCatalog: refreshDatabaseCatalog } = useDatabaseController({
    enabled: databasesEnabled,
    vaultGeneration: backendGeneration,
  })
  const presetOptions = React.useMemo(
    () =>
      presets.map((p) => ({
        id: p.id,
        label: p.label ?? t(p.labelKey ?? "presets.standard"),
      })),
    [presets, t],
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

  const {
    autosave: canvasAutosave,
    autosaveKey: canvasAutosaveKey,
    handleCanvasSave,
    loadCanvasBuffer,
    openCanvases,
    setOpenCanvases,
  } = useCanvasWorkspace(autosaveGeneration, t)

  const activeTab = tabs.find((t) => t.key === activeTabKey) ?? null
  const selectedId =
    activeTab && (activeTab.kind === "document" || activeTab.kind === "folder")
      ? activeTab.fileId
      : ""
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

  const openDatabaseTab = React.useCallback(
    (databaseId: string, title: string, inNewTab = false) => {
      const target = { kind: "database" as const, fileId: databaseId, title }
      if (inNewTab) {
        useTabsStore.getState().openItem(target, true)
        return
      }
      useTabsStore.getState().openItem(target)
    },
    [],
  )

  async function loadCanvas(path: string) {
    if (openCanvases[path] === undefined) {
      const content = await loadCanvasBuffer(path)
      setOpenCanvases((p) => (p[path] !== undefined ? p : { ...p, [path]: content }))
    }
  }

  async function refreshVault() {
    try {
      await reloadVaultData()
    } catch {
      /* ignore */
    }
  }

  const actionContext: ActionContext = {
    openGraphTab,
    refreshVault,
    openSearch: () => setSearchOpen(true),
    openSettings,
  }

  const activityBarPresetProps = {
    presets: presetOptions,
    activePresetId,
    onSwitchPreset: (id: string) => switchPreset(id, { vault }),
    onImportPreset: handleImportPreset,
    onExportPreset: handleExportPreset,
    panelScope,
    onSetPanelScope: setPanelScope,
    onOpenSettings: openSettings,
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
    isCompactLayout,
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
    isDockVisible,
    isDockPinned,
    setDockVisible,
    setDockPinned,
  } = useSidebarLayout({
    activityButtons,
    setActivityButtons,
    activeBySide,
    setActiveBySide,
    actionContext,
    dockPrefs,
    onDockPrefsChange: updateDockPrefs,
  })

  const handleHideDock = React.useCallback(
    (side: "left" | "right") => {
      setDockVisible(side, false)
      setDockNotice(t("dock.hiddenNotice"))
    },
    [setDockVisible, t],
  )

  const activityDockProps = (side: "left" | "right") => ({
    pinned: isDockPinned(side),
    onPinnedChange: (pinned: boolean) => setDockPinned(side, pinned),
    onHide: () => handleHideDock(side),
  })

  const dockNoticeToast = dockNotice && (
    <div
      role="status"
      className="fixed bottom-5 left-1/2 z-[60] max-w-md -translate-x-1/2 rounded-lg border border-border bg-popover px-4 py-3 text-center text-[13px] text-foreground shadow-lg"
    >
      {dockNotice}
    </div>
  )

  const vaultName = vault?.replace(/\\/g, "/").split("/").pop() ?? undefined

  // Header tabs and cached editors both look up tree metadata on every
  // workspace render. Index the recursive tree once so switching tabs is not
  // multiplied by the number of open tabs and tree nodes.
  const treeItemById = React.useMemo(() => {
    const result = new Map<string, TreeItem>()
    const visit = (items: TreeItem[]) => {
      for (const item of items) {
        result.set(item.id, item)
        if (item.children) visit(item.children)
      }
    }
    visit(displayTreeItems)
    return result
  }, [displayTreeItems])

  // Current file icon (from iconOverrides or tree)
  const activeFileId = activeTab?.fileId ?? null
  const activeTreeItem = activeFileId ? (treeItemById.get(activeFileId) ?? null) : null
  const currentFileIcon =
    activeTreeItem?.icon ?? (activeFileId ? iconOverrides[activeFileId] : undefined)

  const handleSetIcon = React.useCallback(
    (id: string, icon: string) => setIconInStore(id, icon),
    [setIconInStore],
  )

  const handleRenameDatabaseTab = React.useCallback(
    (tabKey: string, title: string) => {
      setTabs((previous) => previous.map((tab) => (tab.key === tabKey ? { ...tab, title } : tab)))
    },
    [setTabs],
  )

  function applyMutationResult(result: FsMutationResult) {
    const { deletedIds, remapFn, hasChanges } = planMutation(result)
    setTreeItems((prev) => applyTreePatch(prev, result))
    if (!hasChanges) return

    const deleted = new Set(deletedIds)
    // Fan out to each store with the same deletedIds.
    applyMutation(deletedIds, remapFn) // doc store: remaps content paths + drops deleted
    applyViewMutation(deletedIds, remapFn)

    for (const [id, doc] of Object.entries(openDocs)) {
      if (!deleted.has(id)) {
        const nextPath = remapFn(doc.path)
        if (nextPath !== doc.path) {
          void remapRecoveryDraft(id, id, "markdown", nextPath)
          void remapRecoveryDraft(doc.path, nextPath, "markdown", nextPath)
        }
      }
    }

    const deletedCanvasPaths = new Set(result.deletedPaths)
    setOpenCanvases((previous) => {
      const next: Record<string, string> = {}
      for (const [path, json] of Object.entries(previous)) {
        if (deletedCanvasPaths.has(path)) {
          canvasAutosave.discard(canvasAutosaveKey(path))
          void discardRecoveryDraft(path)
          continue
        }
        const nextPath = remapFn(path)
        if (nextPath !== path) {
          canvasAutosave.remapKey(canvasAutosaveKey(path), canvasAutosaveKey(nextPath))
          void remapRecoveryDraft(path, nextPath, "canvas", nextPath)
        }
        next[nextPath] = json
      }
      return next
    })

    setTabs((prev) => {
      const next = prev
        .filter((tab) => !deleted.has(tab.fileId) && !deletedCanvasPaths.has(tab.fileId))
        .map((tab) => ({
          ...tab,
          fileId: tab.kind === "canvas" ? remapFn(tab.fileId) : tab.fileId,
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
  const currentDocId = currentDoc?.id ?? null
  const currentDocPath = currentDoc?.path ?? null

  const handleRestoreDeleted = React.useCallback(
    async (fileId: string) => {
      if (!vault) return
      const document = useDocStore.getState().openDocs[fileId]
      if (!document?.externallyDeleted) return
      const conflict = useDocStore.getState().externalConflicts[fileId]
      const outcome = await restoreDeletedNote(
        vault,
        fileId,
        document.path,
        document.content,
        conflict?.sourceTemplate ?? document.source,
        backendGeneration,
        windowLabel,
      )
      patchDoc(fileId, {
        revision: outcome.revision,
        source: conflict?.sourceTemplate ?? document.source,
        externallyDeleted: false,
      })
      markSaved(fileId)
      clearExternalConflict(fileId)
      await refreshTree(vault)
    },
    [
      backendGeneration,
      clearExternalConflict,
      markSaved,
      patchDoc,
      refreshTree,
      vault,
      windowLabel,
    ],
  )

  const {
    handleLayerChange,
    handleAttachLayerToFile,
    handleUnlinkLayer,
    handleDeleteLayer,
    handleNewDatabase,
  } = useLayers({
    vault,
    currentDoc,
    treeItems,
    refreshTree,
    applyMutationResult,
    databasesEnabled,
    backendGeneration,
    refreshDatabaseCatalog,
    onOpenDatabase: openDatabaseTab,
  })

  const {
    handleSelect,
    handleOpenInNewTab,
    handleCloneFile,
    navigateToFile,
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
    loadDoc,
    releaseUnusedDocumentBuffers,
    deleteConfirmationDialog,
    propertyMigrationDialog,
  } = useFileActions({
    vault,
    treeItems,
    setTreeItems,
    refreshTree,
    applyMutationResult,
    loadCanvas,
    setOpenCanvases,
    setPendingRenameId,
    autosaveGeneration,
    backendGeneration,
    windowLabel,
  })

  const handleRenameDatabaseRow = React.useCallback(
    async (rowId: string, name: string) => {
      await handleRenameFile(rowId, name)
      await refreshDatabaseCatalog()
    },
    [handleRenameFile, refreshDatabaseCatalog],
  )

  const { handleOpenInNewWindow } = useNoteWindows(treeItems)

  const handleTabUsageChanged = React.useCallback(() => {
    void releaseUnusedDocumentBuffers()
  }, [releaseUnusedDocumentBuffers])

  const { handleBack, handleForward, handleTabChange, handleTabClose, handleCloseAllTabs } =
    useTabActions({
      activeTab,
      activeTabKey,
      secondaryTabKey,
      tabs,
      treeItems,
      canGoBack,
      canGoForward,
      navigateToFile,
      onTabUsageChanged: handleTabUsageChanged,
    })

  // useTabActions is also a plain helper used directly by unit tests. Stable
  // delegates here keep its navigation callbacks from invalidating cached
  // editors on unrelated workspace renders.
  const handleTabChangeRef = React.useRef(handleTabChange)
  const handleCloseAllTabsRef = React.useRef(handleCloseAllTabs)
  handleTabChangeRef.current = handleTabChange
  handleCloseAllTabsRef.current = handleCloseAllTabs
  const stableHandleTabChange = React.useCallback(
    (key: string) => handleTabChangeRef.current(key),
    [],
  )
  const stableHandleCloseAllTabs = React.useCallback(() => handleCloseAllTabsRef.current(), [])

  // Workspace-wide shortcuts deliberately leave plain typing alone. Native editing
  // shortcuts still belong to the focused editor; these only invoke app navigation.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return

      if (matchesShortcut(event, shortcuts.quickOpen)) {
        event.preventDefault()
        setQuickOpenMode("current")
      } else if (matchesShortcut(event, shortcuts.search)) {
        event.preventDefault()
        setSearchOpen(true)
      } else if (matchesShortcut(event, shortcuts.newNote)) {
        event.preventDefault()
        handleNewFileIn(null)
      } else if (matchesShortcut(event, shortcuts.toggleLeftSidebar)) {
        event.preventDefault()
        setIsLeftSidebarOpen((open) => !open)
      } else if (matchesShortcut(event, shortcuts.toggleRightSidebar)) {
        event.preventDefault()
        setIsRightSidebarOpen((open) => !open)
      } else if (matchesShortcut(event, shortcuts.settings)) {
        event.preventDefault()
        openSettings()
      } else if (matchesShortcut(event, shortcuts.back)) {
        event.preventDefault()
        handleBack()
      } else if (matchesShortcut(event, shortcuts.forward)) {
        event.preventDefault()
        handleForward()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [
    handleBack,
    handleForward,
    handleNewFileIn,
    openSettings,
    setIsLeftSidebarOpen,
    setIsRightSidebarOpen,
    shortcuts,
  ])

  const { handleDeleteVault, handleMoveVault, handleOpenVault, handleRenameVault } =
    useVaultActions({
      loadVault,
      setVaults,
      vault,
      vaults,
    })

  const handleViewModeChange = (mode: DocumentViewMode) => {
    if (!currentDoc) return
    setViewMode(currentDoc.id, mode)
  }

  const handleToggleLock = () => {
    if (!currentDoc) return
    toggleLock(currentDoc.id)
  }

  const handleHistoryRestored = React.useCallback(async () => {
    if (!vault) return
    await refreshTree(vault)
    if (!currentDocId) return
    const beforeRead = useDocStore.getState().openDocs[currentDocId]
    const note = await readNote(vault, currentDocId)
    // A restored trash item may refresh a different, actively edited note.
    // Never replace new edits that arrived while the backend was responding.
    const state = useDocStore.getState()
    if (
      useVaultStore.getState().vault !== vault ||
      state.openDocs[currentDocId] !== beforeRead ||
      state.unsavedFileIds.has(currentDocId) ||
      state.externalConflicts[currentDocId]
    )
      return
    patchDoc(currentDocId, {
      content: note.content,
      revision: note.revision,
      source: note.source,
    })
    markSaved(currentDocId)
  }, [vault, currentDocId, patchDoc, markSaved, refreshTree])

  // Lazily load the canvas layer file when the canvas layer becomes active.
  React.useEffect(() => {
    if (!currentDocId || !currentDocPath) return
    if ((activeLayers[currentDocId] ?? "editor") !== "canvas") return
    const path = canvasLayerPath(currentDocPath)
    if (openCanvases[path] !== undefined) return
    let cancelled = false
    loadCanvasBuffer(path).then((content) => {
      if (!cancelled) {
        setOpenCanvases((prev) => (prev[path] !== undefined ? prev : { ...prev, [path]: content }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [currentDocId, currentDocPath, activeLayers, loadCanvasBuffer, openCanvases, setOpenCanvases])

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
    [handleSelect, treeItems],
  )

  const {
    currentProperties,
    attachments,
    attachmentImages,
    handleUpsertCustomProperty,
    handleDeleteCustomProperty,
    handleReorderCustomProperties,
  } = usePropertyActions({
    activeTab,
    currentDoc,
    treeItemById,
    linkGraph,
    t,
    vault,
    includeAttachmentImages:
      activeBySide.left === "attachments" || activeBySide.right === "attachments",
  })

  const selectedDatabase = React.useMemo(() => {
    if (activeTab?.kind === "database") {
      return databases.find((database) => database.databaseId === activeTab.fileId) ?? null
    }
    if (
      activeTab?.kind === "document" &&
      currentDoc &&
      activeLayers[currentDoc.id] === "database"
    ) {
      return databases.find((database) => database.attachedNoteId === currentDoc.id) ?? null
    }
    return null
  }, [activeLayers, activeTab, currentDoc, databases])

  const headerTabs: HeaderTab[] = React.useMemo(
    () =>
      tabs.map((tab) => {
        const item = treeItemById.get(tab.fileId)
        return {
          key: tab.key,
          fileId: tab.fileId,
          title: tab.title,
          icon: tab.kind === "folder" ? (item?.icon ?? "📁") : item?.icon,
        }
      }),
    [tabs, treeItemById],
  )

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
      onNewDatabase: handleNewDatabase,
      onAttachCanvas: handleAttachCanvasToNote,
      onOpenInNewTab: handleOpenInNewTab,
      onOpenInNewWindow: handleOpenInNewWindow,
      onCloneFile: handleCloneFile,
      onOpenInExplorer: openInExplorer,
      onMoveItem: handleMoveItem,
      onSetIcon: handleSetIcon,
      triggerRenameId: pendingRenameId,
      readFile: async (id: string) => (vault ? (await readNote(vault, id)).content : readFile(id)),
      favorites,
      onToggleFavorite: handleToggleFavorite,
      onAttachLayer: handleAttachLayerToFile,
      linkedLayersByDoc,
      canCreateDatabaseLayer: DATABASE_LAYER_CREATION_AVAILABLE && databasesEnabled,
      databaseRuntimeEnabled: databasesEnabled,
      onOpenDatabase: openDatabaseTab,
      properties: currentProperties,
      attachments,
      attachmentImages,
      databaseProperties: selectedDatabase
        ? {
            kind: "database" as const,
            id: selectedDatabase.databaseId,
            title:
              activeTab?.kind === "database" && activeTab.fileId === selectedDatabase.databaseId
                ? activeTab.title
                : selectedDatabase.title,
            icon: currentFileIcon ?? selectedDatabase.icon ?? null,
            propertyCount: selectedDatabase.properties.length,
            manifestRevision: selectedDatabase.manifestRevision,
            properties: selectedDatabase.properties,
            viewCount: selectedDatabase.views.length,
            locked: selectedDatabase.locked,
          }
        : null,
      linkGraph,
      currentDocId: currentDoc?.id ?? null,
      currentDocPath: currentDoc?.path ?? null,
      onSelectLink: handleSelect,
      onUpsertCustomProperty: handleUpsertCustomProperty,
      onDeleteCustomProperty: handleDeleteCustomProperty,
      onReorderCustomProperties: handleReorderCustomProperties,
      onHistoryRestored: handleHistoryRestored,
      workspaceSwitcher: (
        <WorkspacePicker
          vaults={vaults}
          currentPath={vault}
          onSelect={loadVault}
          onAdd={handleOpenVault}
          onRename={handleRenameVault}
          onDelete={handleDeleteVault}
          onMove={handleMoveVault}
          onOpenInExplorer={openInExplorer}
        >
          <button className="flex w-full items-center gap-2 rounded-lg border border-border bg-background/70 px-3 py-2.5 text-left outline-none hover:bg-accent">
            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block whitespace-nowrap text-[8px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                {t("vaultPicker.workspaceLabel")}
              </span>
              <span className="block truncate text-sm font-medium text-foreground">
                {vaultName ?? t("workspace.name")}
              </span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </WorkspacePicker>
      ),
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
      handleNewCanvasIn,
      handleNewDatabase,
      handleAttachCanvasToNote,
      handleOpenInNewTab,
      handleOpenInNewWindow,
      handleCloneFile,
      handleMoveItem,
      handleSetIcon,
      pendingRenameId,
      favorites,
      handleToggleFavorite,
      handleAttachLayerToFile,
      linkedLayersByDoc,
      currentProperties,
      attachments,
      attachmentImages,
      selectedDatabase,
      currentFileIcon,
      activeTab?.kind,
      activeTab?.fileId,
      activeTab?.title,
      databasesEnabled,
      openDatabaseTab,
      handleUpsertCustomProperty,
      handleDeleteCustomProperty,
      handleReorderCustomProperties,
      linkGraph,
      currentDoc?.id,
      currentDoc?.path,
      handleHistoryRestored,
      vaults,
      vaultName,
      loadVault,
      handleRenameVault,
      handleDeleteVault,
      handleMoveVault,
      t,
    ],
  )

  const leftButtons = buttonsForSide(activityButtons, "left")
  const rightButtons = buttonsForSide(activityButtons, "right")

  // Build editor props for a given tab. The primary pane (active tab) keeps full
  // functionality; a secondary (split) pane gets editing + view-mode + autosave,
  // with layer/canvas/history scoped to the primary to keep the split coherent.
  function paneEditorProps(tab: Tab | null, preserveLayer = false) {
    const doc = tab ? (openDocs[tab.fileId] ?? null) : null
    const isPrimary = !!tab && tab.key === activeTabKey
    const treeItem = doc ? (treeItemById.get(doc.id) ?? null) : null
    const nestedNotes = (treeItem?.children ?? []).filter((item) => item.type === "file")
    const attachedDatabase = doc
      ? databases.find((database) => database.attachedNoteId === doc.id)
      : undefined
    // Keep a hidden database note's layer mounted while its tab is cached. This
    // avoids tearing down and rebuilding the database workspace on every tab
    // switch, while the visible secondary split remains editor-only.
    const canRenderLayer = isPrimary || preserveLayer
    const pageLayer = canRenderLayer && doc ? (activeLayers[doc.id] ?? "editor") : "editor"
    const contentWidthKey =
      pageLayer === "database" && attachedDatabase
        ? databaseContentWidthKey(attachedDatabase.databaseId)
        : tab?.fileId
    const pageContentWidth = contentWidthKey
      ? (contentWidths[contentWidthKey] ?? defaultContentWidth)
      : defaultContentWidth
    const scrollPositionKey = doc ? `${vault ?? "browser"}:${doc.id}` : undefined
    return {
      document: doc,
      onContentChange: (content: string, sourceDocumentId: string) => {
        if (tab && sourceDocumentId === tab.fileId) {
          handleContentChange(tab.fileId, content)
        }
      },
      onBack: isPrimary ? handleBack : () => {},
      onForward: isPrimary ? handleForward : () => {},
      canGoBack: isPrimary ? canGoBack : false,
      canGoForward: isPrimary ? canGoForward : false,
      onRenameTitle: (name: string) => {
        if (tab) handleRenameFile(tab.fileId, name)
      },
      vault: vault ?? undefined,
      fileIcon: isPrimary ? currentFileIcon : doc ? treeItemById.get(doc.id)?.icon : undefined,
      onFileIconChange:
        isPrimary && doc ? (emoji: string) => handleSetIcon(doc.id, emoji) : undefined,
      onNewFile: () => handleNewFileIn(null),
      onOpenVault: handleOpenVault,
      onTagClick: (_tag: string) => {
        activatePanelAnywhere("tags")
      },
      onWikiLinkClick: handleWikiLinkClick,
      resolveWikiLinkTarget: (target: string): string | null => {
        if (!vault) return target
        const item = findWikiLinkItem(treeItems, target, vault)
        return item?.path ? workspaceRelativePath(item.path, vault) : (item?.name ?? target)
      },
      fetchTransclusion: async (target: string): Promise<string | null> => {
        if (!vault) return null
        const item = findWikiLinkItem(treeItems, target, vault)
        if (!item) return null
        try {
          return (await readNote(vault, item.id)).content
        } catch {
          return null
        }
      },
      activeLayer: pageLayer,
      onLayerChange: isPrimary ? handleLayerChange : async (_layer: EditorLayer) => {},
      onRestoreDeleted: doc ? () => handleRestoreDeleted(doc.id) : undefined,
      viewMode: doc ? (viewModes[doc.id] ?? defaultViewMode) : defaultViewMode,
      onViewModeChange: isPrimary
        ? handleViewModeChange
        : (mode: DocumentViewMode) => {
            if (doc) setViewMode(doc.id, mode)
          },
      contentWidth: pageContentWidth,
      onContentWidthChange: contentWidthKey
        ? (width: ContentWidth) => setContentWidth(contentWidthKey, width)
        : undefined,
      linkedLayers: isPrimary && doc ? (linkedLayersByDoc[doc.id] ?? EMPTY_LAYERS) : EMPTY_LAYERS,
      databasesEnabled,
      canCreateDatabaseLayer: DATABASE_LAYER_CREATION_AVAILABLE && databasesEnabled,
      isLocked: doc ? lockedFileIds.has(doc.id) : false,
      onToggleLock: isPrimary ? handleToggleLock : () => {},
      isFavorite: doc ? favorites.has(doc.id) : false,
      onToggleFavorite: doc ? () => handleToggleFavorite(doc.id) : undefined,
      onOpenInNewTab: doc ? () => handleOpenInNewTab(doc.id) : undefined,
      nestedNotes,
      nestedNotesPlacement: doc ? (nestedNotesPlacements[doc.id] ?? "top") : "top",
      onNestedNotesPlacementChange: doc
        ? (placement: "top" | "bottom" | "hidden") => setNestedNotesPlacement(doc.id, placement)
        : undefined,
      onOpenNestedNoteInNewTab: handleOpenInNewTab,
      onMoveFile: doc
        ? (targetFolderId: string | null) => handleMoveItem(doc.id, targetFolderId)
        : undefined,
      onCreateFolder:
        doc && vault
          ? (parentId: string | null, name: string) => handleNewFolderIn(parentId, name)
          : undefined,
      onMergeFile: doc ? (targetId: string) => handleMergeFile(doc.id, targetId) : undefined,
      onShowInExplorer: doc ? () => openInExplorer(doc.path) : undefined,
      onDeleteFile: doc ? () => handleDeleteFile(doc.id) : undefined,
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
      scrollPositionKey,
      scrollPosition: scrollPositionKey ? scrollPositionsRef.current[scrollPositionKey] : undefined,
      onScrollPositionChange: scrollPositionKey
        ? (position: number) => {
            scrollPositionsRef.current[scrollPositionKey] = position
          }
        : undefined,
      databaseBody:
        canRenderLayer && doc && attachedDatabase ? (
          <DatabaseWorkspace
            databaseId={attachedDatabase.databaseId}
            title={attachedDatabase.title}
            icon={treeItem?.icon ?? attachedDatabase.icon}
            hostKind="layer"
            hostId={doc.id}
            contentWidth={
              contentWidths[databaseContentWidthKey(attachedDatabase.databaseId)] ??
              defaultContentWidth
            }
            onContentWidthChange={(width: ContentWidth) =>
              setContentWidth(databaseContentWidthKey(attachedDatabase.databaseId), width)
            }
            titleColumnName={
              databaseTitleLabels[databaseContentWidthKey(attachedDatabase.databaseId)]
            }
            onTitleColumnNameChange={(name) =>
              setDatabaseTitleLabel(databaseContentWidthKey(attachedDatabase.databaseId), name)
            }
            onIconChange={(next) => handleSetIcon(doc.id, next)}
            onOpenInNewTab={() =>
              openDatabaseTab(attachedDatabase.databaseId, attachedDatabase.title, true)
            }
            onOpenRowFullPage={(row) => handleSelect(row.noteId)}
            onRenameRow={handleRenameDatabaseRow}
            onLoadRowDocument={(row) => loadDoc(row.noteId, row.title)}
            onRowContentChange={handleContentChange}
            vault={vault ?? undefined}
            onCatalogChanged={refreshDatabaseCatalog}
            onRowCreated={async (row) => {
              await refreshTree()
              await loadDoc(row.noteId, row.title)
            }}
          />
        ) : undefined,
    }
  }

  const activeFolder =
    activeTab?.kind === "folder" ? (treeItemById.get(activeTab.fileId) ?? null) : null
  const secondaryTab = secondaryTabKey
    ? (tabs.find((t) => t.key === secondaryTabKey && t.kind === "document") ?? null)
    : null
  const showSplit = canRenderSplit(activeTab, secondaryTab)
  const documentTabs = React.useMemo(() => {
    const openDocumentTabs = tabs.filter((tab) => tab.kind === "document")
    const representativeByFileId = new Map<string, Tab>()
    for (const tab of openDocumentTabs) {
      const current = representativeByFileId.get(tab.fileId)
      if (!current || tab.key === activeTabKey || (showSplit && tab.key === secondaryTabKey)) {
        representativeByFileId.set(tab.fileId, tab)
      }
    }
    // Preserve the header tab order. Moving the active editor wrapper to the
    // front on every selection also moves its (potentially huge) DOM subtree,
    // which forces style/layout work before the newly selected tab can paint.
    return openDocumentTabs.filter((tab) => representativeByFileId.get(tab.fileId) === tab)
  }, [activeTabKey, secondaryTabKey, showSplit, tabs])
  const databaseTabs = React.useMemo(() => tabs.filter((tab) => tab.kind === "database"), [tabs])

  interface EditorPropsCacheEntry {
    props: DocumentEditorProps
    signature: readonly unknown[]
    wasVisible: boolean
  }
  const editorPropsCacheRef = React.useRef(new Map<string, EditorPropsCacheEntry>())
  React.useEffect(() => {
    const openKeys = new Set(documentTabs.map((tab) => tab.key))
    for (const key of editorPropsCacheRef.current.keys()) {
      if (!openKeys.has(key)) editorPropsCacheRef.current.delete(key)
    }
  }, [documentTabs])

  function renderDocumentEditors(isFocusMode: boolean) {
    if (documentTabs.length === 0) {
      return (
        <React.Suspense fallback={<LazyEditorFallback />}>
          <DocumentEditor
            {...paneEditorProps(null)}
            isFocusMode={isFocusMode}
            onToggleFocusMode={isFocusMode ? handleExitFocusMode : handleEnterFocusMode}
          />
        </React.Suspense>
      )
    }

    // Keep every open document editor mounted and only toggle the visible pane.
    // Tiptap/CodeMirror then retain their parsed state and scroll offset when a
    // user returns to a tab instead of rebuilding a large document from Markdown.
    return (
      <div className="relative flex min-h-0 flex-1">
        {documentTabs.map((tab) => {
          const visible = tab.key === activeTabKey || (showSplit && tab.key === secondaryTabKey)
          const primary = tab.key === activeTabKey
          const doc = openDocs[tab.fileId] ?? null
          const treeItem = doc ? (treeItemById.get(doc.id) ?? null) : null
          const attachedDatabase = doc
            ? databases.find((database) => database.attachedNoteId === doc.id)
            : undefined
          const pageLayer = doc ? (activeLayers[doc.id] ?? "editor") : "editor"
          const widthKey =
            pageLayer === "database" && attachedDatabase
              ? databaseContentWidthKey(attachedDatabase.databaseId)
              : tab.fileId
          const signature = [
            tab,
            doc,
            displayTreeItems,
            treeItem,
            attachedDatabase,
            pageLayer,
            doc ? linkedLayersByDoc[doc.id] : undefined,
            doc ? viewModes[doc.id] : undefined,
            contentWidths[widthKey],
            attachedDatabase
              ? databaseTitleLabels[databaseContentWidthKey(attachedDatabase.databaseId)]
              : undefined,
            doc ? (treeItem?.icon ?? iconOverrides[doc.id]) : undefined,
            doc ? lockedFileIds.has(doc.id) : false,
            doc ? favorites.has(doc.id) : false,
            doc ? nestedNotesPlacements[doc.id] : undefined,
            doc ? openCanvases[canvasLayerPath(doc.path)] : undefined,
            vault,
            databasesEnabled,
            defaultViewMode,
            defaultContentWidth,
          ] as const
          const cached = editorPropsCacheRef.current.get(tab.key)
          const sameSignature =
            cached?.signature.length === signature.length &&
            cached.signature.every((value, index) => value === signature[index])
          const shouldRefresh = !cached || (visible && (!cached.wasVisible || !sameSignature))
          const props = shouldRefresh ? paneEditorProps(tab, !visible) : cached.props
          if (shouldRefresh) {
            editorPropsCacheRef.current.set(tab.key, {
              props,
              signature,
              wasVisible: visible || cached?.wasVisible === true,
            })
          }
          return (
            <div
              key={tab.key}
              aria-hidden={!visible}
              className={
                visible
                  ? "flex min-w-0 flex-1"
                  : "invisible pointer-events-none absolute inset-0 flex min-h-0 min-w-0 overflow-hidden"
              }
            >
              <React.Suspense fallback={<LazyEditorFallback />}>
                <CachedDocumentEditor
                  editorProps={props}
                  visible={visible}
                  isFocusMode={isFocusMode}
                  hideNavigation={!primary}
                  focusTabs={primary && visible ? headerTabs : []}
                  activeTabKey={primary && visible ? activeTabKey : undefined}
                  onFocusTabChange={primary && visible ? stableHandleTabChange : undefined}
                  focusFavorites={primary && visible ? favorites : undefined}
                  onFocusToggleFavorite={primary && visible ? handleToggleFavorite : undefined}
                  onFocusCloseAllTabs={primary && visible ? stableHandleCloseAllTabs : undefined}
                  onToggleFocusMode={
                    primary && visible
                      ? isFocusMode
                        ? handleExitFocusMode
                        : handleEnterFocusMode
                      : NOOP
                  }
                />
              </React.Suspense>
            </div>
          )
        })}
      </div>
    )
  }

  function renderCachedTabSurfaces(isFocusMode: boolean) {
    const documentSurfaceVisible = activeTab?.kind !== "database"
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div
          aria-hidden={!documentSurfaceVisible}
          className={
            documentSurfaceVisible
              ? "flex min-h-0 min-w-0 flex-1"
              : "invisible pointer-events-none absolute inset-0 flex min-h-0 min-w-0 overflow-hidden"
          }
        >
          {renderDocumentEditors(isFocusMode)}
        </div>
        {databaseTabs.map((tab) => {
          const visible = activeTab?.kind === "database" && activeTab.key === tab.key
          const icon = treeItemById.get(tab.fileId)?.icon ?? iconOverrides[tab.fileId]
          const contentWidth =
            contentWidths[databaseContentWidthKey(tab.fileId)] ?? defaultContentWidth
          const titleColumnName = databaseTitleLabels[databaseContentWidthKey(tab.fileId)]
          const content = (
            <DatabaseWorkspace
              databaseId={tab.fileId}
              title={tab.title}
              icon={icon}
              hostId={tab.key}
              contentWidth={contentWidth}
              onContentWidthChange={(width) =>
                setContentWidth(databaseContentWidthKey(tab.fileId), width)
              }
              onRenameTitle={(name) => handleRenameDatabaseTab(tab.key, name)}
              onIconChange={(next) => handleSetIcon(tab.fileId, next)}
              titleColumnName={titleColumnName}
              onTitleColumnNameChange={(name) =>
                setDatabaseTitleLabel(databaseContentWidthKey(tab.fileId), name)
              }
              onOpenInNewTab={() => openDatabaseTab(tab.fileId, tab.title, true)}
              onOpenRowFullPage={(row) => handleSelect(row.noteId)}
              onRenameRow={handleRenameDatabaseRow}
              onLoadRowDocument={(row) => loadDoc(row.noteId, row.title)}
              onRowContentChange={handleContentChange}
              vault={vault ?? undefined}
              onCatalogChanged={refreshDatabaseCatalog}
              onRowCreated={async (row) => {
                await refreshTree()
                await loadDoc(row.noteId, row.title)
              }}
            />
          )
          return (
            <div
              key={tab.key}
              aria-hidden={!visible}
              className={
                visible
                  ? "flex min-h-0 min-w-0 flex-1"
                  : "invisible pointer-events-none absolute inset-0 flex min-h-0 min-w-0 overflow-hidden"
              }
            >
              <CachedTabContent
                content={content}
                visible={visible}
                signature={[tab, icon, contentWidth, titleColumnName, vault]}
              />
            </div>
          )
        })}
      </div>
    )
  }

  if (!vault && isTauri()) {
    return (
      <WorkspaceLayout
        deleteConfirmationDialog={null}
        dialogs={null}
        focusContent={null}
        focusLeftOverlay={null}
        focusRightOverlay={null}
        header={null}
        isFocusMode={false}
        leftActivityBar={null}
        leftSidebar={null}
        noVault={
          <div className="flex h-screen flex-col bg-background">
            <EmptyStateHeader />
            <div className="flex flex-1 flex-col items-center justify-center gap-4">
              <p className="text-muted-foreground">{t("workspace.noVault")}</p>
              <button
                onClick={handleOpenVault}
                className="flex items-center gap-2 rounded-lg border border-border bg-card px-5 py-2.5 text-sm text-foreground hover:bg-accent"
              >
                <FolderOpen className="size-4" />
                {t("workspace.openVault")}
              </button>
            </div>
          </div>
        }
        normalContent={null}
        notice={null}
        onFocusPointerMove={() => {}}
        rightActivityBar={null}
        rightSidebar={null}
      />
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
        ) : activeFolder?.type === "folder" ? (
          <FolderView
            folder={activeFolder}
            onOpenItem={handleSelect}
            onNewNote={handleNewFileIn}
            onNewFolder={handleNewFolderIn}
            onIconChange={(icon) => handleSetIcon(activeFolder.id, icon)}
          />
        ) : (
          renderCachedTabSurfaces(true)
        )}

        {/* Left sidebar overlay. */}
        <motion.div
          className="fixed inset-y-0 left-0 z-40 flex flex-col shadow-2xl"
          initial={false}
          animate={{ x: focusShowLeft ? 0 : "-100%" }}
          transition={motionTransitions.panel}
          onMouseLeave={() => setFocusShowLeft(false)}
        >
          <div className="flex min-h-0 flex-1">
            {isDockVisible("left") && (
              <ActivityBar
                side="left"
                buttons={leftButtons}
                activeView={activeBySide.left}
                isPanelOpen={focusShowLeft}
                onActivate={handleActivate}
                onMoveToOtherSide={(defId) => moveButtonToSide(defId, "right")}
                onPointerDownButton={dnd.onPointerDown}
                draggingId={dnd.draggingId}
                {...activityBarPresetProps}
                {...activityDockProps("left")}
              />
            )}
            <div
              style={{ width: "var(--amby-left-panel-width, 300px)" }}
              className="min-h-0 shrink-0"
            >
              <PanelHost side="left" activeId={activeBySide.left} props={panelRenderProps} flush />
            </div>
          </div>
        </motion.div>

        {/* Right sidebar overlay */}
        <motion.div
          className="fixed inset-y-0 right-0 z-40 flex shadow-2xl"
          initial={false}
          animate={{ x: focusShowRight ? 0 : "100%" }}
          transition={motionTransitions.panel}
          onMouseLeave={() => setFocusShowRight(false)}
        >
          <div style={{ width: "var(--amby-right-panel-width, 300px)" }} className="shrink-0">
            <PanelHost side="right" activeId={activeBySide.right} props={panelRenderProps} flush />
          </div>
          {isDockVisible("right") && (
            <ActivityBar
              side="right"
              buttons={rightButtons}
              activeView={activeBySide.right}
              isPanelOpen={focusShowRight}
              onActivate={handleActivate}
              onMoveToOtherSide={(defId) => moveButtonToSide(defId, "left")}
              onPointerDownButton={dnd.onPointerDown}
              draggingId={dnd.draggingId}
              {...activityBarPresetProps}
              {...activityDockProps("right")}
            />
          )}
        </motion.div>

        <QuickOpenModal
          open={quickOpenMode !== null}
          onClose={() => setQuickOpenMode(null)}
          treeItems={displayTreeItems}
          onSelectFile={quickOpenMode === "new" ? handleOpenInNewTab : handleSelect}
          onNewNote={() => handleNewFileIn(null, quickOpenMode === "new")}
        />

        <SearchModal
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          items={displayTreeItems}
          onSelect={handleSelect}
          searchNotes={searchNotes}
        />

        <SettingsDialog
          open={settingsOpen}
          onOpenChange={(open) => {
            setSettingsOpen(open)
            if (!open) setSettingsTarget(null)
          }}
          vault={vault}
          navigationTarget={settingsTarget}
          activeModules={activeModules}
          onModuleEnabledChange={(id, enabled) => setModuleEnabled(id, enabled, { vault })}
          dockPrefs={dockPrefs}
          onDockPrefsChange={updateDockPrefs}
        />
        {dockNoticeToast}
        {deleteConfirmationDialog}
        {propertyMigrationDialog}
      </div>
    )
  }

  // ── Normal layout ──────────────────────────────────────────────
  return (
    <div className="flex h-screen flex-col overflow-hidden">
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
        isLeftDockVisible={isDockVisible("left")}
        isRightDockVisible={isDockVisible("right")}
        isLeftDockPinned={isDockPinned("left")}
        isRightDockPinned={isDockPinned("right")}
        onSetLeftDockVisible={(visible) => setDockVisible("left", visible)}
        onSetRightDockVisible={(visible) => setDockVisible("right", visible)}
        onSetLeftDockPinned={(pinned) => setDockPinned("left", pinned)}
        onSetRightDockPinned={(pinned) => setDockPinned("right", pinned)}
        onOpenPlusModal={() => setQuickOpenMode("new")}
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
        leftTreeWidth={isCompactLayout ? 0 : leftWidth}
        rightPanelWidth={isCompactLayout ? 0 : rightWidth}
        activeFileId={activeTab?.fileId}
        favorites={favorites}
        onToggleFavorite={handleToggleFavorite}
        showWorkspacePicker={false}
      />
      {deleteConfirmationDialog}
      {propertyMigrationDialog}

      <div className="flex flex-1 overflow-hidden">
        {isDockVisible("left") && (
          <ActivityBar
            side="left"
            buttons={leftButtons}
            activeView={activeBySide.left}
            isPanelOpen={isLeftSidebarOpen}
            onActivate={handleActivate}
            onMoveToOtherSide={(defId) => moveButtonToSide(defId, "right")}
            onPointerDownButton={dnd.onPointerDown}
            draggingId={dnd.draggingId}
            {...activityBarPresetProps}
            {...activityDockProps("left")}
          />
        )}

        {isLeftSidebarOpen && (
          <>
            <div
              style={{ width: "var(--amby-left-panel-width, 300px)" }}
              className={
                isCompactLayout
                  ? "fixed inset-y-11 left-10 z-40 max-w-[calc(100vw-2.5rem)] overflow-hidden shadow-2xl"
                  : "relative shrink-0"
              }
            >
              <PanelHost side="left" activeId={activeBySide.left} props={panelRenderProps} />
              {!isCompactLayout && <ResizeHandle side="right" onMouseDown={startResize("left")} />}
            </div>
          </>
        )}

        <main className="flex flex-1 gap-0 overflow-hidden">
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
          ) : activeFolder?.type === "folder" ? (
            <FolderView
              folder={activeFolder}
              onOpenItem={handleSelect}
              onNewNote={handleNewFileIn}
              onNewFolder={handleNewFolderIn}
              onIconChange={(icon) => handleSetIcon(activeFolder.id, icon)}
            />
          ) : (
            renderCachedTabSurfaces(false)
          )}
        </main>

        {isRightSidebarOpen && (
          <>
            <div
              style={{ width: "var(--amby-right-panel-width, 300px)" }}
              className={
                isCompactLayout
                  ? "fixed inset-y-11 right-10 z-40 max-w-[calc(100vw-2.5rem)] overflow-hidden shadow-2xl"
                  : "relative shrink-0"
              }
            >
              {!isCompactLayout && <ResizeHandle side="left" onMouseDown={startResize("right")} />}
              <PanelHost side="right" activeId={activeBySide.right} props={panelRenderProps} />
            </div>
          </>
        )}

        {isDockVisible("right") && (
          <ActivityBar
            side="right"
            buttons={rightButtons}
            activeView={activeBySide.right}
            isPanelOpen={isRightSidebarOpen}
            onActivate={handleActivate}
            onMoveToOtherSide={(defId) => moveButtonToSide(defId, "left")}
            onPointerDownButton={dnd.onPointerDown}
            draggingId={dnd.draggingId}
            {...activityBarPresetProps}
            {...activityDockProps("right")}
          />
        )}
      </div>

      <QuickOpenModal
        open={quickOpenMode !== null}
        onClose={() => setQuickOpenMode(null)}
        treeItems={displayTreeItems}
        onSelectFile={quickOpenMode === "new" ? handleOpenInNewTab : handleSelect}
        onNewNote={() => handleNewFileIn(null, quickOpenMode === "new")}
      />

      <SearchModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        items={displayTreeItems}
        onSelect={handleSelect}
        searchNotes={searchNotes}
      />

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open)
          if (!open) setSettingsTarget(null)
        }}
        vault={vault}
        navigationTarget={settingsTarget}
        activeModules={activeModules}
        onModuleEnabledChange={(id, enabled) => setModuleEnabled(id, enabled, { vault })}
        dockPrefs={dockPrefs}
        onDockPrefsChange={updateDockPrefs}
      />
      {dockNoticeToast}
    </div>
  )
}
