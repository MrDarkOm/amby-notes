import type { DeleteMode } from "../file-actions/use-document-crud"
import type { LayerKind } from "../editor/document-actions"
import type { LinkGraph, PanelId } from "../panel-registry"
import type { ModuleContext } from "../modules"
import type { MoveOutcome } from "../file-actions/use-document-mutations"
import {
  type NestedNotesPlacement,
  type EditorLayer,
  getLayerViewMode,
  isLayerLocked,
} from "../use-view-state-store"
import type { NoteLayers } from "@/lib/storage/types"
import { type SplitPaneOptions, useTabsStore, type Tab } from "../use-tabs-store"
import type { ViewModePref, ContentWidth } from "../app-config"
import * as React from "react"
import { useTranslation } from "react-i18next"
import { GraphTabView, ProjectPage, SurfaceSuspense } from "./lazy-surfaces"
import { ConnectedCachedDocumentEditor, DocumentEditor } from "./cached-document-editor"
import { createFallbackDocument } from "./fallback-document"
import { databaseContentWidthKey, NOOP } from "./workspace-constants"
import { defaultSketchJson } from "@/lib/sketch-format"
import type { Document } from "../use-doc-store"
import type { DocumentEditorProps, DocumentViewMode } from "../document-editor"
import type { HeaderTab } from "../header-tabs"
import { cn } from "@/lib/utils"
import { canRenderSplit } from "../document-buffer-lifecycle"
import type { LayoutLeafItem } from "../split-tree"
import { PaneTabBar } from "../pane-tab-bar"
import { canvasLayerPath, sketchLayerPath } from "../workspace-tree-utils"
import { FolderView } from "../folder-view"
import type { TreeItem } from "../sidebar-tree"
import { parseCreativeFileId } from "../creative/creative-history"
import type { DatabaseRowActions } from "../database/use-row-menu"
import { ModuleRequiredFallback } from "../editor/module-required-fallback"
import type { DatabaseSummary } from "@/lib/storage/database-types"
import { openInExplorer, type DatabaseRow } from "@/lib/storage"
import { flushEditorSerializations } from "../tiptap/editor-serialization-lifecycle"
import { usePaneEditorProps } from "./use-pane-editor-props"

interface UsePaneRenderersParams {
  openDocs: Record<string, Document>
  treeItemById: Map<string, TreeItem>
  activeTabKey: string
  canGoBack: boolean
  canGoForward: boolean
  databases: DatabaseSummary[]
  isMultiPane: boolean
  primaryLayers: Record<string, EditorLayer>
  activeLayers: Record<string, EditorLayer>
  contentWidths: Record<string, ContentWidth>
  defaultContentWidth: ContentWidth
  vault: string | null
  handleContentChange: (fileId: string, content: string) => void
  handleContentDirty: (fileId: string) => void
  handleBack: (key?: unknown) => Promise<void> | undefined
  handleForward: (key?: unknown) => Promise<void> | undefined
  handleRenameFile: (id: string, newName: string) => Promise<void>
  currentFileIcon: string | undefined
  iconOverrides: Record<string, string>
  handleSetIcon: (id: string, icon: string) => void
  handleNewFileIn: (
    parentId: string | null,
    inNewTab?: boolean,
    initialContent?: string,
  ) => Promise<void>
  handleNewCanvasIn: (parentId: string | null) => Promise<void>
  handleNewSketchIn: (parentId: string | null) => Promise<void>
  databasesEnabled: boolean
  creativeEnabled: boolean
  activatePanelAnywhere: (panelId: PanelId) => void
  handleNewDatabase: (parentId: string | null, name: string) => Promise<void>
  displayTreeItems: TreeItem[]
  setQuickOpenMode: React.Dispatch<React.SetStateAction<"current" | "new" | null>>
  handleOpenVault: () => Promise<void>
  showTagInPanel: (tag: string) => void
  handleWikiLinkClick: (rawLink: string) => Promise<void>
  treeItems: TreeItem[]
  handleLayerChange: (layer: EditorLayer) => Promise<void>
  handleRestoreDeleted: (fileId: string) => Promise<void>
  handleTabClose: (key: string) => void
  handleSplitRight: (options?: SplitPaneOptions) => string | null
  handleSplitDown: (options?: SplitPaneOptions) => string | null
  viewModes: Record<string, DocumentViewMode>
  defaultViewMode: ViewModePref
  handleViewModeChange: (mode: DocumentViewMode) => void
  setViewMode: (id: string, mode: DocumentViewMode) => void
  lockedFileIds: Set<string>
  toggleLock: (id: string) => void
  setContentWidth: (id: string, width: ContentWidth) => void
  linkedLayersByDoc: Record<string, NoteLayers>
  handleToggleLock: () => void
  handleToggleLayerLock: (docId: string, layer: EditorLayer) => void
  favorites: Set<string>
  handleToggleFavorite: (id: string) => void
  handleOpenInNewTab: (fileId: string) => Promise<void>
  nestedNotesPlacements: Record<string, NestedNotesPlacement>
  setNestedNotesPlacement: (id: string, placement: NestedNotesPlacement) => void
  handleMoveItem: (sourceIds: string[], targetId: string | null) => Promise<MoveOutcome>
  handleNewFolderIn: (parentId: string | null, requestedName?: string) => Promise<void>
  handleMergeFile: (sourceId: string, targetId: string) => Promise<void>
  handleDeleteFile: (id: string, mode?: DeleteMode) => Promise<void>
  handleSelect: (fileId: string, displayTitle?: string) => Promise<void>
  handleUnlinkLayer: (layer: LayerKind) => Promise<void>
  handleDeleteLayer: (layer: LayerKind) => Promise<void>
  openCanvases: Record<string, string>
  handleCanvasSave: (path: string, json: string) => void
  openSketches: Record<string, string>
  handleSketchSave: (path: string, json: string) => void
  canvasEnabled: boolean
  sketchEnabled: boolean
  setModuleEnabled: (id: string, enabled: boolean, ctx: ModuleContext) => Promise<boolean>
  handleOpenCanvasNote: (file: string) => void
  scrollPositionsRef: React.RefObject<Record<string, number>>
  stableOpenCreativeTab: (projectId: string, sectionId?: string) => void
  databaseTitleLabels: Record<string, string>
  setDatabaseTitleLabel: (id: string, label: string) => void
  handleRenameDatabaseTab: (tabKey: string, title: string) => void
  openDatabaseTab: (databaseId: string, title: string, inNewTab?: boolean) => void
  databaseRowActions: DatabaseRowActions
  handleRenameDatabaseRow: (rowId: string, name: string) => Promise<void>
  handleLoadRowDocument: (row: DatabaseRow) => Promise<Document>
  refreshDatabaseCatalog: (signal?: { cancelled: boolean }) => Promise<void>
  refreshTreePaths: (paths: string[]) => Promise<TreeItem[]>
  loadDoc: (fileId: string, itemName: string) => Promise<Document>
  activeTab: Tab | null
  secondaryTabKey: string | null
  tabs: Tab[]
  handleExitFocusMode: () => Promise<void>
  handleEnterFocusMode: () => Promise<void>
  headerTabs: HeaderTab[]
  stableHandleTabChange: (key: string) => void
  stableHandleCloseAllTabs: () => void
  openCreativeSection: (projectId: string, sectionId: string) => void
  openCreativeTab: (projectId: string, sectionId?: string, inNewTab?: boolean) => void
  retitleTab: (tabKey: string, title: string) => void
  refreshAfterCreativeWrite: () => Promise<void>
  isFocusMode: boolean
  graphEnabled: boolean
  activePaneId: string
  unsavedFileIds: Set<string>
  isLeftSidebarVisible: boolean
  leftDockPinned: boolean
  isRightSidebarVisible: boolean
  rightDockPinned: boolean
  rightPanelEnabled: boolean
  navigateToFile: (fileId: string) => Promise<void>
  handleTabUsageChanged: () => void
  handleCloseAllTabs: () => void
  linkGraph: LinkGraph
  refreshLinkGraph: () => void
}

export function usePaneRenderers({
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
}: UsePaneRenderersParams) {
  const { t } = useTranslation()
  const { paneEditorProps } = usePaneEditorProps({
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
  })
  const activeFolder =
    activeTab?.kind === "folder" ? (treeItemById.get(activeTab.fileId) ?? null) : null
  const secondaryTab = secondaryTabKey
    ? (tabs.find((t) => t.key === secondaryTabKey && t.kind === "document") ?? null)
    : null
  const showSplit = canRenderSplit(activeTab, secondaryTab)
  const documentTabs = React.useMemo(() => {
    const openDocumentTabs = tabs.filter(
      (tab) =>
        tab.kind === "document" ||
        tab.kind === "canvas" ||
        tab.kind === "sketch" ||
        tab.kind === "database",
    )
    if (isMultiPane) {
      return openDocumentTabs
    }
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
  }, [activeTabKey, isMultiPane, secondaryTabKey, showSplit, tabs])

  interface EditorPropsCacheEntry {
    props: DocumentEditorProps
    signature: readonly unknown[]
    wasVisible: boolean
  }
  const editorPropsCacheRef = React.useRef(new Map<string, EditorPropsCacheEntry>())
  React.useEffect(() => {
    const openKeys = new Set(documentTabs.map((tab) => `${tab.key}:${tab.fileId}`))
    for (const key of editorPropsCacheRef.current.keys()) {
      if (!openKeys.has(key)) editorPropsCacheRef.current.delete(key)
    }
  }, [documentTabs])

  function renderPaneDocumentEditors(leafItem: LayoutLeafItem | null, isFocusMode: boolean) {
    const leaf = leafItem?.leaf ?? null
    const leafTabSet = leaf && isMultiPane ? new Set(leaf.tabKeys) : null
    const paneDocTabs = leafTabSet
      ? documentTabs.filter((tab) => leafTabSet.has(tab.key))
      : documentTabs
    const paneActiveKey =
      leaf && isMultiPane
        ? leaf.activeTabKey || leaf.tabKeys[leaf.tabKeys.length - 1] || ""
        : activeTabKey

    if (paneDocTabs.length === 0) {
      return (
        <SurfaceSuspense scope="document">
          <DocumentEditor
            {...paneEditorProps(null, false, leaf?.id)}
            isFocusMode={isFocusMode}
            onToggleFocusMode={isFocusMode ? handleExitFocusMode : handleEnterFocusMode}
          />
        </SurfaceSuspense>
      )
    }

    // Keep every open document editor mounted and only toggle the visible pane.
    // Tiptap/CodeMirror then retain their parsed state and scroll offset when a
    // user returns to a tab instead of rebuilding a large document from Markdown.
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {paneDocTabs.map((tab) => {
          const visible =
            leaf && isMultiPane
              ? tab.key === paneActiveKey
              : tab.key === activeTabKey || (showSplit && tab.key === secondaryTabKey)
          const primary = tab.key === activeTabKey
          const showNav = isMultiPane || primary
          const rawDoc = openDocs[tab.fileId] ?? null
          const isCanvasOrSketch =
            tab.kind === "canvas" ||
            tab.kind === "sketch" ||
            tab.kind === "database" ||
            tab.fileId.endsWith(".canvas") ||
            tab.fileId.endsWith(".excalidraw") ||
            rawDoc?.path.endsWith(".canvas") ||
            rawDoc?.path.endsWith(".excalidraw")
          const treeItem = tab
            ? (treeItemById.get(tab.fileId) ??
              (rawDoc ? treeItemById.get(rawDoc.id) : null) ??
              null)
            : null
          const doc: Document | null =
            rawDoc ??
            (isCanvasOrSketch
              ? createFallbackDocument(
                  tab.fileId,
                  tab.title,
                  treeItem?.path ?? tab.fileId,
                  treeItem?.created,
                  treeItem?.modified,
                )
              : null)
          const foundDatabase = databases.find(
            (database) =>
              (doc && (database.attachedNoteId === doc.id || database.databaseId === doc.id)) ||
              database.databaseId === tab.fileId ||
              database.attachedNoteId === tab.fileId ||
              (treeItem?.id &&
                (database.databaseId === treeItem.id || database.attachedNoteId === treeItem.id)) ||
              (treeItem?.path &&
                (database.databaseId === treeItem.path ||
                  database.attachedNoteId === treeItem.path)),
          )
          const attachedDatabase: DatabaseSummary | undefined =
            foundDatabase ??
            (tab.kind === "database"
              ? {
                  databaseId: tab.fileId,
                  title: tab.title,
                  icon: treeItem?.icon ?? null,
                  attachedNoteId: null,
                  manifestRevision: "0",
                  locked: false,
                  properties: [],
                  views: [],
                  templates: [],
                  diagnostics: [],
                }
              : undefined)
          const resolvedPrimaryLayer =
            (doc?.id ? primaryLayers[doc.id] : undefined) ??
            (doc?.path ? primaryLayers[doc.path] : undefined) ??
            (tab.fileId ? primaryLayers[tab.fileId] : undefined) ??
            (treeItem?.id ? primaryLayers[treeItem.id] : undefined) ??
            (treeItem?.path ? primaryLayers[treeItem.path] : undefined) ??
            (attachedDatabase?.databaseId
              ? primaryLayers[attachedDatabase.databaseId]
              : undefined) ??
            (attachedDatabase?.attachedNoteId
              ? primaryLayers[attachedDatabase.attachedNoteId]
              : undefined)

          const defaultDocLayer: EditorLayer =
            resolvedPrimaryLayer ??
            (tab.kind === "canvas" || doc?.path.endsWith(".canvas")
              ? "canvas"
              : tab.kind === "sketch" || doc?.path.endsWith(".excalidraw")
                ? "sketch"
                : tab.kind === "database"
                  ? "database"
                  : "editor")

          const resolvedActiveLayer =
            (doc?.id ? activeLayers[doc.id] : undefined) ??
            (doc?.path ? activeLayers[doc.path] : undefined) ??
            (tab.fileId ? activeLayers[tab.fileId] : undefined) ??
            (treeItem?.id ? activeLayers[treeItem.id] : undefined) ??
            (attachedDatabase?.databaseId
              ? activeLayers[attachedDatabase.databaseId]
              : undefined) ??
            (attachedDatabase?.attachedNoteId
              ? activeLayers[attachedDatabase.attachedNoteId]
              : undefined)

          const pageLayer = doc ? (resolvedActiveLayer ?? defaultDocLayer) : defaultDocLayer
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
            resolvedPrimaryLayer,
            resolvedActiveLayer,
            doc ? linkedLayersByDoc[doc.id] : undefined,
            doc ? getLayerViewMode(viewModes, doc.id, pageLayer, defaultViewMode) : defaultViewMode,
            doc ? isLayerLocked(lockedFileIds, viewModes, doc.id, pageLayer) : false,
            doc ? isLayerLocked(lockedFileIds, viewModes, doc.id, "editor") : false,
            doc ? isLayerLocked(lockedFileIds, viewModes, doc.id, "database") : false,
            doc ? isLayerLocked(lockedFileIds, viewModes, doc.id, "canvas") : false,
            doc ? isLayerLocked(lockedFileIds, viewModes, doc.id, "sketch") : false,
            contentWidths[widthKey],
            attachedDatabase
              ? databaseTitleLabels[databaseContentWidthKey(attachedDatabase.databaseId)]
              : undefined,
            doc ? (treeItem?.icon ?? iconOverrides[doc.id]) : undefined,
            doc ? lockedFileIds.has(doc.id) : false,
            doc ? favorites.has(doc.id) : false,
            doc ? nestedNotesPlacements[doc.id] : undefined,
            doc
              ? (openCanvases[
                  doc.path.endsWith(".canvas") ? doc.path : canvasLayerPath(doc.path)
                ] ?? openCanvases[doc.path])
              : undefined,
            doc
              ? (openSketches[
                  doc.path.endsWith(".excalidraw") ? doc.path : sketchLayerPath(doc.path)
                ] ??
                openSketches[doc.path] ??
                defaultSketchJson())
              : defaultSketchJson(),
            vault,
            databasesEnabled,
            creativeEnabled,
            defaultViewMode,
            defaultContentWidth,
            isMultiPane,
            leaf?.id,
          ] as const
          const cacheKey = `${tab.key}:${tab.fileId}`
          const cached = editorPropsCacheRef.current.get(cacheKey)
          const sameSignature =
            cached?.signature.length === signature.length &&
            cached.signature.every((value, index) => value === signature[index])
          const shouldRefresh = !cached || (visible && (!cached.wasVisible || !sameSignature))
          const props = shouldRefresh ? paneEditorProps(tab, !visible, leaf?.id) : cached.props
          if (shouldRefresh) {
            editorPropsCacheRef.current.set(cacheKey, {
              props,
              signature,
              wasVisible: visible || cached?.wasVisible === true,
            })
          }
          return (
            <div
              key={cacheKey}
              aria-hidden={!visible}
              className={
                visible
                  ? "flex min-w-0 flex-1"
                  : "invisible pointer-events-none absolute inset-0 flex min-h-0 min-w-0 overflow-hidden"
              }
            >
              <SurfaceSuspense scope="document">
                <ConnectedCachedDocumentEditor
                  key={cacheKey}
                  editorProps={props}
                  visible={visible}
                  isFocusMode={isFocusMode}
                  hideNavigation={!showNav}
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
              </SurfaceSuspense>
            </div>
          )
        })}
      </div>
    )
  }

  function renderCreativeProject(targetTab: Tab | null = activeTab, paneId?: string) {
    if (targetTab?.kind !== "creative") return null
    const location = parseCreativeFileId(targetTab.fileId)
    if (!location) return null
    const { projectId, sectionId } = location
    const root = vault?.replace(/[\\/]+$/u, "") ?? ""
    const separator = root.includes("\\") ? "\\" : "/"
    return (
      <ProjectPage
        key={projectId}
        projectId={projectId}
        section={sectionId}
        onShowSection={(next) => openCreativeSection(projectId, next)}
        onOpenProject={(id, section) => openCreativeTab(id, section)}
        onTitle={(title) => retitleTab(targetTab.key, title)}
        onOpenNote={(noteId) => handleSelect(noteId)}
        vaultPath={vault ?? null}
        onChanged={refreshAfterCreativeWrite}
        onOpenDatabase={(databaseId, title) => openDatabaseTab(databaseId, title, true)}
        host={{
          onBack: () => handleBack(targetTab.key),
          onForward: () => handleForward(targetTab.key),
          canGoBack: targetTab.historyIndex > 0,
          canGoForward: targetTab.historyIndex < targetTab.history.length - 1,
          isFocusMode,
          onToggleFocusMode: isFocusMode ? handleExitFocusMode : handleEnterFocusMode,
          focusTabs: {
            tabs: headerTabs,
            activeTabKey: targetTab.key,
            activeFileId: targetTab.fileId,
            favorites,
            onTabChange: stableHandleTabChange,
            onToggleFavorite: handleToggleFavorite,
            onCloseAllTabs: stableHandleCloseAllTabs,
          },
          onOpenInNewTab: () => openCreativeTab(projectId, sectionId ?? undefined, true),
          onSplitRight: () => handleSplitRight({ tabKey: targetTab.key, paneId }),
          onSplitDown: () => handleSplitDown({ tabKey: targetTab.key, paneId }),
          onToggleFavorite: handleToggleFavorite,
          onShowInExplorer: root
            ? (relative) =>
                openInExplorer(
                  relative ? `${root}${separator}${relative.split("/").join(separator)}` : root,
                )
            : undefined,
        }}
      />
    )
  }

  function renderCachedTabSurfaces(isFocusMode: boolean, leafItem: LayoutLeafItem | null = null) {
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {renderPaneDocumentEditors(leafItem, isFocusMode)}
      </div>
    )
  }

  function renderPaneLeaf(leafItem: LayoutLeafItem) {
    const { leaf, rect, edges } = leafItem
    const leafTabSet = new Set(leaf.tabKeys)
    const leafHeaderTabs = headerTabs.filter((item) => leafTabSet.has(item.key))
    const leafActiveKey = isMultiPane
      ? leaf.activeTabKey || leaf.tabKeys[leaf.tabKeys.length - 1] || ""
      : activeTabKey
    const leafActiveTab = tabs.find((item) => item.key === leafActiveKey) ?? null
    const leafActiveFolder =
      leafActiveTab?.kind === "folder" ? (treeItemById.get(leafActiveTab.fileId) ?? null) : null
    const leafGraphActive = leafActiveTab?.kind === "graph" && graphEnabled
    const leafGraphMounted =
      graphEnabled &&
      tabs.some((item) => (isMultiPane ? leafTabSet.has(item.key) : true) && item.kind === "graph")
    const leafDocumentsActive =
      leafActiveTab?.kind !== "graph" &&
      leafActiveTab?.kind !== "creative" &&
      leafActiveFolder?.type !== "folder"
    const isPaneFocused = leaf.id === activePaneId
    const leafCanGoBack = (leafActiveTab?.historyIndex ?? 0) > 0
    const leafCanGoForward = leafActiveTab
      ? leafActiveTab.historyIndex < leafActiveTab.history.length - 1
      : false

    const ensurePaneFocused = () => {
      if (useTabsStore.getState().activePaneId !== leaf.id) {
        flushEditorSerializations()
        useTabsStore.getState().focusPane(leaf.id)
      }
    }

    return (
      <div
        key={leaf.id}
        data-pane-id={leaf.id}
        onPointerDownCapture={ensurePaneFocused}
        style={
          isMultiPane
            ? {
                left: `${rect.x}%`,
                top: `${rect.y}%`,
                width: `${rect.w}%`,
                height: `${rect.h}%`,
              }
            : undefined
        }
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-hidden",
          isMultiPane
            ? cn("absolute", !edges.left && "pl-1", !edges.right && "pr-1")
            : "relative flex-1",
        )}
      >
        {isMultiPane ? (
          <PaneTabBar
            paneId={leaf.id}
            tabs={leafHeaderTabs}
            activeTabKey={leafActiveKey}
            activeFileId={leafActiveTab?.fileId}
            isPaneFocused={isPaneFocused}
            unsavedFileIds={unsavedFileIds}
            favorites={favorites}
            edges={edges}
            isLeftSidebarOpen={isLeftSidebarVisible}
            isLeftDockPinned={leftDockPinned}
            isRightSidebarOpen={isRightSidebarVisible}
            isRightDockPinned={rightDockPinned}
            rightPanelEnabled={rightPanelEnabled}
            onFocusPane={ensurePaneFocused}
            onTabChange={(tabKey) => {
              flushEditorSerializations()
              useTabsStore.getState().selectTabInPane(leaf.id, tabKey)
              const nextTab = useTabsStore.getState().tabs.find((item) => item.key === tabKey)
              if (nextTab) void navigateToFile(nextTab.fileId)
            }}
            onTabClose={handleTabClose}
            onCloseOtherTabs={(tabKey) => {
              flushEditorSerializations()
              useTabsStore.getState().closeOtherTabsInPane(leaf.id, tabKey)
              handleTabUsageChanged()
            }}
            onCloseAllTabs={handleCloseAllTabs}
            onClosePane={() => {
              flushEditorSerializations()
              useTabsStore.getState().closePane(leaf.id)
              handleTabUsageChanged()
            }}
            onSplitRight={(tabKey) =>
              handleSplitRight({ tabKey: tabKey ?? leafActiveKey, paneId: leaf.id })
            }
            onSplitDown={(tabKey) =>
              handleSplitDown({ tabKey: tabKey ?? leafActiveKey, paneId: leaf.id })
            }
            onUnsplitAll={() => {
              flushEditorSerializations()
              useTabsStore.getState().unsplitAll()
              handleTabUsageChanged()
            }}
            onOpenPlusModal={() => setQuickOpenMode("new")}
            onToggleFavorite={handleToggleFavorite}
          />
        ) : null}
        <div className="relative flex min-h-0 min-w-0 flex-1">
          {leafGraphMounted ? (
            <div
              aria-hidden={!leafGraphActive}
              className={cn(
                "absolute inset-0 flex flex-col",
                !leafGraphActive && "invisible pointer-events-none",
              )}
            >
              <SurfaceSuspense scope="graph">
                <div
                  className="amby-workspace-surface relative mb-2 mt-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/80 bg-[var(--note-surface)]"
                  style={{ boxShadow: "var(--note-surface-shadow)" }}
                >
                  <GraphTabView
                    graph={linkGraph}
                    selectedId={null}
                    onSelect={handleSelect}
                    vault={vault}
                    treeItems={treeItems}
                    onBack={() => handleBack(leafActiveTab?.key)}
                    onOpenInNewTab={handleOpenInNewTab}
                    onTagClick={showTagInPanel}
                    onRefresh={refreshLinkGraph}
                    isFocusMode={isFocusMode}
                    onToggleFocusMode={isFocusMode ? handleExitFocusMode : handleEnterFocusMode}
                    onForward={() => handleForward(leafActiveTab?.key)}
                    canGoBack={leafCanGoBack}
                    canGoForward={leafCanGoForward}
                  />
                </div>
              </SurfaceSuspense>
            </div>
          ) : null}
          {leafActiveTab?.kind === "graph" && !graphEnabled ? (
            <ModuleRequiredFallback
              moduleId="amby.graph"
              moduleName={t("settings.modules.graph")}
              onEnableModule={() => {
                void setModuleEnabled("graph", true, { vault })
              }}
            />
          ) : leafActiveTab?.kind === "creative" ? (
            creativeEnabled ? (
              <SurfaceSuspense scope="creative" resetKey={leafActiveTab?.fileId}>
                <div
                  className="amby-workspace-surface relative mb-2 mt-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/80 bg-[var(--note-surface)]"
                  style={{ boxShadow: "var(--note-surface-shadow)" }}
                >
                  {renderCreativeProject(leafActiveTab, leaf.id)}
                </div>
              </SurfaceSuspense>
            ) : (
              <ModuleRequiredFallback
                moduleId="amby.creative"
                moduleName={t("creative.welcome.title", "Творческая мастерская")}
                onEnableModule={() => {
                  void setModuleEnabled("creative", true, { vault })
                }}
              />
            )
          ) : leafActiveFolder?.type === "folder" ? (
            <FolderView
              folder={leafActiveFolder}
              onOpenItem={handleSelect}
              onNewNote={handleNewFileIn}
              onNewFolder={handleNewFolderIn}
              onIconChange={(icon) => handleSetIcon(leafActiveFolder.id, icon)}
            />
          ) : null}
          <div
            aria-hidden={!leafDocumentsActive}
            className={
              leafDocumentsActive
                ? "relative flex min-h-0 min-w-0 flex-1"
                : "invisible pointer-events-none absolute inset-0 flex min-h-0 min-w-0 overflow-hidden"
            }
          >
            {renderCachedTabSurfaces(false, leafItem)}
          </div>
        </div>
      </div>
    )
  }
  return { renderCreativeProject, activeFolder, renderCachedTabSurfaces, renderPaneLeaf }
}
