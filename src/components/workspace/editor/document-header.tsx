import { useTranslation } from "react-i18next"
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  FileText,
  LayoutGrid,
  Maximize2,
  Minimize2,
  PenLine,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { TabsMenu, type HeaderTab } from "../header-tabs"
import type { TreeItem } from "../sidebar-tree"
import { DocumentBreadcrumbs } from "./document-breadcrumbs"
import { DocumentActionsDropdown, LayerButton, type LayerKind } from "./document-actions"
import type { DocumentViewMode, EditorLayer } from "./use-document-view-mode"
import { handleDragStart } from "./document-header-utils"

export interface DocumentHeaderProps {
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
  linkedLayers?: { canvas: boolean; sketch: boolean; database: boolean }
  onUnlinkLayer?: (layer: LayerKind) => void
  onDeleteLayer?: (layer: LayerKind) => void
  isLocked?: boolean
  isFavorite?: boolean
  onToggleFavorite?: () => void
  onOpenInNewTab?: () => void
  viewMode: DocumentViewMode
  onViewModeChange: (mode: DocumentViewMode) => void
  nestedNotes: TreeItem[]
  nestedNotesPlacement: "top" | "bottom" | "hidden"
  onNestedNotesPlacementChange?: (placement: "top" | "bottom" | "hidden") => void
  onRequestAttachLayer: (layer: EditorLayer) => void
  onRequestMove: () => void
  onRequestMerge: () => void
  onCopyPath: (kind: "app" | "vault" | "absolute") => void
  onShowInExplorer?: () => void
  onRequestRename: () => void
  onDeleteFile?: () => void
  moreActionsOpen: boolean
  onMoreActionsOpenChange: (open: boolean) => void
}

export function DocumentHeader({
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
  onUnlinkLayer,
  onDeleteLayer,
  isLocked = false,
  isFavorite = false,
  onToggleFavorite,
  onOpenInNewTab,
  viewMode,
  onViewModeChange,
  nestedNotes,
  nestedNotesPlacement,
  onNestedNotesPlacementChange,
  onRequestAttachLayer,
  onRequestMove,
  onRequestMerge,
  onCopyPath,
  onShowInExplorer,
  onRequestRename,
  onDeleteFile,
  moreActionsOpen,
  onMoreActionsOpenChange,
}: DocumentHeaderProps) {
  const { t } = useTranslation()

  if (hideNavigation) return null

  const breadcrumbElement = (
    <DocumentBreadcrumbs
      treeItems={treeItems}
      docId={docId}
      docTitle={docTitle}
      docPath={docPath}
      onOpenItem={onOpenItem}
    />
  )

  return (
    <div
      className={`h-10 shrink-0 items-center px-2 ${
        isFocusMode
          ? "z-30 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] bg-transparent"
          : "flex justify-between bg-transparent"
      }`}
    >
      {/* Left: back/forward and, in focus mode, the document path. */}
      <div className="flex min-w-0 items-center gap-0.5">
        {isFocusMode && <div className="h-10 w-6 cursor-default" onMouseDown={handleDragStart} />}
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-30"
          onClick={onBack}
          disabled={!canGoBack}
        >
          <ChevronLeft className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-30"
          onClick={onForward}
          disabled={!canGoForward}
        >
          <ChevronRight className="size-3.5" />
        </Button>
        {isFocusMode && (
          <div className="ml-1 flex min-w-0 items-center gap-1 overflow-hidden text-xs">
            {breadcrumbElement}
          </div>
        )}
      </div>

      {/* Center: current tab menu in focus mode; breadcrumb otherwise. */}
      <div className="flex min-w-0 flex-1 items-center justify-center gap-1 overflow-hidden px-2 text-xs">
        {isFocusMode ? (
          <TabsMenu
            trigger={
              <button
                type="button"
                className="flex max-w-[320px] items-center gap-1 rounded-md px-2 py-1 font-medium text-foreground transition-colors hover:bg-accent"
                title={t("tabs.tabMenu")}
              >
                <span className="truncate">{docTitle ?? ""}</span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            }
            tabs={focusTabs}
            activeTabKey={activeTabKey ?? ""}
            activeFileId={docId}
            favorites={focusFavorites}
            onTabChange={(key) => onFocusTabChange?.(key)}
            onToggleFavorite={onFocusToggleFavorite}
            onCloseAllTabs={onFocusCloseAllTabs}
            align="center"
          />
        ) : (
          breadcrumbElement
        )}
      </div>

      {/* Right: layer + focus + more */}
      <div className={`flex items-center gap-0.5 ${isFocusMode ? "justify-self-end" : ""}`}>
        {hasDocument && (
          <div className="mr-1 flex items-center gap-1 rounded-full bg-background/70 p-0.5 shadow-sm">
            <button
              type="button"
              title={t("docEditor.markdownEditor")}
              onClick={() => onLayerChange?.("editor")}
              className={`flex size-7 items-center justify-center rounded-full transition-colors ${
                activeLayer === "editor"
                  ? "bg-accent text-foreground"
                  : "bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <FileText className="size-3.5" />
            </button>
            {linkedLayers?.canvas && (
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
            {linkedLayers?.database && (
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
            {linkedLayers?.sketch && (
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
        )}
        <Button
          variant="ghost"
          size="icon"
          className={`size-7 hover:bg-accent ${isFocusMode ? "text-foreground" : "text-muted-foreground hover:text-white"}`}
          onClick={onToggleFocusMode}
          title={isFocusMode ? t("docEditor.focusModeExit") : t("docEditor.focusModeEnter")}
        >
          {isFocusMode ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </Button>
        <DocumentActionsDropdown
          open={moreActionsOpen}
          onOpenChange={onMoreActionsOpenChange}
          hasDocument={hasDocument}
          activeLayer={activeLayer}
          isLocked={isLocked}
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
          nestedNotes={nestedNotes}
          nestedNotesPlacement={nestedNotesPlacement}
          onNestedNotesPlacementChange={onNestedNotesPlacementChange}
          linkedLayers={linkedLayers}
          onRequestAttachLayer={onRequestAttachLayer}
          isFavorite={isFavorite}
          onToggleFavorite={onToggleFavorite}
          onOpenInNewTab={onOpenInNewTab}
          onRequestMove={onRequestMove}
          onRequestMerge={onRequestMerge}
          onCopyPath={onCopyPath}
          onShowInExplorer={onShowInExplorer}
          onRequestRename={onRequestRename}
          onDeleteFile={onDeleteFile}
        />
      </div>
    </div>
  )
}
