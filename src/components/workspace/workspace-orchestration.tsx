"use client"

import { useTagFocusStore } from "./tags/tag-focus-store"
import { findModule } from "./modules"
import { GRAPH_TAB_FILE_ID, useTabsStore } from "./use-tabs-store"
import type { ActionContext } from "./panel-registry"
import { computeSplitLayout } from "./split-tree"
import { nextAvailableNoteName } from "./workspace-tree-utils"
import { parseCreativeFileId } from "./creative/creative-history"
import { flushEditorSerializations } from "./tiptap/editor-serialization-lifecycle"
import {
  rebuildDatabaseProjection,
  readNote,
  restoreDeletedNote,
  openInExplorer,
  exportTextFile,
  importTextFile,
  type DatabaseRow,
  type FsMutationResult,
} from "@/lib/storage"
import { IS_SITE_DEMO } from "@/lib/site-demo"
import { registerDatabaseNavigation } from "./database/database-navigation"
import * as React from "react"
import { useTranslation } from "react-i18next"
import { useRefreshSync } from "./sync/use-refresh-sync"
import { createFallbackDocument } from "./orchestration/fallback-document"
import {
  EMPTY_CONTENT_WIDTHS,
  EMPTY_DATABASE_TITLE_LABELS,
} from "./orchestration/workspace-constants"
import { buttonsForSide } from "./panel-definitions"
import { usePresets } from "./use-presets"
import { useDocStore } from "./use-doc-store"
import { useVaultStore } from "./use-vault-store"
import type { DocumentViewMode } from "./document-editor"
import { type WindowPreferences, setPendingWorkspaceProfile } from "./app-config"
import type { HeaderTab } from "./header-tabs"
import { spotlightCreateActions } from "./spotlight-create-actions"
import type { HelpContext } from "./help-modal"
import { WorkspaceProfileModal } from "./modules/workspace-profile-modal"
import type { ProfileId } from "@/lib/modules"
import { OPEN_SETTINGS_REQUEST_EVENT, type SettingsNavigationTarget } from "./settings-navigation"
import { useSettingsStore } from "./use-settings-store"
import { useLinkSuggestionSources } from "./orchestration/use-link-suggestion-sources"
import { useRefreshTreeOnArchiveChange } from "./use-archive-tree-refresh"
import { applyTreePatch, filterDeletedTabs, planMutation } from "./workspace-mutations"
import { useViewStateStore, type EditorLayer, isLayerLocked } from "./use-view-state-store"
import { useVaultData } from "./use-vault-data"
import { useFileActions } from "./use-file-actions"
import { useLayers } from "./use-layers"
import { useTabActions } from "./use-tab-actions"
import {
  recordLocalTreeMutation,
  watcherChangeAffectsDocument,
} from "./watcher-tree-reconciliation"
import { flushAutosaveGeneration } from "./autosave/autosave-lifecycle"
import { errorType, logger } from "@/lib/logger"
import type { TreeItem } from "./sidebar-tree"
import { useDatabaseController } from "./database/use-database-controller"
import { useProjectController } from "./creative/use-project-controller"
import { useProjectStore } from "./creative/project-store"
import { useCollectionFolderSelect } from "./creative/use-collection-folder-select"
import { useCreativeTreeItems } from "./creative/use-creative-tree-items"
import { resolveProjectTarget } from "./creative/project-tree-model"
import { projectTargetIcon } from "./creative/section-icons"
import { useDatabaseStore } from "./database/database-store"
import type { DatabaseRowActions } from "./database/use-row-menu"
import { discardRecoveryDraft, remapRecoveryDraft } from "@/lib/recovery-drafts"
import { useCanvasWorkspace } from "./orchestration/use-canvas-workspace"
import { useSketchWorkspace } from "./orchestration/use-sketch-workspace"
import { usePropertyActions } from "./orchestration/use-property-actions"
import { useVaultActions } from "./orchestration/use-vault-actions"
import { WorkspaceLayout } from "./workspace-layout"
import { matchesShortcut } from "./keyboard-shortcuts"
import { StartScreen } from "./vault/start-screen"
import { useNoteWindows } from "./windows/use-note-windows"
import { usePaneRenderers } from "./orchestration/use-pane-renderers"
import { WorkspaceNormalLayout } from "./orchestration/workspace-normal-layout"
import { WorkspaceFocusLayout } from "./orchestration/workspace-focus-layout"
import { usePanelRenderProps } from "./orchestration/use-panel-render-props"
import { useWorkspaceSplits } from "./orchestration/use-workspace-splits"
import { useLayerLoadEffects } from "./orchestration/use-layer-load-effects"
import { useWorkspaceDock } from "./orchestration/use-workspace-dock"
import { useCreativeNavigation } from "./orchestration/use-creative-navigation"

export const AMBY_MANUAL_SAVE_EVENT = "amby:manual-save"

export function WorkspaceOrchestration() {
  const { t } = useTranslation()
  const vault = useVaultStore((s) => s.vault)
  const autosaveGeneration = useVaultStore((s) => s.generation)
  const backendGeneration = useVaultStore((s) => s.backendGeneration)
  const recoveryScope = React.useMemo(
    () => ({ vault, generation: backendGeneration }),
    [backendGeneration, vault],
  )
  const vaults = useVaultStore((s) => s.vaults)
  const startupResolved = useVaultStore((s) => s.startupResolved)
  const { setVaults } = useVaultStore.getState()

  const {
    autosave: canvasAutosave,
    autosaveKey: canvasAutosaveKey,
    fileRevisions: canvasRevisions,
    handleCanvasSave,
    loadCanvasBuffer,
    openCanvases,
    reloadExternalCanvas,
    setOpenCanvases,
  } = useCanvasWorkspace(autosaveGeneration, t, recoveryScope)

  const {
    autosave: sketchAutosave,
    autosaveKey: sketchAutosaveKey,
    fileRevisions: sketchRevisions,
    handleSketchSave,
    loadSketchBuffer,
    openSketches,
    reloadExternalSketch,
    setOpenSketches,
  } = useSketchWorkspace(autosaveGeneration, t, recoveryScope)

  const onExternalChange = React.useCallback(
    async (changes: Array<{ kind: string; path: string }>) => {
      for (const change of changes) {
        for (const canvasPath of Object.keys(openCanvases)) {
          if (watcherChangeAffectsDocument(canvasPath, change.path, vault)) {
            await reloadExternalCanvas(canvasPath)
          }
        }
        for (const sketchPath of Object.keys(openSketches)) {
          if (watcherChangeAffectsDocument(sketchPath, change.path, vault)) {
            await reloadExternalSketch(sketchPath)
          }
        }
      }
    },
    [openCanvases, openSketches, reloadExternalCanvas, reloadExternalSketch, vault],
  )

  const {
    treeItems,
    setTreeItems,
    displayTreeItems,
    linkGraph,
    refreshLinkGraph,
    loadVault,
    refreshTree,
    refreshTreePaths,
    patchTree,
    reloadVaultData,
    windowLabel,
  } = useVaultData({ onExternalChange })
  useLinkSuggestionSources(vault, treeItems)
  useRefreshTreeOnArchiveChange(refreshTree, refreshTreePaths)

  // Action is stable in zustand, so read it once without subscribing.
  const { applyMutation, patchDoc, markSaved, clearExternalConflict } = useDocStore.getState()
  const tabs = useTabsStore((s) => s.tabs)
  const activeTabKey = useTabsStore((s) => s.activeTabKey)
  const secondaryTabKey = useTabsStore((s) => s.secondaryTabKey)
  const rootPane = useTabsStore((s) => s.rootPane)
  const activePaneId = useTabsStore((s) => s.activePaneId)
  const splitLayout = React.useMemo(() => computeSplitLayout(rootPane), [rootPane])
  const isMultiPane = splitLayout.leaves.length > 1
  const mainStageRef = React.useRef<HTMLElement | null>(null)
  const activeTab = tabs.find((tab) => tab.key === activeTabKey) ?? null
  // Subscribe only to whether the active document has been loaded. The editor
  // owns content updates; this small subscription fixes the startup race
  // without rerendering the whole workspace on every keystroke.
  const activeDocumentLoaded = useDocStore((state) => {
    if (!activeTab) return false
    if (
      activeTab.kind === "canvas" ||
      activeTab.kind === "sketch" ||
      activeTab.kind === "database" ||
      activeTab.fileId.endsWith(".canvas") ||
      activeTab.fileId.endsWith(".excalidraw")
    ) {
      return true
    }
    return Boolean(state.openDocs[activeTab.fileId])
  })
  // Document buffers are read imperatively here. Visible editors subscribe to
  // their own document below, so patchDoc cannot rerender the whole workspace.
  const openDocs = useDocStore.getState().openDocs
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
  const primaryLayers = useViewStateStore((s) => s.primaryLayers)
  const linkedLayersByDoc = useViewStateStore((s) => s.linkedLayersByDoc)

  const currentHelpContext: HelpContext = React.useMemo(() => {
    if (!activeTab) return "workspace"
    if (activeTab.kind === "canvas") return "canvas"
    if (activeTab.kind === "sketch") return "sketch"
    if (activeTab.kind === "database") return "database"
    if (activeTab.kind === "document") {
      const layer = activeLayers[activeTab.fileId] ?? "editor"
      if (layer === "canvas") return "canvas"
      if (layer === "sketch") return "sketch"
      if (layer === "database") return "database"
      return "note"
    }
    return "workspace"
  }, [activeTab, activeLayers])
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
  const [isHelpOpen, setIsHelpOpen] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [vaultManagerOpen, setVaultManagerOpen] = React.useState(false)
  React.useEffect(() => {
    if (!vault) setVaultManagerOpen(false)
  }, [vault])
  const [settingsTarget, setSettingsTarget] = React.useState<SettingsNavigationTarget | null>(null)
  const defaultViewMode = useSettingsStore((s) => s.prefs.editor.defaultViewMode)
  const defaultContentWidth = useSettingsStore((s) => s.prefs.editor.contentWidth)
  const dockPrefs = useSettingsStore((s) => s.prefs.docks)
  const windowPrefs = useSettingsStore((s) => s.prefs.window)
  const shortcuts = useSettingsStore((s) => s.prefs.shortcuts)
  const experimental = useSettingsStore((s) => s.experimental)
  const setPrefs = useSettingsStore((s) => s.setPrefs)

  const updateDockPrefs = React.useCallback(
    (patch: Partial<typeof dockPrefs>) => setPrefs({ docks: { ...dockPrefs, ...patch } }),
    [dockPrefs, setPrefs],
  )

  const updateWindowPrefs = React.useCallback(
    (patch: Partial<WindowPreferences>) => {
      const current = useSettingsStore.getState().prefs.window
      void setPrefs({ window: { ...current, ...patch } }).catch(() => {})
    },
    [setPrefs],
  )

  const openSettings = React.useCallback((target: SettingsNavigationTarget | null = null) => {
    if (IS_SITE_DEMO) return
    setSettingsTarget(target)
    setSettingsOpen(true)
  }, [])
  // The notices of the sync (a card with "Show the list") ask for the sync section this way.
  React.useEffect(() => {
    const onRequest = (event: Event) => {
      const target = (event as CustomEvent<SettingsNavigationTarget | undefined>).detail
      openSettings(target ?? null)
    }
    window.addEventListener(OPEN_SETTINGS_REQUEST_EVENT, onRequest)
    return () => window.removeEventListener(OPEN_SETTINGS_REQUEST_EVENT, onRequest)
  }, [openSettings])

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
    adoptPreset,
    importPreset,
    exportPreset,
    modified: presetModified,
    canSaveActive: canSaveActivePreset,
    savePresetAs,
    saveActivePreset,
    resetActivePreset,
  } = usePresets(vault, experimental)
  const databasesEnabled =
    activeModules.includes("databases") || activeModules.includes("amby.databases")
  const canvasEnabled = activeModules.includes("canvas") || activeModules.includes("amby.canvas")
  const sketchEnabled =
    activeModules.includes("excalidraw") || activeModules.includes("amby.excalidraw")
  const favoritesModuleOn =
    activeModules.includes("favorites") || activeModules.includes("amby.favorites")
  const favoritesInTreePref = useSettingsStore((s) => s.prefs.favoritesInTree)
  const favoritesPanelPref = useSettingsStore((s) => s.prefs.favoritesPanel)
  const favoritesEnabled = favoritesModuleOn && favoritesInTreePref
  const graphEnabled = activeModules.includes("graph") || activeModules.includes("amby.graph")
  const creativeEnabled =
    activeModules.includes("creative") || activeModules.includes("amby.creative")
  const databases = useDatabaseStore((state) => state.databases)
  const { refreshCatalog: refreshDatabaseCatalog } = useDatabaseController({
    enabled: databasesEnabled,
    vaultGeneration: backendGeneration,
  })
  useProjectController({
    enabled: databasesEnabled && creativeEnabled,
    vaultGeneration: backendGeneration,
  })
  const projectCatalog = useProjectStore((state) => state.catalog)
  // The module presents its folders in the file panel only while it is on.
  const fileTreeItems = useCreativeTreeItems(
    displayTreeItems,
    vault,
    databasesEnabled && creativeEnabled,
  )
  const presetOptions = React.useMemo(
    () =>
      presets.map((p) => {
        const names = p.activeModules
          .map((id) => findModule(id))
          .filter((module): module is NonNullable<typeof module> => Boolean(module))
          .map((module) => t(module.labelKey))
        return {
          id: p.id,
          label: p.label ?? t(p.labelKey ?? "presets.standard"),
          // What a preset holds is told in a tooltip only.
          hint:
            names.length > 0
              ? t("activityBar.presetModules", { modules: names.join(", ") })
              : t("activityBar.presetNoModules"),
        }
      }),
    [presets, t],
  )
  const [presetNameOpen, setPresetNameOpen] = React.useState(false)

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

  const canGoBack = (activeTab?.historyIndex ?? 0) > 0
  const canGoForward = activeTab ? activeTab.historyIndex < activeTab.history.length - 1 : false

  /** Opens the tags panel with the tag searched and unfolded. */
  function showTagInPanel(tag: string) {
    useTagFocusStore.getState().focusTag(tag)
    activatePanelAnywhere("tags")
  }

  // The graph opens in the current tab like a note, so Back and Forward pass through it.
  function openGraphTab() {
    flushEditorSerializations()
    useTabsStore
      .getState()
      .openItem({ kind: "graph", fileId: GRAPH_TAB_FILE_ID, title: t("workspace.graphTab") })
  }

  const { openDatabaseTab, openCreativeTab, stableOpenCreativeTab, openCreativeSection } =
    useCreativeNavigation({
      projectCatalog,
    })

  async function loadCanvas(path: string) {
    if (openCanvases[path] === undefined) {
      const content = await loadCanvasBuffer(path)
      setOpenCanvases((p) => (p[path] !== undefined ? p : { ...p, [path]: content }))
    }
  }

  async function loadSketch(path: string) {
    if (openSketches[path] === undefined) {
      const content = await loadSketchBuffer(path)
      setOpenSketches((p) => (p[path] !== undefined ? p : { ...p, [path]: content }))
    }
  }

  async function refreshLocalVault() {
    try {
      await flushAutosaveGeneration(useVaultStore.getState().generation)
    } catch (e) {
      logger.warn("refresh_vault.flush_failed", { errorType: errorType(e) })
    }

    try {
      await reloadVaultData()

      const currentDocs = useDocStore.getState().openDocs
      const unsavedIds = useDocStore.getState().unsavedFileIds
      for (const [id, doc] of Object.entries(currentDocs)) {
        if (!unsavedIds.has(id)) {
          try {
            if (vault && !doc.path.endsWith(".canvas") && !doc.path.endsWith(".excalidraw")) {
              const note = await readNote(vault, id)
              useDocStore.getState().patchDoc(id, {
                content: note.content,
                revision: note.revision,
                source: note.source,
              })
            }
          } catch {
            /* ignore */
          }
        }
      }

      for (const path of Object.keys(openCanvases)) {
        await reloadExternalCanvas(path)
      }

      for (const path of Object.keys(openSketches)) {
        await reloadExternalSketch(path)
      }

      if (databasesEnabled) {
        try {
          await rebuildDatabaseProjection()
          if (refreshDatabaseCatalog) {
            await refreshDatabaseCatalog()
          }
          useDatabaseStore.getState().invalidateHosts()
        } catch (e) {
          logger.warn("refresh_vault.database_sync_failed", { errorType: errorType(e) })
        }
      }
    } catch (error) {
      logger.error("refresh_vault.failed", { errorType: errorType(error) })
      throw error
    }
  }

  const refreshSync = useRefreshSync(refreshLocalVault)

  const actionContext: ActionContext = {
    openGraphTab,
    refreshVault: refreshSync.refresh,
    openSearch: () => setSearchOpen(true),
    openSettings,
    openHelp: () => setIsHelpOpen(true),
  }

  const {
    activatePanelAnywhere,
    toggleSidebar,
    shownButtons,
    isDockPinned,
    handleExitFocusMode,
    handleEnterFocusMode,
    isFocusMode,
    isLeftSidebarVisible,
    isRightSidebarVisible,
    rightPanelEnabled,
    setFocusShowLeft,
    setFocusShowRight,
    focusShowLeft,
    handleActivate,
    moveButtonToSide,
    dnd,
    activityBarPresetProps,
    activityDockProps,
    focusShowRight,
    setDockPinned,
    isCompactLayout,
    leftWidth,
    rightWidth,
    isLeftSidebarOpen,
    resizingSide,
    setSidebarHover,
    startResize,
    isRightSidebarOpen,
  } = useWorkspaceDock({
    refreshSync,
    presetOptions,
    activePresetId,
    switchPreset,
    vault,
    handleImportPreset,
    handleExportPreset,
    presetModified,
    canSaveActivePreset,
    saveActivePreset,
    setPresetNameOpen,
    resetActivePreset,
    panelScope,
    setPanelScope,
    openSettings,
    dockPrefs,
    activityButtons,
    setActivityButtons,
    activeBySide,
    setActiveBySide,
    actionContext,
    updateDockPrefs,
    windowPrefs,
    updateWindowPrefs,
    favoritesPanelPref,
    setPrefs,
  })

  const vaultName = vault?.replace(/\\/g, "/").split("/").pop() ?? undefined

  // Header tabs and cached editors both look up tree metadata on every
  // workspace render. Index the recursive tree once so switching tabs is not
  // multiplied by the number of open tabs and tree nodes.
  const treeItemById = React.useMemo(() => {
    const result = new Map<string, TreeItem>()
    const visit = (items: TreeItem[]) => {
      for (const item of items) {
        result.set(item.id, item)
        if (item.path) result.set(item.path, item)
        if (item.children) visit(item.children)
      }
    }
    visit(displayTreeItems)
    return result
  }, [displayTreeItems])

  // Canvas and sketch tabs hold the file path while their tree rows are `canvas:`/`sketch:`
  // prefixed, so resolve the tab to its row to highlight it.
  const selectedId =
    activeTab &&
    (activeTab.kind === "document" ||
      activeTab.kind === "folder" ||
      activeTab.kind === "database" ||
      activeTab.kind === "canvas" ||
      activeTab.kind === "sketch")
      ? (treeItemById.get(activeTab.fileId)?.id ?? activeTab.fileId)
      : ""

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
  // A page tells its tab the name it has now; an unchanged name leaves the tabs as they are.
  const retitleTab = React.useCallback(
    (tabKey: string, title: string) => {
      setTabs((previous) =>
        previous.some((tab) => tab.key === tabKey && tab.title !== title)
          ? previous.map((tab) => (tab.key === tabKey ? { ...tab, title } : tab))
          : previous,
      )
    },
    [setTabs],
  )

  /**
   * Apply a mutation to the stores and the tree. `true` when the tree was brought up to date by
   * the patch the backend built from the disk; `false` when it only got the optimistic
   * approximation, and the caller should ask the backend to refresh the touched paths.
   */
  function applyMutationResult(result: FsMutationResult): boolean {
    recordLocalTreeMutation(result)
    const { deletedIds, remapFn, hasChanges } = planMutation(result)
    const patched = result.treePatch
      ? patchTree(result.treePatch, [
          ...result.pathChanges.map((change) => change.oldPath).filter(Boolean),
          ...result.deletedPaths,
        ])
      : false
    if (!patched) setTreeItems((prev) => applyTreePatch(prev, result))
    if (!hasChanges) return patched

    const deleted = new Set(deletedIds)
    // Fan out to each store with the same deletedIds.
    applyMutation(deletedIds, remapFn) // doc store: remaps content paths + drops deleted
    applyViewMutation(deletedIds, remapFn)

    for (const [id, doc] of Object.entries(openDocs)) {
      if (!deleted.has(id)) {
        const nextPath = remapFn(doc.path)
        if (nextPath !== doc.path) {
          void remapRecoveryDraft(id, id, "markdown", nextPath, recoveryScope)
          void remapRecoveryDraft(doc.path, nextPath, "markdown", nextPath, recoveryScope)
        }
      }
    }

    const deletedCanvasPaths = new Set(result.deletedPaths)
    setOpenCanvases((previous) => {
      const next: Record<string, string> = {}
      for (const [path, json] of Object.entries(previous)) {
        if (deletedCanvasPaths.has(path)) {
          canvasAutosave.discard(canvasAutosaveKey(path))
          void discardRecoveryDraft(path, recoveryScope)
          continue
        }
        const nextPath = remapFn(path)
        if (nextPath !== path) {
          canvasAutosave.remapKey(canvasAutosaveKey(path), canvasAutosaveKey(nextPath))
          canvasRevisions.rename(path, nextPath)
          void remapRecoveryDraft(path, nextPath, "canvas", nextPath, recoveryScope)
        }
        next[nextPath] = json
      }
      return next
    })

    const deletedSketchPaths = new Set(result.deletedPaths)
    setOpenSketches((previous) => {
      const next: Record<string, string> = {}
      for (const [path, json] of Object.entries(previous)) {
        if (deletedSketchPaths.has(path)) {
          sketchAutosave.discard(sketchAutosaveKey(path))
          void discardRecoveryDraft(path, recoveryScope)
          continue
        }
        const nextPath = remapFn(path)
        if (nextPath !== path) {
          sketchAutosave.remapKey(sketchAutosaveKey(path), sketchAutosaveKey(nextPath))
          sketchRevisions.rename(path, nextPath)
          void remapRecoveryDraft(path, nextPath, "sketch", nextPath, recoveryScope)
        }
        next[nextPath] = json
      }
      return next
    })

    setTabs((prev) => {
      const next = filterDeletedTabs(prev, deletedIds, openDocs, remapFn)
      if (next.length !== prev.length && activeTabKey) {
        const stillExists = next.find((tab) => tab.key === activeTabKey)
        if (!stillExists) setActiveTabKey(next[next.length - 1]?.key ?? "")
      }
      return next
    })
    return patched
  }

  const currentDoc = React.useMemo(() => {
    if (!activeTab) return null
    const existing = openDocs[activeTab.fileId] ?? null
    if (existing) return existing
    const isSpecialDoc =
      activeTab.kind === "canvas" ||
      activeTab.kind === "sketch" ||
      activeTab.kind === "database" ||
      activeTab.fileId.endsWith(".canvas") ||
      activeTab.fileId.endsWith(".excalidraw")
    if (isSpecialDoc) {
      const treeItem = treeItemById.get(activeTab.fileId)
      return createFallbackDocument(
        activeTab.fileId,
        activeTab.title,
        treeItem?.path ?? activeTab.fileId,
        treeItem?.created,
        treeItem?.modified,
      )
    }
    return activeDocumentLoaded ? (openDocs[activeTab.fileId] ?? null) : null
  }, [activeDocumentLoaded, activeTab, openDocs, treeItemById])
  const currentDocId = currentDoc?.id ?? null
  const currentDocPath = currentDoc?.path ?? null
  const currentDocDefaultLayer: EditorLayer =
    (currentDocId ? useViewStateStore.getState().primaryLayers[currentDocId] : undefined) ??
    (currentDocPath ? useViewStateStore.getState().primaryLayers[currentDocPath] : undefined) ??
    (activeTab?.kind === "canvas" || currentDocPath?.endsWith(".canvas")
      ? "canvas"
      : activeTab?.kind === "sketch" || currentDocPath?.endsWith(".excalidraw")
        ? "sketch"
        : activeTab?.kind === "database"
          ? "database"
          : "editor")

  React.useEffect(() => {
    if (!activeTab) return
    const isSpecialDoc =
      activeTab.kind === "canvas" ||
      activeTab.kind === "sketch" ||
      activeTab.kind === "database" ||
      activeTab.fileId.endsWith(".canvas") ||
      activeTab.fileId.endsWith(".excalidraw")
    if (!isSpecialDoc) return
    const docId = activeTab.fileId
    const existing = useDocStore.getState().openDocs[docId]
    if (!existing) {
      const treeItem = treeItemById.get(docId)
      const path = treeItem?.path ?? docId
      const docObj = createFallbackDocument(
        docId,
        activeTab.title,
        path,
        treeItem?.created,
        treeItem?.modified,
      )
      useDocStore.getState().setDoc(docId, docObj)
      if (path && path !== docId) {
        useDocStore.getState().setDoc(path, docObj)
      }
      const defaultLayer: EditorLayer =
        useViewStateStore.getState().primaryLayers[docId] ??
        (path ? useViewStateStore.getState().primaryLayers[path] : undefined) ??
        (activeTab.kind === "canvas" || path.endsWith(".canvas")
          ? "canvas"
          : activeTab.kind === "sketch" || path.endsWith(".excalidraw")
            ? "sketch"
            : activeTab.kind === "database"
              ? "database"
              : "editor")
      if (!useViewStateStore.getState().activeLayers[docId]) {
        useViewStateStore.getState().setActiveLayer(docId, defaultLayer)
      }
    }
  }, [activeTab, treeItemById])

  const handleRestoreDeleted = React.useCallback(
    async (fileId: string) => {
      if (!vault) return
      const document = useDocStore.getState().openDocs[fileId]
      if (!document?.externallyDeleted) return
      if (
        fileId.startsWith("database:") ||
        fileId.endsWith(".canvas") ||
        fileId.endsWith(".excalidraw")
      ) {
        return
      }
      try {
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
        await refreshTreePaths([document.path], vault)
      } catch (error) {
        logger.warn("document.restore_deleted_failed", { errorType: errorType(error) })
        throw error
      }
    },
    [
      backendGeneration,
      clearExternalConflict,
      markSaved,
      patchDoc,
      refreshTreePaths,
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
    refreshTreePaths,
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
    handleDeleteFiles,
    handleNewFileIn,
    handleNewFolderIn,
    handleNewCanvasIn,
    handleAttachCanvasToNote,
    handleNewSketchIn,
    handleAttachSketchToNote,
    handleMoveItem,
    handleMergeFile,
    handleContentChange,
    handleContentDirty,
    loadDoc,
    releaseUnusedDocumentBuffers,
    deleteConfirmationDialog,
    propertyMigrationDialog,
  } = useFileActions({
    vault,
    treeItems: displayTreeItems,
    setTreeItems,
    refreshTree,
    refreshTreePaths,
    applyMutationResult,
    loadCanvas,
    setOpenCanvases,
    loadSketch,
    setOpenSketches,
    setPendingRenameId,
    autosaveGeneration,
    backendGeneration,
    windowLabel,
    refreshDatabaseCatalog,
  })

  // Embedded database views open pages and databases through the app, not on their own.
  React.useEffect(
    () =>
      registerDatabaseNavigation({
        openNote: (noteId) => handleSelect(noteId),
        openDatabase: (databaseId, title) => openDatabaseTab(databaseId, title, true),
      }),
    [handleSelect, openDatabaseTab],
  )

  // A project or section creates folders and databases without a watcher event
  // (the app's own writes are not echoed), so the tree and the catalog are re-read.
  const refreshAfterCreativeWrite = React.useCallback(async () => {
    await refreshTree()
    await refreshDatabaseCatalog()
  }, [refreshDatabaseCatalog, refreshTree])

  const handleRenameDatabaseRow = React.useCallback(
    async (rowId: string, name: string) => {
      await handleRenameFile(rowId, name)
      await refreshDatabaseCatalog()
    },
    [handleRenameFile, refreshDatabaseCatalog],
  )

  const handleLoadRowDocument = React.useCallback(
    (row: DatabaseRow) => loadDoc(row.noteId, row.title),
    [loadDoc],
  )

  const { handleOpenInNewWindow } = useNoteWindows(treeItems)
  // What the row menu of a database view needs from the workspace: the pages are ordinary notes.
  const databaseRowActions = React.useMemo<DatabaseRowActions>(
    () => ({
      favorites,
      onToggleFavorite: handleToggleFavorite,
      onOpenInNewTab: handleOpenInNewTab,
      onOpenInNewWindow: handleOpenInNewWindow,
      onDelete: (noteId) => handleDeleteFile(noteId),
      onDeleteMany: (noteIds) => handleDeleteFiles(noteIds),
      // An attached database is the folder of its note; a standalone one is its own folder item.
      onMoveToDatabase: async (noteId, target) => {
        await handleMoveItem([noteId], target.attachedNoteId ?? target.databaseId)
      },
    }),
    [
      favorites,
      handleDeleteFile,
      handleDeleteFiles,
      handleMoveItem,
      handleOpenInNewTab,
      handleOpenInNewWindow,
      handleToggleFavorite,
    ],
  )

  // Freeing the buffers of a closed note re-renders the workspace; it waits until the tab
  // animation has played instead of stalling it. The release re-checks unsaved edits and
  // recovery drafts when it runs, so the delay only postpones freeing memory.
  const releaseBuffersRef = React.useRef(releaseUnusedDocumentBuffers)
  releaseBuffersRef.current = releaseUnusedDocumentBuffers
  const releaseTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(
    () => () => {
      if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current)
    },
    [],
  )
  const handleTabUsageChanged = React.useCallback(() => {
    if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current)
    releaseTimerRef.current = setTimeout(() => {
      releaseTimerRef.current = null
      void releaseBuffersRef.current()
    }, 400)
  }, [])

  const {
    handleBack,
    handleForward,
    handleTabChange,
    handleTabClose,
    handleCloseAllTabs,
    handleSplitRight,
    handleSplitDown,
  } = useTabActions({
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

  const handleManualSave = React.useCallback(async () => {
    try {
      window.dispatchEvent(new CustomEvent(AMBY_MANUAL_SAVE_EVENT))
      await flushAutosaveGeneration(useVaultStore.getState().generation)
    } catch (error) {
      logger.error("manual_save.failed", { errorType: errorType(error) })
    }
  }, [])

  // Workspace-wide shortcuts deliberately leave plain typing alone. Native editing
  // shortcuts still belong to the focused editor; these only invoke app navigation.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (matchesShortcut(event, shortcuts.save)) {
        event.preventDefault()
        void handleManualSave()
        return
      }
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
        toggleSidebar("left")
      } else if (matchesShortcut(event, shortcuts.toggleRightSidebar)) {
        event.preventDefault()
        toggleSidebar("right")
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
    handleManualSave,
    handleNewFileIn,
    openSettings,
    shortcuts,
    toggleSidebar,
  ])

  const [pendingVaultPath, setPendingVaultPath] = React.useState<string | null>(null)

  const handleConfirmProfile = React.useCallback(
    async (profileId: ProfileId) => {
      if (!pendingVaultPath) return
      const target = pendingVaultPath
      setPendingVaultPath(null)
      setPendingWorkspaceProfile(profileId)
      await loadVault(target)
    },
    [loadVault, pendingVaultPath],
  )

  const { handleDeleteVault, handleMoveVault, handleOpenVault, handleRenameVault } =
    useVaultActions({
      loadVault,
      setVaults,
      vault,
      vaults,
      onRequestProfileSelection: (path) => setPendingVaultPath(path),
      onOpenRestored: () => setSettingsOpen(false),
    })

  const handleViewModeChange = (mode: DocumentViewMode) => {
    if (!currentDoc) return
    const activeLayer = activeLayers[currentDoc.id] ?? "editor"
    const key = `${currentDoc.id}:${activeLayer}`
    setViewMode(key, mode)
    if (activeLayer === "editor") setViewMode(currentDoc.id, mode)
    if (mode === "read") {
      if (!lockedFileIds.has(key)) toggleLock(key)
      if (activeLayer === "editor" && !lockedFileIds.has(currentDoc.id)) toggleLock(currentDoc.id)
    } else {
      if (lockedFileIds.has(key)) toggleLock(key)
      if (activeLayer === "editor" && lockedFileIds.has(currentDoc.id)) toggleLock(currentDoc.id)
    }
  }

  const handleToggleLayerLock = React.useCallback((docId: string, layer: EditorLayer) => {
    const key = `${docId}:${layer}`
    const isCurrentlyLocked = isLayerLocked(
      useViewStateStore.getState().lockedFileIds,
      useViewStateStore.getState().viewModes,
      docId,
      layer,
    )
    const { toggleLock, setViewMode } = useViewStateStore.getState()
    const currentLocked = useViewStateStore.getState().lockedFileIds
    if (isCurrentlyLocked) {
      if (currentLocked.has(key)) toggleLock(key)
      if (currentLocked.has(docId)) toggleLock(docId)
      setViewMode(key, "live")
      if (layer === "editor") setViewMode(docId, "live")
    } else {
      if (!currentLocked.has(key)) toggleLock(key)
      if (layer === "editor" && !currentLocked.has(docId)) toggleLock(docId)
      setViewMode(key, "read")
      if (layer === "editor") setViewMode(docId, "read")
    }
  }, [])

  const handleToggleLock = React.useCallback(() => {
    if (!currentDoc) return
    const activeLayer = activeLayers[currentDoc.id] ?? "editor"
    handleToggleLayerLock(currentDoc.id, activeLayer)
  }, [activeLayers, currentDoc, handleToggleLayerLock])

  const handleHistoryRestored = React.useCallback(
    async (path?: string) => {
      if (!vault) return
      // A restore of one note changes that note; with no path (a restore of the whole vault state)
      // anything may have changed.
      await (path ? refreshTreePaths([path], vault) : refreshTree(vault))
      if (useVaultStore.getState().vault !== vault) return
      const openDocs = useDocStore.getState().openDocs
      const targetId = path
        ? Object.values(openDocs).find((doc) => doc.path === path)?.id
        : currentDocId
      if (!targetId) return
      const beforeRead = openDocs[targetId]
      const note = await readNote(vault, targetId)
      // Never replace edits that arrived while the restored note was being reloaded.
      const state = useDocStore.getState()
      if (
        useVaultStore.getState().vault !== vault ||
        state.openDocs[targetId] !== beforeRead ||
        state.unsavedFileIds.has(targetId) ||
        state.externalConflicts[targetId]
      )
        return
      patchDoc(targetId, {
        content: note.content,
        revision: note.revision,
        source: note.source,
      })
      markSaved(targetId)
    },
    [vault, currentDocId, patchDoc, markSaved, refreshTree, refreshTreePaths],
  )

  const { handleOpenCanvasNote } = useLayerLoadEffects({
    currentDocId,
    currentDocPath,
    activeLayers,
    currentDocDefaultLayer,
    openCanvases,
    loadCanvasBuffer,
    setOpenCanvases,
    openSketches,
    loadSketchBuffer,
    setOpenSketches,
    treeItems,
    handleOpenInNewTab,
  })

  const {
    currentProperties,
    propertyError,
    attachments,
    attachmentImages,
    handleUpsertCustomProperty,
    handleDeleteCustomProperty,
    handleReorderCustomProperties,
    handleCreateProperty,
    handleSetPropertyIcon,
    handleSetPropertySettings,
    handleRenameProperty,
    handleChangePropertyType,
    handleSetPropertyValue,
    handleSetPropertyList,
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
      const treeItem = treeItemById.get(activeTab.fileId)
      return (
        databases.find(
          (database) =>
            database.databaseId === activeTab.fileId ||
            database.attachedNoteId === activeTab.fileId ||
            (treeItem?.id &&
              (database.databaseId === treeItem.id || database.attachedNoteId === treeItem.id)) ||
            (treeItem?.path &&
              (database.databaseId === treeItem.path || database.attachedNoteId === treeItem.path)),
        ) ?? null
      )
    }
    if (
      activeTab?.kind === "document" &&
      currentDoc &&
      activeLayers[currentDoc.id] === "database"
    ) {
      return (
        databases.find(
          (database) =>
            database.attachedNoteId === currentDoc.id || database.databaseId === currentDoc.id,
        ) ?? null
      )
    }
    return null
  }, [activeLayers, activeTab, currentDoc, databases, treeItemById])

  const headerTabs: HeaderTab[] = React.useMemo(
    () =>
      tabs.map((tab) => {
        const item = treeItemById.get(tab.fileId)
        const creativeTarget =
          tab.kind === "creative"
            ? resolveProjectTarget(projectCatalog, parseCreativeFileId(tab.fileId)?.projectId ?? "")
            : null
        return {
          key: tab.key,
          fileId: tab.fileId,
          title: tab.title,
          icon:
            tab.kind === "folder"
              ? (item?.icon ?? "📁")
              : tab.kind === "creative"
                ? creativeTarget?.kind === "workshop"
                  ? (creativeTarget.workshop.icon ?? undefined)
                  : undefined
                : item?.icon,
          Icon:
            tab.kind === "creative"
              ? creativeTarget?.kind === "workshop" && creativeTarget.workshop.icon
                ? undefined
                : projectTargetIcon(creativeTarget?.kind ?? "workshop")
              : undefined,
        }
      }),
    [projectCatalog, tabs, treeItemById],
  )

  // panelRenderProps is memoised so that sidebar panels don't re-render when only
  // the editor content changes (openDocs/currentDoc). The deps list covers every value
  // the sidebar panels actually *display* or *act on*.
  // The folder of a universe opens the workshop on it; everything else selects as usual.
  const itemById = React.useCallback((id: string) => treeItemById.get(id), [treeItemById])
  const showCreativePanel = React.useCallback(
    () => activatePanelAnywhere("creative"),
    [activatePanelAnywhere],
  )
  // Shown as icons next to "Create a new note" in the Spotlight window.
  const quickOpenCreateActions = spotlightCreateActions({
    t,
    databasesEnabled,
    canvasEnabled,
    sketchEnabled,
    onNewFolder: () => handleNewFolderIn(null),
    onNewDatabase: () =>
      void handleNewDatabase(
        null,
        // Made without asking for a name, so it must not collide with what is at the root.
        nextAvailableNoteName(displayTreeItems, vault ?? "", t("defaults.untitled")),
      ),
    onNewCanvas: () => handleNewCanvasIn(null),
    onNewSketch: () => handleNewSketchIn(null),
  })

  const handleTreeSelect = useCollectionFolderSelect({
    enabled: databasesEnabled && creativeEnabled,
    vault,
    catalog: projectCatalog,
    itemById,
    fallback: handleSelect,
    showPanel: showCreativePanel,
    openProject: openCreativeTab,
  })
  const { handleOpenSplitRight, handleOpenSplitDown, paneDnd } = useWorkspaceSplits({
    displayTreeItems,
    vault,
    loadDoc,
    handleTabUsageChanged,
    splitLayout,
    handleOpenInNewTab,
    handleTreeSelect,
  })

  const { panelRenderProps } = usePanelRenderProps({
    displayTreeItems,
    fileTreeItems,
    selectedId,
    vault,
    handleTreeSelect,
    handleOpenVault,
    handleRenameFile,
    handleDeleteFile,
    handleDeleteFiles,
    handleNewFileIn,
    handleNewFolderIn,
    handleNewCanvasIn,
    handleNewSketchIn,
    handleNewDatabase,
    handleAttachCanvasToNote,
    handleAttachSketchToNote,
    handleOpenInNewTab,
    handleOpenSplitRight,
    handleOpenSplitDown,
    handleOpenInNewWindow,
    handleCloneFile,
    handleMoveItem,
    handleSetIcon,
    pendingRenameId,
    favorites,
    handleToggleFavorite,
    handleAttachLayerToFile,
    linkedLayersByDoc,
    databasesEnabled,
    canvasEnabled,
    sketchEnabled,
    favoritesEnabled,
    openDatabaseTab,
    openCreativeTab,
    refreshAfterCreativeWrite,
    openSettings,
    currentProperties,
    propertyError,
    attachments,
    attachmentImages,
    selectedDatabase,
    activeTab,
    currentFileIcon,
    linkGraph,
    currentDoc,
    handleSelect,
    handleUpsertCustomProperty,
    handleDeleteCustomProperty,
    handleReorderCustomProperties,
    handleCreateProperty,
    handleSetPropertyIcon,
    handleSetPropertySettings,
    handleRenameProperty,
    handleChangePropertyType,
    handleSetPropertyValue,
    handleSetPropertyList,
    handleHistoryRestored,
    vaults,
    loadVault,
    setVaultManagerOpen,
    vaultName,
  })

  const leftButtons = buttonsForSide(shownButtons, "left")
  const rightButtons = buttonsForSide(shownButtons, "right")

  const leftDockPinned = isDockPinned("left")
  const rightDockPinned = isDockPinned("right")
  const { renderCreativeProject, activeFolder, renderCachedTabSurfaces, renderPaneLeaf } =
    usePaneRenderers({
      openDocs,
      treeItemById,
      activeTabKey,
      canGoBack,
      canGoForward,
      databases,
      isMultiPane,
      primaryLayers,
      activeLayers,
      contentWidths,
      defaultContentWidth,
      vault,
      handleContentChange,
      handleContentDirty,
      handleBack,
      handleForward,
      handleRenameFile,
      currentFileIcon,
      iconOverrides,
      handleSetIcon,
      handleNewFileIn,
      handleNewCanvasIn,
      handleNewSketchIn,
      databasesEnabled,
      creativeEnabled,
      activatePanelAnywhere,
      handleNewDatabase,
      displayTreeItems,
      setQuickOpenMode,
      handleOpenVault,
      showTagInPanel,
      handleWikiLinkClick,
      treeItems,
      handleLayerChange,
      handleRestoreDeleted,
      handleTabClose,
      handleSplitRight,
      handleSplitDown,
      viewModes,
      defaultViewMode,
      handleViewModeChange,
      setViewMode,
      lockedFileIds,
      toggleLock,
      setContentWidth,
      linkedLayersByDoc,
      handleToggleLock,
      handleToggleLayerLock,
      favorites,
      handleToggleFavorite,
      handleOpenInNewTab,
      nestedNotesPlacements,
      setNestedNotesPlacement,
      handleMoveItem,
      handleNewFolderIn,
      handleMergeFile,
      handleDeleteFile,
      handleSelect,
      handleUnlinkLayer,
      handleDeleteLayer,
      openCanvases,
      handleCanvasSave,
      openSketches,
      handleSketchSave,
      canvasEnabled,
      sketchEnabled,
      setModuleEnabled,
      handleOpenCanvasNote,
      scrollPositionsRef,
      stableOpenCreativeTab,
      databaseTitleLabels,
      setDatabaseTitleLabel,
      handleRenameDatabaseTab,
      openDatabaseTab,
      databaseRowActions,
      handleRenameDatabaseRow,
      handleLoadRowDocument,
      refreshDatabaseCatalog,
      refreshTreePaths,
      loadDoc,
      activeTab,
      secondaryTabKey,
      tabs,
      handleExitFocusMode,
      handleEnterFocusMode,
      headerTabs,
      stableHandleTabChange,
      stableHandleCloseAllTabs,
      openCreativeSection,
      openCreativeTab,
      retitleTab,
      refreshAfterCreativeWrite,
      isFocusMode,
      graphEnabled,
      activePaneId,
      unsavedFileIds,
      isLeftSidebarVisible,
      leftDockPinned,
      isRightSidebarVisible,
      rightDockPinned,
      rightPanelEnabled,
      navigateToFile,
      handleTabUsageChanged,
      handleCloseAllTabs,
      linkGraph,
      refreshLinkGraph,
    })

  const workspaceProfileDialog = (
    <WorkspaceProfileModal
      open={Boolean(pendingVaultPath)}
      workspaceName={
        pendingVaultPath
          ? pendingVaultPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() || undefined
          : undefined
      }
      onConfirm={handleConfirmProfile}
      onCancel={() => setPendingVaultPath(null)}
    />
  )

  if (!vault) {
    return (
      <WorkspaceLayout
        deleteConfirmationDialog={null}
        dialogs={workspaceProfileDialog}
        focusContent={null}
        focusLeftOverlay={null}
        focusRightOverlay={null}
        header={null}
        isFocusMode={false}
        leftActivityBar={null}
        leftSidebar={null}
        noVault={
          <StartScreen
            loading={!startupResolved}
            vaults={vaults}
            onSelect={loadVault}
            onOpenVault={handleOpenVault}
            onRename={handleRenameVault}
            onDelete={handleDeleteVault}
            onMove={handleMoveVault}
            onOpenInExplorer={openInExplorer}
          />
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
      <WorkspaceFocusLayout
        setFocusShowLeft={setFocusShowLeft}
        setFocusShowRight={setFocusShowRight}
        activeTab={activeTab}
        graphEnabled={graphEnabled}
        linkGraph={linkGraph}
        handleSelect={handleSelect}
        vault={vault}
        treeItems={treeItems}
        handleBack={handleBack}
        handleOpenInNewTab={handleOpenInNewTab}
        showTagInPanel={showTagInPanel}
        refreshLinkGraph={refreshLinkGraph}
        isFocusMode={isFocusMode}
        handleExitFocusMode={handleExitFocusMode}
        handleEnterFocusMode={handleEnterFocusMode}
        handleForward={handleForward}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        setModuleEnabled={setModuleEnabled}
        creativeEnabled={creativeEnabled}
        renderCreativeProject={renderCreativeProject}
        activeFolder={activeFolder}
        handleNewFileIn={handleNewFileIn}
        handleNewFolderIn={handleNewFolderIn}
        handleSetIcon={handleSetIcon}
        renderCachedTabSurfaces={renderCachedTabSurfaces}
        focusShowLeft={focusShowLeft}
        leftButtons={leftButtons}
        activeBySide={activeBySide}
        handleActivate={handleActivate}
        rightPanelEnabled={rightPanelEnabled}
        moveButtonToSide={moveButtonToSide}
        dnd={dnd}
        activityBarPresetProps={activityBarPresetProps}
        activityDockProps={activityDockProps}
        currentHelpContext={currentHelpContext}
        panelRenderProps={panelRenderProps}
        focusShowRight={focusShowRight}
        rightButtons={rightButtons}
        quickOpenMode={quickOpenMode}
        setQuickOpenMode={setQuickOpenMode}
        displayTreeItems={displayTreeItems}
        activeFileId={activeFileId}
        quickOpenCreateActions={quickOpenCreateActions}
        searchOpen={searchOpen}
        setSearchOpen={setSearchOpen}
        vaultManagerOpen={vaultManagerOpen}
        setVaultManagerOpen={setVaultManagerOpen}
        vaults={vaults}
        loadVault={loadVault}
        handleOpenVault={handleOpenVault}
        handleRenameVault={handleRenameVault}
        handleDeleteVault={handleDeleteVault}
        handleMoveVault={handleMoveVault}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        setSettingsTarget={setSettingsTarget}
        settingsTarget={settingsTarget}
        activeModules={activeModules}
        adoptPreset={adoptPreset}
        isHelpOpen={isHelpOpen}
        setIsHelpOpen={setIsHelpOpen}
        workspaceProfileDialog={workspaceProfileDialog}
        deleteConfirmationDialog={deleteConfirmationDialog}
        propertyMigrationDialog={propertyMigrationDialog}
      />
    )
  }

  const singlePaneId = splitLayout.leaves[0]?.leaf.id ?? "pane-root"

  // ── Normal layout ──────────────────────────────────────────────
  return (
    <WorkspaceNormalLayout
      headerTabs={headerTabs}
      activeTabKey={activeTabKey}
      unsavedFileIds={unsavedFileIds}
      handleTabChange={handleTabChange}
      handleTabClose={handleTabClose}
      toggleSidebar={toggleSidebar}
      isLeftSidebarVisible={isLeftSidebarVisible}
      isRightSidebarVisible={isRightSidebarVisible}
      leftDockPinned={leftDockPinned}
      rightDockPinned={rightDockPinned}
      setDockPinned={setDockPinned}
      setQuickOpenMode={setQuickOpenMode}
      vaultName={vaultName}
      vaults={vaults}
      vault={vault}
      loadVault={loadVault}
      handleOpenVault={handleOpenVault}
      setVaultManagerOpen={setVaultManagerOpen}
      handleCloseAllTabs={handleCloseAllTabs}
      isCompactLayout={isCompactLayout}
      leftWidth={leftWidth}
      rightPanelEnabled={rightPanelEnabled}
      rightWidth={rightWidth}
      activeTab={activeTab}
      favorites={favorites}
      handleToggleFavorite={handleToggleFavorite}
      singlePaneId={singlePaneId}
      isMultiPane={isMultiPane}
      handleSplitRight={handleSplitRight}
      handleSplitDown={handleSplitDown}
      handleTabUsageChanged={handleTabUsageChanged}
      deleteConfirmationDialog={deleteConfirmationDialog}
      propertyMigrationDialog={propertyMigrationDialog}
      leftButtons={leftButtons}
      activeBySide={activeBySide}
      handleActivate={handleActivate}
      moveButtonToSide={moveButtonToSide}
      dnd={dnd}
      activityBarPresetProps={activityBarPresetProps}
      activityDockProps={activityDockProps}
      currentHelpContext={currentHelpContext}
      isLeftSidebarOpen={isLeftSidebarOpen}
      resizingSide={resizingSide}
      setSidebarHover={setSidebarHover}
      panelRenderProps={panelRenderProps}
      startResize={startResize}
      mainStageRef={mainStageRef}
      splitLayout={splitLayout}
      renderPaneLeaf={renderPaneLeaf}
      paneDnd={paneDnd}
      isRightSidebarOpen={isRightSidebarOpen}
      rightButtons={rightButtons}
      quickOpenMode={quickOpenMode}
      displayTreeItems={displayTreeItems}
      handleOpenInNewTab={handleOpenInNewTab}
      handleSelect={handleSelect}
      handleNewFileIn={handleNewFileIn}
      activeFileId={activeFileId}
      quickOpenCreateActions={quickOpenCreateActions}
      searchOpen={searchOpen}
      setSearchOpen={setSearchOpen}
      vaultManagerOpen={vaultManagerOpen}
      handleRenameVault={handleRenameVault}
      handleDeleteVault={handleDeleteVault}
      handleMoveVault={handleMoveVault}
      settingsOpen={settingsOpen}
      setSettingsOpen={setSettingsOpen}
      setSettingsTarget={setSettingsTarget}
      settingsTarget={settingsTarget}
      activeModules={activeModules}
      setModuleEnabled={setModuleEnabled}
      adoptPreset={adoptPreset}
      isHelpOpen={isHelpOpen}
      setIsHelpOpen={setIsHelpOpen}
      workspaceProfileDialog={workspaceProfileDialog}
      presetNameOpen={presetNameOpen}
      setPresetNameOpen={setPresetNameOpen}
      savePresetAs={savePresetAs}
    />
  )
}
