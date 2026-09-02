"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, FolderOpen } from "lucide-react"
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
import type { ActionContext, PanelRenderProps } from "./panel-registry"
import { buttonsForSide } from "./panel-definitions"
import { usePresets } from "./use-presets"
import { useDocStore } from "./use-doc-store"
import { useTabsStore, type Tab } from "./use-tabs-store"
import { useVaultStore } from "./use-vault-store"
import type { DocumentViewMode } from "./document-editor"
import { HeaderTabs, type HeaderTab } from "./header-tabs"
import { QuickOpenModal } from "./quick-open-modal"
import { SearchModal } from "./search-modal"
import { SettingsDialog } from "./settings-dialog"
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
import { wsPathStem, canvasLayerPath, findTreeItem, newTabKey } from "./workspace-tree-utils"
import { WorkspacePicker } from "./workspace-picker"
import { FolderView } from "./folder-view"
import { discardRecoveryDraft, remapRecoveryDraft } from "@/lib/recovery-drafts"
import {
  isTauri,
  readFile,
  readNote,
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

import { EmptyStateHeader, workspaceRelativePath } from "./vault/use-vault-session"
import { useNoteWindows } from "./windows/use-note-windows"

const GRAPH_TAB_FILE_ID = "__graph__"

/** Spinner shown while a lazy chunk (Canvas / Graph) is being fetched. */
function LazyEditorFallback() {
  return (
    <div className="flex h-full flex-1 items-center justify-center">
      <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
    </div>
  )
}

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
  const { applyMutation, patchDoc, markSaved } = useDocStore.getState()
  const tabs = useTabsStore((s) => s.tabs)
  const activeTabKey = useTabsStore((s) => s.activeTabKey)
  const secondaryTabKey = useTabsStore((s) => s.secondaryTabKey)
  // Stable setters (value-or-updater, like setState); see use-tabs-store.
  const { setTabs, setActiveTabKey } = useTabsStore.getState()
  const unsavedFileIds = useDocStore((s) => s.unsavedFileIds)

  // Per-document view state (favorites, viewModes, lockedFileIds, iconOverrides,
  // activeLayers, linkedLayersByDoc) lives in useViewStateStore.
  const favorites = useViewStateStore((s) => s.favorites)
  const viewModes = useViewStateStore((s) => s.viewModes)
  const nestedNotesPlacements = useViewStateStore((s) => s.nestedNotesPlacements)
  const lockedFileIds = useViewStateStore((s) => s.lockedFileIds)
  const activeLayers = useViewStateStore((s) => s.activeLayers)
  const linkedLayersByDoc = useViewStateStore((s) => s.linkedLayersByDoc)
  // Stable store actions (never change reference).
  const {
    toggleFavorite,
    setIcon: setIconInStore,
    setViewMode,
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
  const defaultViewMode = useSettingsStore((s) => s.prefs.editor.defaultViewMode)
  const dockPrefs = useSettingsStore((s) => s.prefs.docks)
  const setPrefs = useSettingsStore((s) => s.setPrefs)
  const [dockNotice, setDockNotice] = React.useState<string | null>(null)

  const updateDockPrefs = React.useCallback(
    (patch: Partial<typeof dockPrefs>) => setPrefs({ docks: { ...dockPrefs, ...patch } }),
    [dockPrefs, setPrefs],
  )

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
  } = usePresets(vault)
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
    openSettings: () => setSettingsOpen(true),
  }

  const activityBarPresetProps = {
    presets: presetOptions,
    activePresetId,
    onSwitchPreset: (id: string) => switchPreset(id, { vault }),
    onImportPreset: handleImportPreset,
    onExportPreset: handleExportPreset,
    panelScope,
    onSetPanelScope: setPanelScope,
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

  // Current file icon (from iconOverrides or tree)
  const activeFileId = activeTab?.fileId ?? null
  const activeTreeItem = activeFileId ? findTreeItem(displayTreeItems, activeFileId) : null
  const currentFileIcon = activeTreeItem?.icon

  const handleSetIcon = React.useCallback(
    (id: string, icon: string) => setIconInStore(id, icon),
    [setIconInStore],
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

  const { handleLayerChange, handleAttachLayerToFile, handleUnlinkLayer, handleDeleteLayer } =
    useLayers({ vault, currentDoc, treeItems, refreshTree, applyMutationResult })

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
    releaseUnusedDocumentBuffers,
    deleteConfirmationDialog,
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

  const { handleOpenInNewWindow } = useNoteWindows(treeItems)

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
      onTabUsageChanged: () => {
        void releaseUnusedDocumentBuffers()
      },
    })

  // Workspace-wide shortcuts deliberately leave plain typing alone. Native editing
  // shortcuts still belong to the focused editor; these only invoke app navigation.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || (!event.metaKey && !event.ctrlKey)) return

      const key = event.key.toLowerCase()
      if (key === "p") {
        event.preventDefault()
        setQuickOpenMode("current")
      } else if (key === "f" && event.shiftKey) {
        event.preventDefault()
        setSearchOpen(true)
      } else if (key === "n" && !event.shiftKey) {
        event.preventDefault()
        handleNewFileIn(null)
      } else if (key === "b" && !event.shiftKey) {
        event.preventDefault()
        setIsLeftSidebarOpen((open) => !open)
      } else if (key === "b" && event.shiftKey) {
        event.preventDefault()
        setIsRightSidebarOpen((open) => !open)
      } else if (key === ",") {
        event.preventDefault()
        setSettingsOpen(true)
      } else if (key === "[" && !event.shiftKey) {
        event.preventDefault()
        handleBack()
      } else if (key === "]" && !event.shiftKey) {
        event.preventDefault()
        handleForward()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [handleBack, handleForward, handleNewFileIn, setIsLeftSidebarOpen, setIsRightSidebarOpen])

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

  const { currentProperties, handleUpsertCustomProperty, handleDeleteCustomProperty } =
    usePropertyActions({ activeTab, currentDoc, displayTreeItems, linkGraph, t, vault })

  const headerTabs: HeaderTab[] = tabs.map((tab) => {
    const item = findTreeItem(displayTreeItems, tab.fileId)
    return {
      key: tab.key,
      fileId: tab.fileId,
      title: tab.title,
      icon: tab.kind === "folder" ? (item?.icon ?? "📁") : item?.icon,
    }
  })

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
      properties: currentProperties,
      linkGraph,
      currentDocId: currentDoc?.id ?? null,
      currentDocPath: currentDoc?.path ?? null,
      onSelectLink: handleSelect,
      onUpsertCustomProperty: handleUpsertCustomProperty,
      onDeleteCustomProperty: handleDeleteCustomProperty,
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
          <button className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-background/70 px-3 py-2 text-sm transition-colors hover:bg-accent">
            <span className="truncate font-medium">{vaultName ?? t("workspace.name")}</span>
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
      handleUpsertCustomProperty,
      handleDeleteCustomProperty,
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

  const NO_LAYERS = { canvas: false, sketch: false, database: false }

  // Build editor props for a given tab. The primary pane (active tab) keeps full
  // functionality; a secondary (split) pane gets editing + view-mode + autosave,
  // with layer/canvas/history scoped to the primary to keep the split coherent.
  function paneEditorProps(tab: Tab | null) {
    const doc = tab ? (openDocs[tab.fileId] ?? null) : null
    const isPrimary = !!tab && tab.key === activeTabKey
    const treeItem = doc ? findTreeItem(displayTreeItems, doc.id) : null
    const nestedNotes = (treeItem?.children ?? []).filter((item) => item.type === "file")
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
      fileIcon: isPrimary
        ? currentFileIcon
        : doc
          ? findTreeItem(displayTreeItems, doc.id)?.icon
          : undefined,
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
    }
  }

  const editorProps = paneEditorProps(activeTab)
  const activeFolder =
    activeTab?.kind === "folder" ? findTreeItem(displayTreeItems, activeTab.fileId) : null
  const secondaryTab = secondaryTabKey
    ? (tabs.find((t) => t.key === secondaryTabKey && t.kind === "document") ?? null)
    : null
  const secondaryProps = secondaryTab ? paneEditorProps(secondaryTab) : null
  const showSplit = !!secondaryProps && canRenderSplit(activeTab, secondaryTab)

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
                className="flex items-center gap-2 rounded-lg border border-border bg-card px-5 py-2.5 text-sm text-foreground transition-colors hover:bg-accent"
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
        ) : showSplit ? (
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1">
              <React.Suspense fallback={<LazyEditorFallback />}>
                <DocumentEditor
                  key={`focus-pane-primary:${activeTab?.fileId ?? "empty"}`}
                  {...editorProps}
                  isFocusMode={true}
                  onToggleFocusMode={handleExitFocusMode}
                  focusTabs={headerTabs}
                  activeTabKey={activeTabKey}
                  onFocusTabChange={handleTabChange}
                  focusFavorites={favorites}
                  onFocusToggleFavorite={handleToggleFavorite}
                  onFocusCloseAllTabs={handleCloseAllTabs}
                />
              </React.Suspense>
            </div>
            <div className="flex min-w-0 flex-1">
              <React.Suspense fallback={<LazyEditorFallback />}>
                <DocumentEditor
                  key={`focus-pane-secondary:${secondaryTab?.fileId ?? "empty"}`}
                  {...secondaryProps!}
                  isFocusMode={true}
                  hideNavigation={true}
                  onToggleFocusMode={handleExitFocusMode}
                />
              </React.Suspense>
            </div>
          </div>
        ) : (
          <React.Suspense fallback={<LazyEditorFallback />}>
            <DocumentEditor
              key={`focus:${activeTab?.fileId ?? "empty"}`}
              {...editorProps}
              isFocusMode={true}
              onToggleFocusMode={handleExitFocusMode}
              focusTabs={headerTabs}
              activeTabKey={activeTabKey}
              onFocusTabChange={handleTabChange}
              focusFavorites={favorites}
              onFocusToggleFavorite={handleToggleFavorite}
              onFocusCloseAllTabs={handleCloseAllTabs}
            />
          </React.Suspense>
        )}

        {/* Left sidebar overlay. */}
        <div
          className={`fixed inset-y-0 left-0 z-40 flex flex-col transition-transform duration-200 ease-out shadow-2xl ${focusShowLeft ? "translate-x-0" : "-translate-x-full"}`}
          onMouseLeave={() => setFocusShowLeft(false)}
        >
          <div className="flex min-h-0 flex-1">
            {isDockVisible("left") && (
              <ActivityBar
                side="left"
                buttons={leftButtons}
                activeView={activeBySide.left}
                onActivate={handleActivate}
                onMoveToOtherSide={(defId) => moveButtonToSide(defId, "right")}
                onPointerDownButton={dnd.onPointerDown}
                draggingId={dnd.draggingId}
                {...activityBarPresetProps}
                {...activityDockProps("left")}
              />
            )}
            <div style={{ width: leftWidth }} className="min-h-0 shrink-0">
              <PanelHost side="left" activeId={activeBySide.left} props={panelRenderProps} flush />
            </div>
          </div>
        </div>

        {/* Right sidebar overlay */}
        <div
          className={`fixed inset-y-0 right-0 z-40 flex transition-transform duration-200 ease-out shadow-2xl ${focusShowRight ? "translate-x-0" : "translate-x-full"}`}
          onMouseLeave={() => setFocusShowRight(false)}
        >
          <div style={{ width: rightWidth }} className="shrink-0">
            <PanelHost side="right" activeId={activeBySide.right} props={panelRenderProps} flush />
          </div>
          {isDockVisible("right") && (
            <ActivityBar
              side="right"
              buttons={rightButtons}
              activeView={activeBySide.right}
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
          onOpenChange={setSettingsOpen}
          activeModules={activeModules}
          onModuleEnabledChange={(id, enabled) => setModuleEnabled(id, enabled, { vault })}
          dockPrefs={dockPrefs}
          onDockPrefsChange={updateDockPrefs}
        />
        {dockNoticeToast}
        {deleteConfirmationDialog}
      </div>
    )
  }

  // ── Normal layout ──────────────────────────────────────────────
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--workspace-bg)]">
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

      <div className="flex flex-1 overflow-hidden bg-[var(--workspace-bg)]">
        {isDockVisible("left") && (
          <ActivityBar
            side="left"
            buttons={leftButtons}
            activeView={activeBySide.left}
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
              style={{ width: leftWidth }}
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

        <main className="flex flex-1 gap-0 overflow-hidden bg-[var(--workspace-bg)]">
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
          ) : showSplit ? (
            <>
              <div className="flex min-w-0 flex-1">
                <React.Suspense fallback={<LazyEditorFallback />}>
                  <DocumentEditor
                    key={`pane-primary:${activeTab?.fileId ?? "empty"}`}
                    {...editorProps}
                    isFocusMode={false}
                    onToggleFocusMode={handleEnterFocusMode}
                  />
                </React.Suspense>
              </div>
              <div className="flex min-w-0 flex-1">
                <React.Suspense fallback={<LazyEditorFallback />}>
                  <DocumentEditor
                    key={`pane-secondary:${secondaryTab?.fileId ?? "empty"}`}
                    {...secondaryProps!}
                    isFocusMode={false}
                    onToggleFocusMode={() => {}}
                  />
                </React.Suspense>
              </div>
            </>
          ) : (
            <React.Suspense fallback={<LazyEditorFallback />}>
              <DocumentEditor
                key={`document:${activeTab?.fileId ?? "empty"}`}
                {...editorProps}
                isFocusMode={false}
                onToggleFocusMode={handleEnterFocusMode}
              />
            </React.Suspense>
          )}
        </main>

        {isRightSidebarOpen && (
          <>
            <div
              style={{ width: rightWidth }}
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
        onOpenChange={setSettingsOpen}
        activeModules={activeModules}
        onModuleEnabledChange={(id, enabled) => setModuleEnabled(id, enabled, { vault })}
        dockPrefs={dockPrefs}
        onDockPrefsChange={updateDockPrefs}
      />
      {dockNoticeToast}
    </div>
  )
}
