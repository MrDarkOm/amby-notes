"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { FileText, Search } from "lucide-react"

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
import type { TreeItem } from "../sidebar-tree"
import { relativeToVault } from "./document-breadcrumbs-utils"
import type { EditorLayer } from "./use-document-view-mode"

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
                className="amby-inset-icon-input h-9 pl-8 text-xs"
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
