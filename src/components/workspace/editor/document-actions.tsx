"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Archive,
  Bookmark,
  BookmarkCheck,
  Code2,
  Copy,
  Database,
  Eye,
  EyeOff,
  Files,
  FileText,
  FolderInput,
  FolderOpen,
  GitMerge,
  LayoutGrid,
  Link as LinkIcon,
  MoreVertical,
  PanelBottom,
  PanelTop,
  PenLine,
  Search,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
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

export type LayerKind = "canvas" | "database" | "sketch"

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
        <button
          type="button"
          title={title}
          onClick={onActivate}
          className={`flex size-7 items-center justify-center rounded-full transition-colors ${
            active
              ? "bg-accent text-foreground"
              : "bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
          }`}
        >
          {icon}
        </button>
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
              : t("docEditor.confirmCreateDatabase")}
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
                      "flex w-full items-center rounded-md px-3 py-2 text-left text-sm transition-colors",
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
  isLocked,
  viewMode,
  onViewModeChange,
  nestedNotes,
  nestedNotesPlacement,
  onNestedNotesPlacementChange,
  linkedLayers,
  canCreateDatabaseLayer = false,
  onRequestAttachLayer,
  isFavorite,
  onToggleFavorite,
  onOpenInNewTab,
  onRequestMove,
  onRequestMerge,
  onCopyPath,
  onShowInExplorer,
  onRequestRename,
  onDeleteFile,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  hasDocument: boolean
  activeLayer: EditorLayer
  isLocked: boolean
  viewMode: DocumentViewMode
  onViewModeChange: (mode: DocumentViewMode) => void
  nestedNotes: TreeItem[]
  nestedNotesPlacement: "top" | "bottom" | "hidden"
  onNestedNotesPlacementChange?: (placement: "top" | "bottom" | "hidden") => void
  linkedLayers?: { canvas: boolean; sketch: boolean; database: boolean }
  canCreateDatabaseLayer?: boolean
  onRequestAttachLayer: (layer: EditorLayer) => void
  isFavorite?: boolean
  onToggleFavorite?: () => void
  onOpenInNewTab?: () => void
  onRequestMove: () => void
  onRequestMerge: () => void
  onCopyPath: (kind: "app" | "vault" | "absolute") => void
  onShowInExplorer?: () => void
  onRequestRename: () => void
  onDeleteFile?: () => void
}) {
  const { t } = useTranslation()

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
        {(
          [
            ["live", PenLine, "docEditor.viewLive"],
            ["source", Code2, "docEditor.viewSource"],
            ["read", Eye, "docEditor.viewRead"],
          ] as const
        ).map(([mode, Icon, labelKey]) => (
          <DropdownMenuItem
            key={mode}
            disabled={!hasDocument || activeLayer !== "editor" || (mode === "live" && isLocked)}
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => onViewModeChange(mode)}
          >
            <Icon className="size-3.5 text-muted-foreground" />
            <span className="flex-1">{t(labelKey)}</span>
            {viewMode === mode && <span className="text-primary">✓</span>}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator className="bg-accent" />

        {nestedNotes.length > 0 && (
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

        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white data-[state=open]:bg-accent">
            <LinkIcon className="size-3.5 text-muted-foreground" />
            {t("docEditor.attach")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52 border-border bg-popover text-foreground">
            <DropdownMenuItem
              disabled={linkedLayers?.canvas}
              className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
              onSelect={() => onRequestAttachLayer("canvas")}
            >
              <LayoutGrid className="size-3.5 text-muted-foreground" />
              {t("docEditor.attachCanvas")}
            </DropdownMenuItem>
            {canCreateDatabaseLayer && (
              <DropdownMenuItem
                disabled={linkedLayers?.database}
                className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                onSelect={() => onRequestAttachLayer("database")}
              >
                <Database className="size-3.5 text-muted-foreground" />
                {t("docEditor.attachDatabase")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              disabled={linkedLayers?.sketch}
              className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
              onSelect={() => onRequestAttachLayer("sketch")}
            >
              <PenLine className="size-3.5 text-muted-foreground" />
              {t("docEditor.attachSketch")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem
          disabled={!hasDocument || !onToggleFavorite}
          className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
          onSelect={onToggleFavorite}
        >
          {isFavorite ? (
            <BookmarkCheck className="size-3.5 text-amber-400" />
          ) : (
            <Bookmark className="size-3.5 text-muted-foreground" />
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
          onSelect={onDeleteFile}
        >
          <Archive className="size-3.5 text-muted-foreground" />
          {t("workspace.archive")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!hasDocument || !onDeleteFile}
          className="flex items-center gap-2 text-[13px] text-red-400 focus:bg-accent focus:text-red-300"
          onSelect={onDeleteFile}
        >
          <Trash2 className="size-3.5" />
          {t("docEditor.deleteFile")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
