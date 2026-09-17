import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"
import {
  Check,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TabsMenu, type HeaderTab } from "../header-tabs"
import type { TreeItem } from "../sidebar-tree"
import { DocumentBreadcrumbs } from "./document-breadcrumbs"
import { DocumentActionsDropdown, LayerButton, type LayerKind } from "./document-actions"
import type { DocumentViewMode, EditorLayer } from "./use-document-view-mode"
import type { ContentWidth } from "../app-config"
import { handleDragStart } from "./document-header-utils"
import { motionTransitions } from "@/lib/motion-config"
import { cn } from "@/lib/utils"

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
  linkedLayers?: { note?: boolean; canvas: boolean; sketch: boolean; database: boolean }
  databasesEnabled?: boolean
  canCreateDatabaseLayer?: boolean
  onUnlinkLayer?: (layer: LayerKind) => void
  onDeleteLayer?: (layer: LayerKind) => void
  isLocked?: boolean
  onToggleLock?: () => void
  isFavorite?: boolean
  onToggleFavorite?: () => void
  onOpenInNewTab?: () => void
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
  canCreateDatabaseLayer = false,
  onUnlinkLayer,
  onDeleteLayer,
  isLocked = false,
  onToggleLock,
  isFavorite = false,
  onToggleFavorite,
  onOpenInNewTab,
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
  const [pathHovered, setPathHovered] = useState(false)
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerWidth, setHeaderWidth] = useState(600)

  useEffect(() => {
    const element = headerRef.current
    if (!element) return

    const updateWidth = () => {
      setHeaderWidth(element.clientWidth)
    }

    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const isNarrow = headerWidth < 420
  const isUltraNarrow = headerWidth < 340
  const isTiny = headerWidth < 250
  const showNoteButton =
    activeLayer === "editor" ||
    linkedLayers?.note ||
    (!linkedLayers?.canvas && !linkedLayers?.sketch && !linkedLayers?.database)

  if (hideNavigation) return null

  const breadcrumbElement = (
    <DocumentBreadcrumbs
      treeItems={treeItems}
      docId={docId}
      docTitle={docTitle}
      docPath={docPath}
      onOpenItem={onOpenItem}
      expanded={pathHovered}
      onExpandChange={setPathHovered}
    />
  )

  return (
    <div
      ref={headerRef}
      className={`relative h-10 shrink-0 min-w-0 items-center px-2 ${
        isFocusMode
          ? "z-30 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] bg-transparent"
          : "flex justify-between bg-transparent"
      }`}
    >
      {/* Left: back/forward and, in focus mode, the document path. */}
      <div className="flex min-w-0 shrink-0 items-center gap-0.5">
        {isFocusMode && <div className="h-10 w-6 cursor-default" onMouseDown={handleDragStart} />}
        <Button
          variant="ghost"
          size="icon"
          className={`size-7 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-30 ${!isFocusMode && pathHovered ? "pointer-events-none" : ""}`}
          animate={{ opacity: !isFocusMode && pathHovered ? 0 : 1 }}
          transition={motionTransitions.default}
          onClick={onBack}
          disabled={!canGoBack}
        >
          <ChevronLeft className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={`size-7 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-30 ${!isFocusMode && pathHovered ? "pointer-events-none" : ""}`}
          animate={{ opacity: !isFocusMode && pathHovered ? 0 : 1 }}
          transition={motionTransitions.default}
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
      <motion.div
        data-path-expanded={pathHovered || undefined}
        className={`flex min-w-0 flex-1 items-center justify-center gap-1 px-2 text-xs [&[data-path-expanded=true]_[data-breadcrumb-segment]]:max-w-none ${pathHovered ? "absolute inset-x-4 top-2 z-20 min-h-10 justify-start overflow-visible rounded-lg bg-white px-5 text-sm text-slate-900 shadow-lg ring-1 ring-slate-200" : isNarrow ? "hidden" : "overflow-hidden"}`}
        layout
        initial={false}
        animate={{ scale: pathHovered ? 1.01 : 1 }}
        transition={motionTransitions.slow}
        onMouseLeave={() => pathHovered && setPathHovered(false)}
      >
        {isFocusMode ? (
          <TabsMenu
            trigger={
              <button
                type="button"
                className="flex max-w-[320px] items-center gap-1 rounded-md px-2 py-1 font-medium text-foreground hover:bg-accent"
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
      </motion.div>

      {/* Right: layer + focus + more */}
      <motion.div
        className={`flex shrink-0 items-center gap-0.5 ${isFocusMode ? "justify-self-end" : ""} ${!isFocusMode && pathHovered ? "pointer-events-none" : ""}`}
        initial={false}
        animate={{ opacity: !isFocusMode && pathHovered ? 0 : 1 }}
        transition={motionTransitions.default}
      >
        {hasDocument &&
          (isUltraNarrow ? (
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
              <DropdownMenuContent
                align="end"
                className="w-48 border-border bg-popover text-foreground"
              >
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
                {linkedLayers?.canvas && (
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
                {linkedLayers?.sketch && (
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
            <div className="mr-1 flex items-center gap-0.5 rounded-lg border border-border/70 bg-muted/50 p-0.5 shadow-2xs">
              {showNoteButton && (
                <button
                  type="button"
                  title={t("docEditor.markdownEditor")}
                  onClick={() => onLayerChange?.("editor")}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md",
                    activeLayer === "editor"
                      ? "bg-primary text-primary-foreground shadow-xs font-semibold"
                      : "bg-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <FileText className="size-3.5" />
                </button>
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
          ))}
        {!isTiny && (
          <Button
            variant="ghost"
            size="icon"
            className={`size-7 hover:bg-accent ${isFocusMode ? "text-foreground" : "text-muted-foreground hover:text-white"}`}
            onClick={onToggleFocusMode}
            title={isFocusMode ? t("docEditor.focusModeExit") : t("docEditor.focusModeEnter")}
          >
            {isFocusMode ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </Button>
        )}
        <DocumentActionsDropdown
          open={moreActionsOpen}
          onOpenChange={onMoreActionsOpenChange}
          hasDocument={hasDocument}
          activeLayer={activeLayer}
          isLocked={isLocked}
          onToggleLock={onToggleLock}
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
          contentWidth={contentWidth}
          onContentWidthChange={onContentWidthChange}
          nestedNotes={nestedNotes}
          nestedNotesPlacement={nestedNotesPlacement}
          onNestedNotesPlacementChange={onNestedNotesPlacementChange}
          linkedLayers={linkedLayers}
          canCreateDatabaseLayer={canCreateDatabaseLayer}
          onRequestAttachLayer={onRequestAttachLayer}
          isFavorite={isFavorite}
          onToggleFavorite={onToggleFavorite}
          onOpenInNewTab={onOpenInNewTab}
          onRequestMove={onRequestMove}
          onRequestMerge={onRequestMerge}
          onCopyPath={onCopyPath}
          onExportPdf={onExportPdf}
          onExportCsv={onExportCsv}
          onExportSqlite={onExportSqlite}
          onExportImage={onExportImage}
          onShowInExplorer={onShowInExplorer}
          onRequestRename={onRequestRename}
          onDeleteFile={onDeleteFile}
        />
      </motion.div>
    </div>
  )
}
