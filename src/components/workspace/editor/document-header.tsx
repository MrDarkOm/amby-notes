import { useMemo, type ComponentType, type ReactElement } from "react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"
import { Check, Database, FileText, LayoutGrid, PenLine } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { HeaderTab } from "../header-tabs"
import type { TreeItem } from "../sidebar-tree"
import { useTabsStore, type TabKind } from "../use-tabs-store"
import { useViewStateStore } from "../use-view-state-store"
import { useDatabaseStore } from "../database/database-store"
import { findTabTreeItem } from "../tab-target"
import { PageHeaderBar } from "../page-chrome/page-header-bar"
import type { PageCrumb } from "../page-chrome/page-chrome-types"
import { documentCrumbs } from "./document-breadcrumbs"
import { useDocumentMenuGroups } from "./document-menu"
import { LayerButton, type LayerKind } from "./document-actions"
import type { DocumentViewMode, EditorLayer } from "./use-document-view-mode"
import type { ContentWidth } from "../app-config"
import { motionTransitions } from "@/lib/motion-config"
import { cn } from "@/lib/utils"

/**
 * What a module may hand the header to replace the folder path of a note by a path of its own
 * (the workshop's). It is rendered in the header's place and calls `render` with the crumbs to show.
 */
export interface NoteTrailProps {
  noteId: string | undefined
  /** The note's folders: what the header shows when there is no path of the module's own. */
  folderCrumbs: PageCrumb[]
  /** Opens a page of the module in place (a history step). */
  onOpenPage?: (pageId: string, sectionId?: string) => void
  onOpenNote?: (noteId: string) => void
  render: (crumbs: PageCrumb[]) => ReactElement | null
}

export interface DocumentHeaderProps {
  /** The module's path for the note, in place of its folders. */
  NoteTrail?: ComponentType<NoteTrailProps>
  onOpenWorkshopPage?: (projectId: string, sectionId?: string) => void
  hasDocument: boolean
  docId?: string
  docTitle?: string
  docPath?: string
  treeItems?: TreeItem[]
  onOpenItem?: (id: string) => void
  onBack?: () => void
  onForward?: () => void
  canGoBack?: boolean
  canGoForward?: boolean
  isFocusMode?: boolean
  hideNavigation?: boolean
  onToggleFocusMode?: () => void
  focusTabs?: HeaderTab[]
  activeTabKey?: string
  onFocusTabChange?: (key: string) => void
  focusFavorites?: Set<string>
  onFocusToggleFavorite?: (id: string) => void
  onFocusCloseAllTabs?: () => void
  activeLayer?: EditorLayer
  onLayerChange?: (layer: EditorLayer) => void
  linkedLayers?: { note?: boolean; canvas: boolean; sketch: boolean; database: boolean }
  databasesEnabled?: boolean
  canvasEnabled?: boolean
  sketchEnabled?: boolean
  canCreateDatabaseLayer?: boolean
  onUnlinkLayer?: (layer: LayerKind) => void
  onDeleteLayer?: (layer: LayerKind) => void
  isLocked?: boolean
  onToggleLock?: () => void
  isFavorite?: boolean
  onToggleFavorite?: () => void
  onOpenInNewTab?: () => void
  onSplitRight?: () => void
  onSplitDown?: () => void
  viewMode: DocumentViewMode
  onViewModeChange: (mode: DocumentViewMode) => void
  contentWidth: ContentWidth
  onContentWidthChange: (width: ContentWidth) => void
  nestedNotes: TreeItem[]
  nestedNotesPlacement: "top" | "bottom" | "hidden"
  onNestedNotesPlacementChange?: (placement: "top" | "bottom" | "hidden") => void
  onRequestAttachLayer: (layer: EditorLayer) => void
  onRequestMove: () => void
  onRequestMerge: () => void
  onCopyPath: (kind: "app" | "vault" | "absolute") => void
  onExportPdf: () => void
  onExportCsv?: () => void
  onExportSqlite?: () => void
  onExportImage?: (format: "png" | "jpg") => void
  onShowInExplorer?: () => void
  onRequestRename: () => void
  onDeleteFile?: (mode?: "archive") => void
  moreActionsOpen: boolean
  onMoreActionsOpenChange: (open: boolean) => void
}

export function DocumentHeader({
  NoteTrail,
  onOpenWorkshopPage,
  hasDocument,
  docId,
  docTitle,
  docPath,
  treeItems,
  onOpenItem,
  onBack,
  onForward,
  canGoBack = false,
  canGoForward = false,
  isFocusMode = false,
  hideNavigation = false,
  onToggleFocusMode,
  focusTabs = [],
  activeTabKey,
  onFocusTabChange,
  focusFavorites,
  onFocusToggleFavorite,
  onFocusCloseAllTabs,
  activeLayer = "editor",
  onLayerChange,
  linkedLayers,
  databasesEnabled = false,
  canvasEnabled = true,
  sketchEnabled = true,
  canCreateDatabaseLayer = false,
  onUnlinkLayer,
  onDeleteLayer,
  isLocked = false,
  onToggleLock,
  isFavorite = false,
  onToggleFavorite,
  onOpenInNewTab,
  onSplitRight,
  onSplitDown,
  viewMode,
  onViewModeChange,
  contentWidth,
  onContentWidthChange,
  nestedNotes,
  nestedNotesPlacement,
  onNestedNotesPlacementChange,
  onRequestAttachLayer,
  onRequestMove,
  onRequestMerge,
  onCopyPath,
  onExportPdf,
  onExportCsv,
  onExportSqlite,
  onExportImage,
  onShowInExplorer,
  onRequestRename,
  onDeleteFile,
  moreActionsOpen,
  onMoreActionsOpenChange,
}: DocumentHeaderProps) {
  const { t } = useTranslation()
  const primaryLayers = useViewStateStore((s) => s.primaryLayers)
  const setPrimaryLayer = useViewStateStore((s) => s.setPrimaryLayer)
  const setActiveLayer = useViewStateStore((s) => s.setActiveLayer)

  const hasNote = Boolean(
    activeLayer === "editor" ||
    linkedLayers?.note ||
    (!linkedLayers?.canvas && !linkedLayers?.sketch && !linkedLayers?.database),
  )
  const hasDatabase = Boolean(
    databasesEnabled && (linkedLayers?.database || activeLayer === "database"),
  )
  const hasCanvas = Boolean(canvasEnabled && (linkedLayers?.canvas || activeLayer === "canvas"))
  const hasSketch = Boolean(sketchEnabled && (linkedLayers?.sketch || activeLayer === "sketch"))

  const totalLayersCount =
    (hasNote ? 1 : 0) + (hasDatabase ? 1 : 0) + (hasCanvas ? 1 : 0) + (hasSketch ? 1 : 0)

  const showNoteButton = hasNote

  const currentItem = useMemo(() => {
    if (!treeItems) return null
    return (
      (docId ? findTabTreeItem(treeItems, docId) : null) ??
      (docPath ? findTabTreeItem(treeItems, docPath) : null)
    )
  }, [treeItems, docId, docPath])

  const attachedDatabase = useMemo(() => {
    const databases = useDatabaseStore.getState().databases
    return databases.find(
      (d) =>
        (docId && (d.databaseId === docId || d.attachedNoteId === docId)) ||
        (docPath && (d.databaseId === docPath || d.attachedNoteId === docPath)) ||
        (currentItem &&
          (d.databaseId === currentItem.id ||
            d.attachedNoteId === currentItem.id ||
            d.databaseId === currentItem.path ||
            d.attachedNoteId === currentItem.path)),
    )
  }, [docId, docPath, currentItem])

  const primaryLayer =
    (docId ? primaryLayers[docId] : undefined) ??
    (docPath ? primaryLayers[docPath] : undefined) ??
    (currentItem?.id ? primaryLayers[currentItem.id] : undefined) ??
    (currentItem?.path ? primaryLayers[currentItem.path] : undefined) ??
    (attachedDatabase?.databaseId ? primaryLayers[attachedDatabase.databaseId] : undefined) ??
    (attachedDatabase?.attachedNoteId ? primaryLayers[attachedDatabase.attachedNoteId] : undefined)

  const handleSetPrimaryLayer = (layer: EditorLayer) => {
    const keysToSet = new Set<string>()
    if (docId) keysToSet.add(docId)
    if (docPath) keysToSet.add(docPath)
    if (currentItem?.id) keysToSet.add(currentItem.id)
    if (currentItem?.path) keysToSet.add(currentItem.path)
    if (attachedDatabase?.databaseId) keysToSet.add(attachedDatabase.databaseId)
    if (attachedDatabase?.attachedNoteId) keysToSet.add(attachedDatabase.attachedNoteId)

    for (const key of Array.from(keysToSet)) {
      const stripped = key.replace(/^(database|canvas|sketch):/u, "")
      if (stripped) keysToSet.add(stripped)
    }

    for (const key of keysToSet) {
      setPrimaryLayer(key, layer)
      setActiveLayer(key, layer)
    }

    const targetKind: TabKind = layer === "editor" ? "document" : layer
    useTabsStore.getState().setTabs((prevTabs) =>
      prevTabs.map((t) => {
        const matches =
          keysToSet.has(t.fileId) ||
          keysToSet.has(t.fileId.replace(/^(database|canvas|sketch):/u, ""))
        if (matches && t.kind !== targetKind) {
          return { ...t, kind: targetKind }
        }
        return t
      }),
    )

    onLayerChange?.(layer)
  }

  const menuGroups = useDocumentMenuGroups({
    hasDocument,
    activeLayer,
    onLayerChange,
    onUnlinkLayer,
    onDeleteLayer,
    docPath,
    primaryLayer,
    onSetPrimaryLayer: handleSetPrimaryLayer,
    databasesEnabled,
    canvasEnabled,
    sketchEnabled,
    isLocked,
    onToggleLock,
    viewMode,
    onViewModeChange,
    contentWidth,
    onContentWidthChange,
    nestedNotes,
    nestedNotesPlacement,
    onNestedNotesPlacementChange,
    linkedLayers,
    canCreateDatabaseLayer,
    onRequestAttachLayer,
    isFavorite,
    onToggleFavorite,
    onOpenInNewTab,
    onSplitRight,
    onSplitDown,
    onRequestMove,
    onRequestMerge,
    onCopyPath,
    onExportPdf,
    onExportCsv,
    onExportSqlite,
    onExportImage,
    onShowInExplorer,
    onRequestRename,
    onDeleteFile,
  })

  if (hideNavigation) return null

  const layerSwitcher = (isUltraNarrow: boolean) => {
    if (!hasDocument || totalLayersCount <= 1) return null
    return isUltraNarrow ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={t("docEditor.layers")}
            aria-label={t("docEditor.layers")}
            className="mr-1 flex size-7 items-center justify-center rounded-full bg-accent text-foreground shadow-sm hover:bg-accent/80"
          >
            {activeLayer === "database" ? (
              <Database className="size-3.5" />
            ) : activeLayer === "canvas" ? (
              <LayoutGrid className="size-3.5" />
            ) : activeLayer === "sketch" ? (
              <PenLine className="size-3.5" />
            ) : (
              <FileText className="size-3.5" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48 border-border bg-popover text-foreground">
          {showNoteButton && (
            <DropdownMenuItem
              className={cn(
                "flex items-center gap-2",
                activeLayer === "editor" && "bg-primary/10 text-primary font-medium",
              )}
              onSelect={() => onLayerChange?.("editor")}
            >
              <FileText className="mr-2 size-3.5" />
              <span className="flex-1">{t("docEditor.markdownEditor")}</span>
              {activeLayer === "editor" && <Check className="size-3.5 text-primary" />}
            </DropdownMenuItem>
          )}
          {databasesEnabled && (linkedLayers?.database || activeLayer === "database") && (
            <DropdownMenuItem
              className={cn(
                "flex items-center gap-2",
                activeLayer === "database" && "bg-primary/10 text-primary font-medium",
              )}
              onSelect={() => onLayerChange?.("database")}
            >
              <Database className="mr-2 size-3.5" />
              <span className="flex-1">{t("docEditor.databaseLayer")}</span>
              {activeLayer === "database" && <Check className="size-3.5 text-primary" />}
            </DropdownMenuItem>
          )}
          {canvasEnabled && (linkedLayers?.canvas || activeLayer === "canvas") && (
            <DropdownMenuItem
              className={cn(
                "flex items-center gap-2",
                activeLayer === "canvas" && "bg-primary/10 text-primary font-medium",
              )}
              onSelect={() => onLayerChange?.("canvas")}
            >
              <LayoutGrid className="mr-2 size-3.5" />
              <span className="flex-1">{t("docEditor.canvasLayer")}</span>
              {activeLayer === "canvas" && <Check className="size-3.5 text-primary" />}
            </DropdownMenuItem>
          )}
          {sketchEnabled && (linkedLayers?.sketch || activeLayer === "sketch") && (
            <DropdownMenuItem
              className={cn(
                "flex items-center gap-2",
                activeLayer === "sketch" && "bg-primary/10 text-primary font-medium",
              )}
              onSelect={() => onLayerChange?.("sketch")}
            >
              <PenLine className="mr-2 size-3.5" />
              <span className="flex-1">{t("docEditor.sketchLayer")}</span>
              {activeLayer === "sketch" && <Check className="size-3.5 text-primary" />}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : (
      <div className="mr-1 flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5 shadow-2xs">
        {showNoteButton && (
          <motion.button
            type="button"
            title={t("docEditor.markdownEditor")}
            onClick={() => onLayerChange?.("editor")}
            className={cn(
              "relative flex size-7 items-center justify-center rounded-md text-sm select-none cursor-pointer",
              activeLayer === "editor"
                ? "text-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
            )}
            whileHover={activeLayer === "editor" ? undefined : { scale: 1.05 }}
            whileTap={{ scale: 0.92 }}
            transition={motionTransitions.fast}
          >
            {activeLayer === "editor" && (
              <motion.div
                layoutId="activeDocumentLayerPill"
                className="absolute inset-0 rounded-md bg-[var(--note-surface)] shadow-xs border border-border/80"
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
              />
            )}
            <span className="relative z-10 flex items-center justify-center">
              <FileText className="size-3.5" />
            </span>
          </motion.button>
        )}
        {databasesEnabled && (linkedLayers?.database || activeLayer === "database") && (
          <LayerButton
            layer="database"
            title={t("docEditor.databaseLayer")}
            icon={<Database className="size-3.5" />}
            active={activeLayer === "database"}
            onActivate={() => onLayerChange?.("database")}
            onUnlink={onUnlinkLayer}
            onDelete={onDeleteLayer}
          />
        )}
        {canvasEnabled && (linkedLayers?.canvas || activeLayer === "canvas") && (
          <LayerButton
            layer="canvas"
            title={t("docEditor.canvasLayer")}
            icon={<LayoutGrid className="size-3.5" />}
            active={activeLayer === "canvas"}
            onActivate={() => onLayerChange?.("canvas")}
            onUnlink={onUnlinkLayer}
            onDelete={onDeleteLayer}
          />
        )}
        {sketchEnabled && (linkedLayers?.sketch || activeLayer === "sketch") && (
          <LayerButton
            layer="sketch"
            title={t("docEditor.sketchLayer")}
            icon={<PenLine className="size-3.5" />}
            active={activeLayer === "sketch"}
            onActivate={() => onLayerChange?.("sketch")}
            onUnlink={onUnlinkLayer}
            onDelete={onDeleteLayer}
          />
        )}
      </div>
    )
  }

  const bar = (crumbs: PageCrumb[]) => (
    <PageHeaderBar
      crumbs={crumbs}
      fallbackTitle={docId || docTitle ? docTitle : undefined}
      onBack={onBack}
      onForward={onForward}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      isFocusMode={isFocusMode}
      onToggleFocusMode={onToggleFocusMode}
      focus={{
        title: docTitle ?? "",
        tabs: focusTabs,
        activeTabKey,
        activeFileId: docId,
        favorites: focusFavorites,
        onTabChange: onFocusTabChange,
        onToggleFavorite: onFocusToggleFavorite,
        onCloseAllTabs: onFocusCloseAllTabs,
      }}
      leadingActions={(size) => layerSwitcher(size.isUltraNarrow)}
      menu={{ groups: menuGroups, open: moreActionsOpen, onOpenChange: onMoreActionsOpenChange }}
    />
  )
  const folderCrumbs = documentCrumbs(treeItems, docId, docPath, onOpenItem)
  return NoteTrail ? (
    <NoteTrail
      noteId={docId}
      folderCrumbs={folderCrumbs}
      onOpenPage={onOpenWorkshopPage}
      onOpenNote={onOpenItem}
      render={bar}
    />
  ) : (
    bar(folderCrumbs)
  )
}
