import type { AttachmentItem, LinkGraph, PanelRenderProps } from "../panel-registry"
import type { CustomProperty, NoteLayers, NoteProperties } from "@/lib/storage/types"
import { type DatabaseSummary, readFile, readNote, openInExplorer } from "@/lib/storage"
import type { MoveOutcome } from "../file-actions/use-document-mutations"
import type { Tab } from "../use-tabs-store"
import { type VaultRecord, WorkspacePicker } from "../workspace-picker"
import type { DeleteMode } from "../file-actions/use-document-crud"
import type { Document } from "../use-doc-store"
import { ChevronDown, FolderOpen } from "lucide-react"
import { DATABASE_LAYER_CREATION_AVAILABLE } from "../modules"
import * as React from "react"
import { useTranslation } from "react-i18next"
import type { SettingsNavigationTarget } from "../settings-navigation"
import type { TreeItem } from "../sidebar-tree"

interface UsePanelRenderPropsParams {
  displayTreeItems: TreeItem[]
  fileTreeItems: TreeItem[]
  selectedId: string
  vault: string | null
  handleTreeSelect: (id: string) => void
  handleOpenVault: () => Promise<void>
  handleRenameFile: (id: string, newName: string) => Promise<void>
  handleDeleteFile: (id: string, mode?: DeleteMode) => Promise<void>
  handleDeleteFiles: (ids: string[], mode?: DeleteMode) => Promise<void>
  handleNewFileIn: (
    parentId: string | null,
    inNewTab?: boolean,
    initialContent?: string,
  ) => Promise<void>
  handleNewFolderIn: (parentId: string | null, requestedName?: string) => Promise<void>
  handleNewCanvasIn: (parentId: string | null) => Promise<void>
  handleNewSketchIn: (parentId: string | null) => Promise<void>
  handleNewDatabase: (parentId: string | null, name: string) => Promise<void>
  handleAttachCanvasToNote: (canvasId: string) => Promise<void>
  handleAttachSketchToNote: (sketchId: string) => Promise<void>
  handleOpenInNewTab: (fileId: string) => Promise<void>
  handleOpenSplitRight: (fileId: string) => void
  handleOpenSplitDown: (fileId: string) => void
  handleOpenInNewWindow: (fileId: string) => void
  handleCloneFile: (fileId: string) => Promise<void>
  handleMoveItem: (sourceIds: string[], targetId: string | null) => Promise<MoveOutcome>
  handleSetIcon: (id: string, icon: string) => void
  pendingRenameId: string | null
  favorites: Set<string>
  handleToggleFavorite: (id: string) => void
  handleAttachLayerToFile: (
    fileId: string,
    layer: "canvas" | "database" | "sketch" | "note",
  ) => Promise<void>
  linkedLayersByDoc: Record<string, NoteLayers>
  databasesEnabled: boolean
  canvasEnabled: boolean
  sketchEnabled: boolean
  favoritesEnabled: boolean
  openDatabaseTab: (databaseId: string, title: string, inNewTab?: boolean) => void
  openCreativeTab: (projectId: string, sectionId?: string, inNewTab?: boolean) => void
  refreshAfterCreativeWrite: () => Promise<void>
  openSettings: (target?: SettingsNavigationTarget | null) => void
  currentProperties:
    | {
        kind: "folder"
        type: string
        id: string
        path: string
        noteCount: number
        folderCount: number
        backlinks?: undefined
        created?: undefined
        modified?: undefined
        frontmatter?: undefined
      }
    | {
        kind: "document"
        type: string
        backlinks: number
        created: string
        modified: string
        id: string
        frontmatter: NoteProperties
        path?: undefined
        noteCount?: undefined
        folderCount?: undefined
      }
    | null
  propertyError: string | null
  attachments: AttachmentItem[]
  attachmentImages: AttachmentItem[]
  selectedDatabase: DatabaseSummary | null
  activeTab: Tab | null
  currentFileIcon: string | undefined
  linkGraph: LinkGraph
  currentDoc: Document | null
  handleSelect: (fileId: string, displayTitle?: string) => Promise<void>
  handleUpsertCustomProperty: (property: CustomProperty) => Promise<CustomProperty>
  handleDeleteCustomProperty: (propertyId: string) => Promise<void>
  handleReorderCustomProperties: (propertyIds: string[]) => Promise<void>
  handleHistoryRestored: (path?: string) => Promise<void>
  vaults: VaultRecord[]
  loadVault: (path: string | null, activateBackend?: boolean) => Promise<void>
  setVaultManagerOpen: React.Dispatch<React.SetStateAction<boolean>>
  vaultName: string | undefined
}

export function usePanelRenderProps({
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
  handleHistoryRestored,
  vaults,
  loadVault,
  setVaultManagerOpen,
  vaultName,
}: UsePanelRenderPropsParams) {
  const { t } = useTranslation()
  const panelRenderProps: PanelRenderProps = React.useMemo(
    () => ({
      treeItems: displayTreeItems,
      fileTreeItems,
      selectedId,
      vault,
      onSelect: handleTreeSelect,
      onOpenVault: handleOpenVault,
      onRename: handleRenameFile,
      onDelete: handleDeleteFile,
      onDeleteMany: handleDeleteFiles,
      onNewFile: handleNewFileIn,
      onCreateNoteFromText: (content) => handleNewFileIn(null, true, content),
      onNewFolder: handleNewFolderIn,
      onNewCanvas: handleNewCanvasIn,
      onNewSketch: handleNewSketchIn,
      onNewDatabase: handleNewDatabase,
      onAttachCanvas: handleAttachCanvasToNote,
      onAttachSketch: handleAttachSketchToNote,
      onOpenInNewTab: handleOpenInNewTab,
      onOpenSplitRight: handleOpenSplitRight,
      onOpenSplitDown: handleOpenSplitDown,
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
      canvasEnabled,
      sketchEnabled,
      favoritesEnabled,
      onOpenDatabase: openDatabaseTab,
      onOpenCreativeProject: openCreativeTab,
      onCreativeChanged: refreshAfterCreativeWrite,
      onOpenSettings: openSettings,
      properties: currentProperties,
      propertyError,
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
          onManage={() => setVaultManagerOpen(true)}
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
      fileTreeItems,
      selectedId,
      vault,
      handleSelect,
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
      currentProperties,
      propertyError,
      attachments,
      attachmentImages,
      selectedDatabase,
      currentFileIcon,
      activeTab?.kind,
      activeTab?.fileId,
      activeTab?.title,
      databasesEnabled,
      canvasEnabled,
      sketchEnabled,
      favoritesEnabled,
      openDatabaseTab,
      openCreativeTab,
      refreshAfterCreativeWrite,
      openSettings,
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
      t,
      setVaultManagerOpen,
    ],
  )
  return { panelRenderProps }
}
