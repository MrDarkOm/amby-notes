import type { DeleteMode } from "../file-actions/use-document-crud"
import type { LayerKind } from "../editor/document-actions"
import { type ModuleContext, DATABASE_LAYER_CREATION_AVAILABLE } from "../modules"
import type { MoveOutcome } from "../file-actions/use-document-mutations"
import {
  type NestedNotesPlacement,
  type EditorLayer,
  getLayerViewMode,
  isLayerLocked,
} from "../use-view-state-store"
import type { NoteLayers } from "@/lib/storage/types"
import type { PanelId } from "../panel-registry"
import type { SplitPaneOptions, Tab } from "../use-tabs-store"
import type { ViewModePref, ContentWidth } from "../app-config"
import * as React from "react"
import { useTranslation } from "react-i18next"
import { DatabaseWorkspace, LazyEditorFallback } from "./lazy-surfaces"
import { createFallbackDocument } from "./fallback-document"
import { databaseContentWidthKey, EMPTY_LAYERS } from "./workspace-constants"
import { CANONICAL_EMPTY_CANVAS } from "@/lib/canvas-format"
import { defaultSketchJson } from "@/lib/sketch-format"
import { useDocStore, type Document } from "../use-doc-store"
import type { DocumentViewMode } from "../document-editor"
import {
  exportDatabaseCsv,
  exportDatabaseSqlite,
  exportActiveLayerImage,
} from "../editor/layer-export"
import { findWikiLinkItem } from "../wiki-links"
import { canvasLayerPath, sketchLayerPath, nextAvailableNoteName } from "../workspace-tree-utils"
import type { TreeItem } from "../sidebar-tree"
import { DossierFrame } from "../creative/dossier/dossier-frame"
import { CreativeNoteTrail } from "../creative/note-trail-header"
import { useCreativeNavStore } from "../creative/creative-nav-store"
import type { DatabaseRowActions } from "../database/use-row-menu"
import { ModuleRequiredFallback } from "../editor/module-required-fallback"
import type { DatabaseSummary } from "@/lib/storage/database-types"
import { readNote, openInExplorer, type DatabaseRow } from "@/lib/storage"
import { workspaceRelativePath } from "../vault/use-vault-session"

interface UsePaneEditorPropsParams {
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
  refreshTree: (path?: string | null) => Promise<TreeItem[]>
  loadDoc: (fileId: string, itemName: string) => Promise<Document>
}

export function usePaneEditorProps({
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
  refreshTree,
  loadDoc,
}: UsePaneEditorPropsParams) {
  const { t } = useTranslation()
  // Build editor props for a given tab. The primary pane (active tab) keeps full
  // functionality; split panes also get independent navigation, editing, view-mode,
  // and autosave.
  function paneEditorProps(tab: Tab | null, preserveLayer = false, paneId?: string) {
    const rawDoc = tab ? (openDocs[tab.fileId] ?? null) : null
    const isCanvasOrSketch =
      tab?.kind === "canvas" ||
      tab?.kind === "sketch" ||
      tab?.kind === "database" ||
      tab?.fileId.endsWith(".canvas") ||
      tab?.fileId.endsWith(".excalidraw") ||
      rawDoc?.path.endsWith(".canvas") ||
      rawDoc?.path.endsWith(".excalidraw")
    const treeItem = tab
      ? (treeItemById.get(tab.fileId) ?? (rawDoc ? treeItemById.get(rawDoc.id) : null) ?? null)
      : null
    const doc: Document | null =
      rawDoc ??
      (isCanvasOrSketch && tab
        ? createFallbackDocument(
            tab.fileId,
            tab.title,
            treeItem?.path ?? tab.fileId,
            treeItem?.created,
            treeItem?.modified,
          )
        : null)
    const isPrimary = !!tab && tab.key === activeTabKey
    const tabCanGoBack = tab ? (tab.historyIndex ?? 0) > 0 : canGoBack
    const tabCanGoForward = tab ? tab.historyIndex < tab.history.length - 1 : canGoForward
    const nestedNotes = (treeItem?.children ?? []).filter((item) => item.type !== "folder")
    const foundDatabase = databases.find(
      (database) =>
        (doc && (database.attachedNoteId === doc.id || database.databaseId === doc.id)) ||
        (tab && (database.databaseId === tab.fileId || database.attachedNoteId === tab.fileId)),
    )
    const attachedDatabase: DatabaseSummary | undefined =
      foundDatabase ??
      (tab?.kind === "database"
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
    // Keep a hidden database note's layer mounted while its tab is cached. This
    // avoids tearing down and rebuilding the database workspace on every tab
    // switch, while the legacy secondary split remains editor-only.
    const canRenderLayer = isPrimary || isMultiPane || preserveLayer
    const resolvedPrimaryLayer =
      (doc?.id ? primaryLayers[doc.id] : undefined) ??
      (doc?.path ? primaryLayers[doc.path] : undefined) ??
      (tab?.fileId ? primaryLayers[tab.fileId] : undefined) ??
      (treeItem?.id ? primaryLayers[treeItem.id] : undefined) ??
      (treeItem?.path ? primaryLayers[treeItem.path] : undefined) ??
      (attachedDatabase?.databaseId ? primaryLayers[attachedDatabase.databaseId] : undefined) ??
      (attachedDatabase?.attachedNoteId
        ? primaryLayers[attachedDatabase.attachedNoteId]
        : undefined)

    const defaultDocLayer: EditorLayer =
      resolvedPrimaryLayer ??
      (tab?.kind === "canvas" || doc?.path.endsWith(".canvas")
        ? "canvas"
        : tab?.kind === "sketch" || doc?.path.endsWith(".excalidraw")
          ? "sketch"
          : tab?.kind === "database"
            ? "database"
            : "editor")

    const resolvedActiveLayer =
      (doc?.id ? activeLayers[doc.id] : undefined) ??
      (doc?.path ? activeLayers[doc.path] : undefined) ??
      (tab?.fileId ? activeLayers[tab.fileId] : undefined) ??
      (treeItem?.id ? activeLayers[treeItem.id] : undefined) ??
      (attachedDatabase?.databaseId ? activeLayers[attachedDatabase.databaseId] : undefined) ??
      (attachedDatabase?.attachedNoteId ? activeLayers[attachedDatabase.attachedNoteId] : undefined)

    const pageLayer =
      canRenderLayer && doc ? (resolvedActiveLayer ?? defaultDocLayer) : defaultDocLayer
    const contentWidthKey =
      pageLayer === "database" && attachedDatabase
        ? databaseContentWidthKey(attachedDatabase.databaseId)
        : tab?.fileId
    const pageContentWidth = contentWidthKey
      ? (contentWidths[contentWidthKey] ?? defaultContentWidth)
      : defaultContentWidth
    const baseScrollKey = doc ? `${vault ?? "browser"}:${doc.id}` : undefined
    const scrollPositionKey = doc
      ? tab && isMultiPane
        ? `${vault ?? "browser"}:${tab.key}:${doc.id}`
        : baseScrollKey
      : undefined
    return {
      document: doc,
      onContentChange: (content: string, sourceDocumentId?: string) => {
        const targetId = sourceDocumentId || tab?.fileId
        if (targetId) {
          handleContentChange(targetId, content)
        }
      },
      onContentDirty: (sourceDocumentId?: string) => {
        const targetId = sourceDocumentId || tab?.fileId
        if (targetId) handleContentDirty(targetId)
      },
      onContentClean: (sourceDocumentId?: string) => {
        const targetId = sourceDocumentId || tab?.fileId
        if (targetId) {
          useDocStore.getState().markSaved(targetId)
        }
      },
      onBack: isPrimary ? handleBack : tab ? () => handleBack(tab.key) : () => {},
      onForward: isPrimary ? handleForward : tab ? () => handleForward(tab.key) : () => {},
      canGoBack: isPrimary ? canGoBack : tabCanGoBack,
      canGoForward: isPrimary ? canGoForward : tabCanGoForward,
      onRenameTitle: (name: string) => {
        if (tab) handleRenameFile(tab.fileId, name)
      },
      vault: vault ?? undefined,
      fileIcon: isPrimary
        ? currentFileIcon
        : doc
          ? (treeItemById.get(doc.id)?.icon ?? iconOverrides[doc.id])
          : undefined,
      onFileIconChange: doc ? (emoji: string) => handleSetIcon(doc.id, emoji) : undefined,
      onNewFile: () => handleNewFileIn(null),
      onNewCanvas: () => handleNewCanvasIn(null),
      onNewSketch: () => handleNewSketchIn(null),
      creativeActions:
        databasesEnabled && creativeEnabled
          ? {
              onNewStory: () => {
                activatePanelAnywhere("creative")
                useCreativeNavStore.getState().requestCreate("story")
              },
              onNewUniverse: () => {
                activatePanelAnywhere("creative")
                useCreativeNavStore.getState().requestCreate("universe")
              },
              onOpenWorkshop: () => activatePanelAnywhere("creative"),
            }
          : undefined,
      onNewDatabase: () =>
        void handleNewDatabase(
          null,
          // Made without asking for a name, so it must not collide with what is at the root.
          nextAvailableNoteName(displayTreeItems, vault ?? "", t("defaults.untitled")),
        ),
      onQuickOpen: () => setQuickOpenMode("current"),
      onOpenVault: handleOpenVault,
      onTagClick: showTagInPanel,
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
      onLayerChange:
        isPrimary || isMultiPane ? handleLayerChange : async (_layer: EditorLayer) => {},
      onRestoreDeleted: doc ? () => handleRestoreDeleted(doc.id) : undefined,
      onCloseTab: tab ? () => handleTabClose(tab.key) : undefined,
      onSplitRight: tab
        ? () => handleSplitRight({ tabKey: tab.key, paneId })
        : () => handleSplitRight({ paneId }),
      onSplitDown: tab
        ? () => handleSplitDown({ tabKey: tab.key, paneId })
        : () => handleSplitDown({ paneId }),
      viewMode: doc
        ? getLayerViewMode(viewModes, doc.id, pageLayer, defaultViewMode)
        : defaultViewMode,
      onViewModeChange: isPrimary
        ? handleViewModeChange
        : (mode: DocumentViewMode) => {
            if (doc) {
              const key = `${doc.id}:${pageLayer}`
              setViewMode(key, mode)
              if (pageLayer === "editor") setViewMode(doc.id, mode)
              if (mode === "read") {
                if (!lockedFileIds.has(key)) toggleLock(key)
                if (pageLayer === "editor" && !lockedFileIds.has(doc.id)) toggleLock(doc.id)
              } else {
                if (lockedFileIds.has(key)) toggleLock(key)
                if (pageLayer === "editor" && lockedFileIds.has(doc.id)) toggleLock(doc.id)
              }
            }
          },
      contentWidth: pageContentWidth,
      onContentWidthChange: contentWidthKey
        ? (width: ContentWidth) => setContentWidth(contentWidthKey, width)
        : undefined,
      linkedLayers: doc ? (linkedLayersByDoc[doc.id] ?? EMPTY_LAYERS) : EMPTY_LAYERS,
      databasesEnabled,
      canCreateDatabaseLayer: DATABASE_LAYER_CREATION_AVAILABLE && databasesEnabled,
      isLocked: doc ? isLayerLocked(lockedFileIds, viewModes, doc.id, pageLayer) : false,
      onToggleLock: isPrimary
        ? handleToggleLock
        : doc
          ? () => handleToggleLayerLock(doc.id, pageLayer)
          : () => {},
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
        ? (targetFolderId: string | null) => handleMoveItem([doc.id], targetFolderId)
        : undefined,
      onCreateFolder:
        doc && vault
          ? (parentId: string | null, name: string) => handleNewFolderIn(parentId, name)
          : undefined,
      onMergeFile: doc ? (targetId: string) => handleMergeFile(doc.id, targetId) : undefined,
      onShowInExplorer: doc ? () => openInExplorer(doc.path) : undefined,
      onDeleteFile: doc ? (mode?: "archive") => handleDeleteFile(doc.id, mode) : undefined,
      treeItems: displayTreeItems,
      onOpenItem: handleSelect,
      onUnlinkLayer: handleUnlinkLayer,
      onDeleteLayer: handleDeleteLayer,
      onExportCsv: () => {
        void exportDatabaseCsv(attachedDatabase?.databaseId, attachedDatabase?.title || doc?.title)
      },
      onExportSqlite: () => {
        void exportDatabaseSqlite(
          attachedDatabase?.databaseId,
          attachedDatabase?.title || doc?.title,
        )
      },
      onExportImage: (format: "png" | "jpg") => {
        if (pageLayer === "canvas" || pageLayer === "sketch") {
          void exportActiveLayerImage(pageLayer, format, doc?.title || "canvas")
        }
      },
      canvasValue: doc
        ? (openCanvases[doc.path.endsWith(".canvas") ? doc.path : canvasLayerPath(doc.path)] ??
          openCanvases[doc.path] ??
          CANONICAL_EMPTY_CANVAS)
        : CANONICAL_EMPTY_CANVAS,
      onCanvasChange: doc
        ? ((savePath) => (json: string) => {
            handleCanvasSave(savePath, json)
          })(doc.path.endsWith(".canvas") ? doc.path : canvasLayerPath(doc.path))
        : (_json: string) => {},
      sketchValue: doc
        ? (openSketches[doc.path.endsWith(".excalidraw") ? doc.path : sketchLayerPath(doc.path)] ??
          openSketches[doc.path] ??
          defaultSketchJson())
        : defaultSketchJson(),
      onSketchChange: doc
        ? ((savePath) => (json: string) => {
            handleSketchSave(savePath, json)
          })(doc.path.endsWith(".excalidraw") ? doc.path : sketchLayerPath(doc.path))
        : (_json: string) => {},
      canvasEnabled,
      sketchEnabled,
      onEnableModule: (modId: string) => {
        void setModuleEnabled(modId, true, { vault })
      },
      onOpenCanvasNote: handleOpenCanvasNote,
      scrollPositionKey,
      scrollPosition: scrollPositionKey
        ? (scrollPositionsRef.current[scrollPositionKey] ??
          (baseScrollKey ? scrollPositionsRef.current[baseScrollKey] : undefined))
        : undefined,
      onScrollPositionChange: scrollPositionKey
        ? (position: number) => {
            scrollPositionsRef.current[scrollPositionKey] = position
            if (baseScrollKey && isPrimary) {
              scrollPositionsRef.current[baseScrollKey] = position
            }
          }
        : undefined,
      editorFrame: creativeEnabled ? DossierFrame : undefined,
      noteTrail: creativeEnabled ? CreativeNoteTrail : undefined,
      onOpenWorkshopPage: creativeEnabled ? stableOpenCreativeTab : undefined,
      databaseBody:
        canRenderLayer && doc && attachedDatabase ? (
          databasesEnabled ? (
            <React.Suspense fallback={<LazyEditorFallback />}>
              <DatabaseWorkspace
                databaseId={attachedDatabase.databaseId}
                title={attachedDatabase.title}
                icon={treeItem?.icon ?? attachedDatabase.icon}
                hostKind="layer"
                hostId={doc.id}
                isNavigationTarget={tab?.key === activeTabKey}
                isLocked={isLayerLocked(lockedFileIds, viewModes, doc.id, "database")}
                onToggleLock={() => handleToggleLayerLock(doc.id, "database")}
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
                onRenameTitle={(name) => {
                  if (tab) handleRenameDatabaseTab(tab.key, name)
                }}
                onIconChange={(next) => handleSetIcon(doc.id, next)}
                onOpenInNewTab={() =>
                  openDatabaseTab(attachedDatabase.databaseId, attachedDatabase.title, true)
                }
                onOpenNote={(id) => handleSelect(id)}
                onOpenRowFullPage={(row) => handleSelect(row.noteId, row.title)}
                rowActions={databaseRowActions}
                onRenameRow={handleRenameDatabaseRow}
                onLoadRowDocument={handleLoadRowDocument}
                onRowContentChange={handleContentChange}
                vault={vault ?? undefined}
                onCatalogChanged={refreshDatabaseCatalog}
                onRowCreated={async (row) => {
                  await refreshTree()
                  await loadDoc(row.noteId, row.title)
                }}
              />
            </React.Suspense>
          ) : (
            <ModuleRequiredFallback
              moduleId="amby.databases"
              moduleName={t("settings.modules.databases")}
              onEnableModule={() => {
                void setModuleEnabled("databases", true, { vault })
              }}
            />
          )
        ) : undefined,
    }
  }

  return { paneEditorProps }
}
