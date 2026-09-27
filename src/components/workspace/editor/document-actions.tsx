"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Archive,
  ArrowLeftRight,
  Check,
  Code2,
  Copy,
  Database,
  Eye,
  EyeOff,
  FileDown,
  Files,
  FileText,
  FolderInput,
  FolderOpen,
  GitMerge,
  Layers,
  LayoutGrid,
  Maximize2,
  MoreVertical,
  PanelBottom,
  PanelTop,
  PenLine,
  Plus,
  Search,
  SquareArrowOutUpRight,
  Star,
  Trash2,
  Unlink,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { motion } from "motion/react"
import { motionTransitions } from "@/lib/motion-config"
import { cn } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { TreeItem } from "../sidebar-tree"
import { relativeToVault } from "./document-breadcrumbs-utils"
import type { DocumentViewMode, EditorLayer } from "./use-document-view-mode"
import type { ContentWidth } from "../app-config"

export type LayerKind = "canvas" | "database" | "sketch" | "note"

export function LayerButton({
  layer,
  title,
  icon,
  active,
  onActivate,
  onUnlink,
  onDelete,
}: {
  layer: LayerKind
  title: string
  icon: React.ReactNode
  active: boolean
  onActivate: () => void
  onUnlink?: (layer: LayerKind) => void
  onDelete?: (layer: LayerKind) => void
}) {
  const { t } = useTranslation()
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <motion.button
          type="button"
          title={title}
          onClick={onActivate}
          className={cn(
            "relative flex size-7 items-center justify-center rounded-md text-sm select-none cursor-pointer",
            active
              ? "text-foreground font-medium"
              : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
          )}
          whileHover={active ? undefined : { scale: 1.05 }}
          whileTap={{ scale: 0.92 }}
          transition={motionTransitions.fast}
        >
          {active && (
            <motion.div
              layoutId="activeDocumentLayerPill"
              className="absolute inset-0 rounded-md bg-[var(--note-surface)] shadow-xs border border-border/80"
              transition={{ type: "spring", stiffness: 500, damping: 38 }}
            />
          )}
          <span className="relative z-10 flex items-center justify-center">{icon}</span>
        </motion.button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={() => onUnlink?.(layer)}>
          {t("docEditor.detach")}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => onDelete?.(layer)}
          className="text-red-400 focus:text-red-300"
        >
          {t("docEditor.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function LayerConfirmDialog({
  layerConfirm,
  onClose,
  onConfirm,
}: {
  layerConfirm: EditorLayer | null
  onClose: () => void
  onConfirm: (layer: EditorLayer) => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog
      open={layerConfirm !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="w-72 border-border bg-popover p-4 text-foreground sm:max-w-xs"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            if (layerConfirm) onConfirm(layerConfirm)
          }
        }}
      >
        <p className="text-[13px] leading-snug">
          {layerConfirm === "canvas"
            ? t("docEditor.confirmCreateCanvas")
            : layerConfirm === "sketch"
              ? t("docEditor.confirmCreateSketch")
              : layerConfirm === "database"
                ? t("docEditor.confirmCreateDatabase")
                : t("docEditor.confirmCreateNote")}
        </p>
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-border px-2.5 py-1 text-xs text-foreground hover:bg-card"
            onClick={onClose}
          >
            {t("docEditor.cancel")}
          </button>
          <button
            type="button"
            autoFocus
            className="rounded bg-foreground px-2.5 py-1 text-xs font-medium text-background hover:bg-foreground/90"
            onClick={() => {
              if (layerConfirm) onConfirm(layerConfirm)
            }}
          >
            {t("docEditor.create")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function FilePickerModal({
  filePickerMode,
  onClose,
  filePickerQuery,
  onQueryChange,
  pickerItems,
  vault,
  onMoveFile,
  onCreateFolder,
  onMergeFile,
}: {
  filePickerMode: "move" | "merge" | null
  onClose: () => void
  filePickerQuery: string
  onQueryChange: (query: string) => void
  pickerItems: TreeItem[]
  vault?: string
  onMoveFile?: (targetFolderId: string | null) => void
  onCreateFolder?: (parentId: string | null, name: string) => void
  onMergeFile?: (targetId: string) => void
}) {
  const { t } = useTranslation()
  const isMoveMode = filePickerMode === "move"
  const [activeIndex, setActiveIndex] = React.useState(0)
  const optionRefs = React.useRef<Array<HTMLButtonElement | null>>([])

  const normalizedQuery = filePickerQuery.trim().toLocaleLowerCase()
  const rootLabel = t("docEditor.vaultRoot")
  const rootMatches = isMoveMode && rootLabel.toLocaleLowerCase().includes(normalizedQuery)
  const moveOptions = React.useMemo(
    () => [
      ...(rootMatches
        ? [{ id: "__amby_root__", item: null as TreeItem | null, label: rootLabel }]
        : []),
      ...pickerItems.map((item) => ({
        id: item.id,
        item,
        label: relativeToVault(item.path, vault ?? "").replace(/^\/+/, "") || item.name,
      })),
    ],
    [pickerItems, rootLabel, rootMatches, vault],
  )
  const options = isMoveMode
    ? moveOptions
    : pickerItems.map((item) => ({ id: item.id, item, label: item.name }))

  React.useEffect(() => {
    if (filePickerMode !== null) setActiveIndex(0)
  }, [filePickerMode])

  React.useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(options.length - 1, 0)))
  }, [options.length])

  React.useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  function activateOption(index: number) {
    const option = options[index]
    if (!option) return
    if (isMoveMode) onMoveFile?.(option.item?.id ?? null)
    else if (option.item) onMergeFile?.(option.item.id)
    onClose()
  }

  function handlePickerKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (options.length === 0) return
      setActiveIndex((current) => {
        const offset = event.key === "ArrowDown" ? 1 : -1
        return (current + offset + options.length) % options.length
      })
      return
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault()
      setActiveIndex(event.key === "Home" ? 0 : Math.max(options.length - 1, 0))
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      if (event.shiftKey && isMoveMode) {
        const folderName = filePickerQuery.trim()
        if (folderName && onCreateFolder) {
          onCreateFolder(options[activeIndex]?.item?.id ?? null, folderName)
          onClose()
        }
      } else activateOption(activeIndex)
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <Dialog open={filePickerMode !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        onKeyDown={isMoveMode ? handlePickerKeyDown : undefined}
        className={
          isMoveMode
            ? "w-[min(44rem,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden border-border bg-popover p-0 text-foreground sm:max-w-none"
            : "max-w-sm gap-3 p-4"
        }
      >
        {isMoveMode ? (
          <>
            <DialogHeader className="sr-only">
              <DialogTitle>{t("docEditor.moveFile")}</DialogTitle>
            </DialogHeader>
            <div className="border-b border-border px-4 py-3">
              <Input
                autoFocus
                value={filePickerQuery}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder={t("docEditor.filePickerPlaceholder")}
                className="h-9 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
                aria-controls="amby-move-folder-list"
              />
            </div>
            <div
              id="amby-move-folder-list"
              role="listbox"
              aria-label={t("docEditor.moveFile")}
              className="max-h-[min(32rem,60vh)] overflow-y-auto px-2 py-2"
            >
              {moveOptions.length > 0 ? (
                moveOptions.map((option, index) => (
                  <button
                    key={option.id}
                    ref={(element) => {
                      optionRefs.current[index] = element
                    }}
                    type="button"
                    role="option"
                    aria-selected={activeIndex === index}
                    className={cn(
                      "flex w-full items-center rounded-md px-3 py-2 text-left text-sm",
                      activeIndex === index
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-accent/70",
                    )}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => activateOption(index)}
                  >
                    {option.label}
                  </button>
                ))
              ) : (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {t("docEditor.noMergeTargets")}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 border-t border-border px-4 py-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-medium">
                  ↑↓
                </kbd>
                {t("docEditor.filePickerNavigate")}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-medium">
                  ↵
                </kbd>
                {t("docEditor.filePickerMoveHint")}
              </span>
              {onCreateFolder && (
                <span className="inline-flex items-center gap-1.5">
                  <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-medium">
                    {t("docEditor.filePickerCreateFolderKey")}
                  </kbd>
                  {t("docEditor.filePickerCreateFolderHint")}
                </span>
              )}
              <span className="inline-flex items-center gap-1.5">
                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-medium">
                  {t("docEditor.filePickerCancelKey")}
                </kbd>
                {t("docEditor.filePickerCancelHint")}
              </span>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-sm">{t("docEditor.mergeWith")}</DialogTitle>
            </DialogHeader>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={filePickerQuery}
                onChange={(event) => onQueryChange(event.target.value)}
                onKeyDown={handlePickerKeyDown}
                placeholder={t("docEditor.filePickerSearch")}
                className="h-9 pl-8 text-xs"
              />
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {pickerItems.map((item, index) => (
                <button
                  key={item.id}
                  ref={(element) => {
                    optionRefs.current[index] = element
                  }}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs hover:bg-accent",
                    activeIndex === index && "bg-accent text-accent-foreground",
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => activateOption(index)}
                >
                  <FileText className="size-4 text-muted-foreground" />
                  <span className="truncate">{item.name}</span>
                </button>
              ))}
              {pickerItems.length === 0 && (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {t("docEditor.noMergeTargets")}
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function DocumentActionsDropdown({
  open,
  onOpenChange,
  hasDocument,
  activeLayer,
  onLayerChange,
  onUnlinkLayer,
  onDeleteLayer,
  docPath,
  primaryLayer,
  onSetPrimaryLayer,
  databasesEnabled = false,
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
  canCreateDatabaseLayer = false,
  canvasEnabled = true,
  sketchEnabled = true,
  onRequestAttachLayer,
  isFavorite,
  onToggleFavorite,
  onOpenInNewTab,
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
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  hasDocument: boolean
  activeLayer: EditorLayer
  onLayerChange?: (layer: EditorLayer) => void
  onUnlinkLayer?: (layer: LayerKind) => void
  onDeleteLayer?: (layer: LayerKind) => void
  docPath?: string
  primaryLayer?: EditorLayer
  onSetPrimaryLayer?: (layer: EditorLayer) => void
  databasesEnabled?: boolean
  canvasEnabled?: boolean
  sketchEnabled?: boolean
  isLocked: boolean
  onToggleLock?: () => void
  viewMode: DocumentViewMode
  onViewModeChange: (mode: DocumentViewMode) => void
  contentWidth: ContentWidth
  onContentWidthChange: (width: ContentWidth) => void
  nestedNotes: TreeItem[]
  nestedNotesPlacement: "top" | "bottom" | "hidden"
  onNestedNotesPlacementChange?: (placement: "top" | "bottom" | "hidden") => void
  linkedLayers?: { note?: boolean; canvas: boolean; sketch: boolean; database: boolean }
  canCreateDatabaseLayer?: boolean
  onRequestAttachLayer: (layer: EditorLayer) => void
  isFavorite?: boolean
  onToggleFavorite?: () => void
  onOpenInNewTab?: () => void
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
}) {
  const { t } = useTranslation()

  const hasNote = Boolean(
    linkedLayers?.note ||
    activeLayer === "editor" ||
    (!linkedLayers?.canvas && !linkedLayers?.sketch && !linkedLayers?.database),
  )
  const hasDatabase = Boolean(
    databasesEnabled && (linkedLayers?.database || activeLayer === "database"),
  )
  const hasCanvas = Boolean(canvasEnabled && (linkedLayers?.canvas || activeLayer === "canvas"))
  const hasSketch = Boolean(sketchEnabled && (linkedLayers?.sketch || activeLayer === "sketch"))

  const totalLayersCount =
    (hasNote ? 1 : 0) + (hasDatabase ? 1 : 0) + (hasCanvas ? 1 : 0) + (hasSketch ? 1 : 0)

  const canAttachNote = !hasNote
  const canAttachDatabase = canCreateDatabaseLayer && !hasDatabase
  const canAttachCanvas = Boolean(canvasEnabled && !hasCanvas)
  const canAttachSketch = Boolean(sketchEnabled && !hasSketch)
  const hasAttachableLayers =
    canAttachNote || canAttachDatabase || canAttachCanvas || canAttachSketch

  const naturalDefaultLayer: EditorLayer = docPath?.endsWith(".canvas")
    ? "canvas"
    : docPath?.endsWith(".excalidraw")
      ? "sketch"
      : docPath?.endsWith(".json")
        ? "database"
        : "editor"
  const effectivePrimaryLayer = primaryLayer ?? naturalDefaultLayer

  const detachableLayers: Array<{
    kind: LayerKind
    Icon: React.ComponentType<{ className?: string }>
    deleteLabel: string
    detachLabel: string
  }> = []

  if (totalLayersCount > 1) {
    if (linkedLayers?.database) {
      detachableLayers.push({
        kind: "database",
        Icon: Database,
        deleteLabel: t("docEditor.deleteDatabase"),
        detachLabel: t("docEditor.detachDatabase"),
      })
    }
    if (linkedLayers?.canvas) {
      detachableLayers.push({
        kind: "canvas",
        Icon: LayoutGrid,
        deleteLabel: t("docEditor.deleteCanvas"),
        detachLabel: t("docEditor.detachCanvas"),
      })
    }
    if (linkedLayers?.sketch) {
      detachableLayers.push({
        kind: "sketch",
        Icon: PenLine,
        deleteLabel: t("docEditor.deleteSketch"),
        detachLabel: t("docEditor.detachSketch"),
      })
    }
    if (linkedLayers?.note && docPath && !docPath.endsWith(".md")) {
      detachableLayers.push({
        kind: "note",
        Icon: FileText,
        deleteLabel: t("docEditor.deleteNote"),
        detachLabel: t("docEditor.detachNote"),
      })
    }
  }

  const hasLayerActions = totalLayersCount > 1 || hasAttachableLayers

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("docEditor.moreActions")}
          title={t("docEditor.moreActions")}
          className="size-7 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <MoreVertical className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 border-border bg-popover text-foreground">
        {activeLayer === "editor" ? (
          (
            [
              ["live", PenLine, "docEditor.viewLive"],
              ["source", Code2, "docEditor.viewSource"],
              ["read", Eye, "docEditor.viewRead"],
            ] as const
          ).map(([mode, Icon, labelKey]) => (
            <DropdownMenuItem
              key={mode}
              disabled={!hasDocument}
              className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
              onSelect={() => onViewModeChange(mode)}
            >
              <Icon className="size-3.5 text-muted-foreground" />
              <span className="flex-1">{t(labelKey)}</span>
              {viewMode === mode && <span className="text-primary">✓</span>}
            </DropdownMenuItem>
          ))
        ) : (
          <>
            <DropdownMenuItem
              disabled={!hasDocument}
              className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
              onSelect={() => {
                if (isLocked) onToggleLock?.()
                if (viewMode === "read") onViewModeChange("live")
              }}
            >
              <PenLine className="size-3.5 text-muted-foreground" />
              <span className="flex-1">{t("docEditor.viewLive")}</span>
              {!isLocked && viewMode !== "read" && <span className="text-primary">✓</span>}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!hasDocument}
              className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
              onSelect={() => {
                if (!isLocked) onToggleLock?.()
                onViewModeChange("read")
              }}
            >
              <Eye className="size-3.5 text-muted-foreground" />
              <span className="flex-1">{t("docEditor.viewRead")}</span>
              {(isLocked || viewMode === "read") && <span className="text-primary">✓</span>}
            </DropdownMenuItem>
          </>
        )}

        {(activeLayer === "editor" || activeLayer === "database") && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white data-[state=open]:bg-accent">
              <Maximize2 className="size-3.5 text-muted-foreground" />
              {t("settings.editor.contentWidth")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-44 border-border bg-popover text-foreground">
              {(["normal", "wide", "full"] as const).map((width) => (
                <DropdownMenuItem
                  key={width}
                  disabled={!hasDocument}
                  className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                  onSelect={() => onContentWidthChange(width)}
                >
                  <span className="flex-1">{t(`settings.editor.${width}`)}</span>
                  {contentWidth === width && <span className="text-primary">✓</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSeparator className="bg-accent" />

        {activeLayer === "editor" && nestedNotes.length > 0 && (
          <>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white data-[state=open]:bg-accent">
                <Files className="size-3.5 text-muted-foreground" />
                {t("docEditor.nestedNotesDisplay")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48 border-border bg-popover text-foreground">
                {(["top", "bottom", "hidden"] as const).map((placement) => (
                  <DropdownMenuItem
                    key={placement}
                    className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                    onSelect={() => onNestedNotesPlacementChange?.(placement)}
                  >
                    {placement === "top" ? (
                      <PanelTop className="size-3.5 text-muted-foreground" />
                    ) : placement === "bottom" ? (
                      <PanelBottom className="size-3.5 text-muted-foreground" />
                    ) : (
                      <EyeOff className="size-3.5 text-muted-foreground" />
                    )}
                    <span className="flex-1">{t(`docEditor.nestedNotes_${placement}`)}</span>
                    {nestedNotesPlacement === placement && <span className="text-primary">✓</span>}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator className="bg-accent" />
          </>
        )}

        {hasLayerActions && (
          <>
            {totalLayersCount > 1 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white data-[state=open]:bg-accent">
                  <Layers className="size-3.5 text-muted-foreground" />
                  {t("docEditor.primaryLayer")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-48 border-border bg-popover text-foreground">
                  {hasNote && (
                    <DropdownMenuItem
                      disabled={!hasDocument}
                      className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                      onSelect={() => onSetPrimaryLayer?.("editor")}
                    >
                      <FileText className="size-3.5 text-muted-foreground" />
                      <span className="flex-1">{t("docEditor.markdownEditor")}</span>
                      {effectivePrimaryLayer === "editor" && (
                        <Check className="size-3.5 text-primary" />
                      )}
                    </DropdownMenuItem>
                  )}
                  {hasDatabase && (
                    <DropdownMenuItem
                      disabled={!hasDocument}
                      className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                      onSelect={() => onSetPrimaryLayer?.("database")}
                    >
                      <Database className="size-3.5 text-muted-foreground" />
                      <span className="flex-1">{t("docEditor.databaseLayer")}</span>
                      {effectivePrimaryLayer === "database" && (
                        <Check className="size-3.5 text-primary" />
                      )}
                    </DropdownMenuItem>
                  )}
                  {hasCanvas && (
                    <DropdownMenuItem
                      disabled={!hasDocument}
                      className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                      onSelect={() => onSetPrimaryLayer?.("canvas")}
                    >
                      <LayoutGrid className="size-3.5 text-muted-foreground" />
                      <span className="flex-1">{t("docEditor.canvasLayer")}</span>
                      {effectivePrimaryLayer === "canvas" && (
                        <Check className="size-3.5 text-primary" />
                      )}
                    </DropdownMenuItem>
                  )}
                  {hasSketch && (
                    <DropdownMenuItem
                      disabled={!hasDocument}
                      className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                      onSelect={() => onSetPrimaryLayer?.("sketch")}
                    >
                      <PenLine className="size-3.5 text-muted-foreground" />
                      <span className="flex-1">{t("docEditor.sketchLayer")}</span>
                      {effectivePrimaryLayer === "sketch" && (
                        <Check className="size-3.5 text-primary" />
                      )}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}

            {totalLayersCount > 1 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white data-[state=open]:bg-accent">
                  <ArrowLeftRight className="size-3.5 text-muted-foreground" />
                  {t("docEditor.switchLayer")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-48 border-border bg-popover text-foreground">
                  {hasNote && (
                    <DropdownMenuItem
                      disabled={!hasDocument}
                      className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                      onSelect={() => onLayerChange?.("editor")}
                    >
                      <FileText className="size-3.5 text-muted-foreground" />
                      <span className="flex-1">{t("docEditor.markdownEditor")}</span>
                      {activeLayer === "editor" && <Check className="size-3.5 text-primary" />}
                    </DropdownMenuItem>
                  )}
                  {hasDatabase && (
                    <DropdownMenuItem
                      disabled={!hasDocument}
                      className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                      onSelect={() => onLayerChange?.("database")}
                    >
                      <Database className="size-3.5 text-muted-foreground" />
                      <span className="flex-1">{t("docEditor.databaseLayer")}</span>
                      {activeLayer === "database" && <Check className="size-3.5 text-primary" />}
                    </DropdownMenuItem>
                  )}
                  {hasCanvas && (
                    <DropdownMenuItem
                      disabled={!hasDocument}
                      className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                      onSelect={() => onLayerChange?.("canvas")}
                    >
                      <LayoutGrid className="size-3.5 text-muted-foreground" />
                      <span className="flex-1">{t("docEditor.canvasLayer")}</span>
                      {activeLayer === "canvas" && <Check className="size-3.5 text-primary" />}
                    </DropdownMenuItem>
                  )}
                  {hasSketch && (
                    <DropdownMenuItem
                      disabled={!hasDocument}
                      className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                      onSelect={() => onLayerChange?.("sketch")}
                    >
                      <PenLine className="size-3.5 text-muted-foreground" />
                      <span className="flex-1">{t("docEditor.sketchLayer")}</span>
                      {activeLayer === "sketch" && <Check className="size-3.5 text-primary" />}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}

            {hasAttachableLayers && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white data-[state=open]:bg-accent">
                  <Plus className="size-3.5 text-muted-foreground" />
                  {t("docEditor.addLayer")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-52 border-border bg-popover text-foreground">
                  {canAttachNote && (
                    <DropdownMenuItem
                      className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                      onSelect={() => onRequestAttachLayer("editor")}
                    >
                      <FileText className="size-3.5 text-muted-foreground" />
                      {t("docEditor.markdownEditor")}
                    </DropdownMenuItem>
                  )}
                  {canAttachDatabase && (
                    <DropdownMenuItem
                      className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                      onSelect={() => onRequestAttachLayer("database")}
                    >
                      <Database className="size-3.5 text-muted-foreground" />
                      {t("docEditor.databaseLayer")}
                    </DropdownMenuItem>
                  )}
                  {canAttachCanvas && (
                    <DropdownMenuItem
                      className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                      onSelect={() => onRequestAttachLayer("canvas")}
                    >
                      <LayoutGrid className="size-3.5 text-muted-foreground" />
                      {t("docEditor.canvasLayer")}
                    </DropdownMenuItem>
                  )}
                  {canAttachSketch && (
                    <DropdownMenuItem
                      className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                      onSelect={() => onRequestAttachLayer("sketch")}
                    >
                      <PenLine className="size-3.5 text-muted-foreground" />
                      {t("docEditor.sketchLayer")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}

            {totalLayersCount > 1 && detachableLayers.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white data-[state=open]:bg-accent">
                  <Unlink className="size-3.5 text-muted-foreground" />
                  {t("docEditor.removeLayer")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56 border-border bg-popover text-foreground">
                  {detachableLayers.map((layer, index) => (
                    <React.Fragment key={layer.kind}>
                      {index > 0 && <DropdownMenuSeparator className="bg-accent" />}
                      <DropdownMenuItem
                        className="flex items-center gap-2 text-[13px] text-red-400 focus:bg-accent focus:text-red-300"
                        onSelect={() => onDeleteLayer?.(layer.kind)}
                      >
                        <layer.Icon className="size-3.5 text-red-400" />
                        <span>{layer.deleteLabel}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                        onSelect={() => onUnlinkLayer?.(layer.kind)}
                      >
                        <layer.Icon className="size-3.5 text-muted-foreground" />
                        <span>{layer.detachLabel}</span>
                      </DropdownMenuItem>
                    </React.Fragment>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}

            <DropdownMenuSeparator className="bg-accent" />
          </>
        )}
        <DropdownMenuItem
          disabled={!hasDocument || !onToggleFavorite}
          className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
          onSelect={onToggleFavorite}
        >
          {isFavorite ? (
            <Star className="size-3.5 fill-current text-primary" />
          ) : (
            <Star className="size-3.5 text-muted-foreground" />
          )}
          {isFavorite ? t("tree.removeBookmark") : t("tree.addBookmark")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!hasDocument || !onOpenInNewTab}
          className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
          onSelect={onOpenInNewTab}
        >
          <SquareArrowOutUpRight className="size-3.5 text-muted-foreground" />
          {t("tree.openInNewTab")}
        </DropdownMenuItem>

        <DropdownMenuSeparator className="bg-accent" />

        <DropdownMenuItem
          className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
          onSelect={onRequestMove}
        >
          <FolderInput className="size-3.5 text-muted-foreground" />
          {t("docEditor.moveFile")}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
          onSelect={onRequestMerge}
        >
          <GitMerge className="size-3.5 text-muted-foreground" />
          {t("docEditor.mergeWith")}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white data-[state=open]:bg-accent">
            <Copy className="size-3.5 text-muted-foreground" />
            {t("docEditor.copyPath")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56 border-border bg-popover text-foreground">
            {(["app", "vault", "absolute"] as const).map((kind) => (
              <DropdownMenuItem
                key={kind}
                className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                onSelect={() => onCopyPath(kind)}
              >
                <Copy className="size-3.5 text-muted-foreground" />
                {t(`docEditor.copyPath_${kind}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {activeLayer === "editor" ? (
          <DropdownMenuItem
            disabled={!hasDocument}
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={onExportPdf}
          >
            <FileDown className="size-3.5 text-muted-foreground" />
            {t("docEditor.exportPdf")}
          </DropdownMenuItem>
        ) : activeLayer === "database" ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              disabled={!hasDocument}
              className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white data-[state=open]:bg-accent"
            >
              <FileDown className="size-3.5 text-muted-foreground" />
              {t("docEditor.export")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48 border-border bg-popover text-foreground">
              <DropdownMenuItem
                className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                onSelect={onExportCsv}
              >
                <FileDown className="size-3.5 text-muted-foreground" />
                {t("docEditor.exportCsv")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                onSelect={onExportSqlite}
              >
                <FileDown className="size-3.5 text-muted-foreground" />
                {t("docEditor.exportSqlite")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              disabled={!hasDocument}
              className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white data-[state=open]:bg-accent"
            >
              <FileDown className="size-3.5 text-muted-foreground" />
              {t("docEditor.export")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48 border-border bg-popover text-foreground">
              <DropdownMenuItem
                className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                onSelect={() => onExportImage?.("png")}
              >
                <FileDown className="size-3.5 text-muted-foreground" />
                {t("docEditor.exportPng")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                onSelect={() => onExportImage?.("jpg")}
              >
                <FileDown className="size-3.5 text-muted-foreground" />
                {t("docEditor.exportJpg")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        <DropdownMenuSeparator className="bg-accent" />

        <DropdownMenuItem
          disabled={!hasDocument || !onShowInExplorer}
          className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
          onSelect={onShowInExplorer}
        >
          <FolderOpen className="size-3.5 text-muted-foreground" />
          {t("tree.showInExplorer")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!hasDocument}
          className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
          onSelect={onRequestRename}
        >
          <PenLine className="size-3.5 text-muted-foreground" />
          {t("tree.rename")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!hasDocument || !onDeleteFile}
          className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
          onSelect={() => onDeleteFile?.("archive")}
        >
          <Archive className="size-3.5 text-muted-foreground" />
          {t("workspace.archive")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!hasDocument || !onDeleteFile}
          className="flex items-center gap-2 text-[13px] text-red-400 focus:bg-accent focus:text-red-300"
          onSelect={() => onDeleteFile?.()}
        >
          <Trash2 className="size-3.5" />
          {t("docEditor.deleteFile")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
