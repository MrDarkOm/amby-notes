"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Archive,
  AppWindow,
  Bookmark,
  BookmarkCheck,
  ChevronRight,
  Copy,
  Database,
  FileText,
  FolderOpen,
  LayoutGrid,
  Paperclip,
  Pencil,
  Smile,
  SquareArrowOutUpRight,
  Star,
  Trash2,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { EmojiPickerPanel } from "../tiptap/EmojiPickerPanel"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { TreeItemIcon } from "./tree-icons"
import type { AttachableLayer, TreeNodeProps } from "./tree-types"

export const TreeNode = React.memo(
  function TreeNode({
    item,
    level,
    isOpen,
    onToggleOpen,
    isEditing,
    onStartEdit,
    onFinishEdit,
    selectedId,
    isKeyboardFocused,
    onKeyboardFocus,
    onSelect,
    onDelete,
    onNewFile,
    onAttachCanvas,
    onOpenInNewTab,
    onOpenInNewWindow,
    onCloneFile,
    onOpenInExplorer,
    onSetIcon,
    onPtrDragStart,
    ptrDragSourceId,
    ptrDragTargetId,
    favorites,
    onToggleFavorite,
    onAttachLayer,
    linkedLayersByDoc,
  }: TreeNodeProps) {
    const { t } = useTranslation()
    const [pendingAttach, setPendingAttach] = React.useState<AttachableLayer | null>(null)
    const [editValue, setEditValue] = React.useState(item.name)
    const inputRef = React.useRef<HTMLInputElement>(null)

    const hasChildren = (item.children && item.children.length > 0) || item.type === "folder"
    const isSelected = selectedId === item.id
    const isDragSource = ptrDragSourceId === item.id
    const isDragTarget = ptrDragTargetId === item.id && item.type === "folder"
    // Indent: file leaves get an extra 15px offset (no chevron column)
    const paddingLeft = 6 + level * 12

    // Sync edit value and focus when entering edit mode
    React.useEffect(() => {
      if (isEditing) {
        setEditValue(item.name)
        setTimeout(() => {
          inputRef.current?.select()
          inputRef.current?.focus()
        }, 0)
      }
    }, [isEditing, item.name])

    function commitRename() {
      const trimmed = editValue.trim()
      onFinishEdit(trimmed && trimmed !== item.name ? trimmed : null)
    }

    function handleKeyDown(e: React.KeyboardEvent) {
      if (e.key === "Enter") commitRename()
      if (e.key === "Escape") onFinishEdit(null)
      e.stopPropagation()
    }

    function handlePointerDown(e: React.PointerEvent) {
      if (e.button !== 0 || isEditing) return
      onPtrDragStart(item.id, item.name, item.path ?? item.id, e.clientX, e.clientY)
    }

    const nameNode = isEditing ? (
      <input
        ref={inputRef}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={commitRename}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="w-full min-w-0 rounded bg-accent px-1 text-[13px] text-foreground outline-none ring-1 ring-ring"
      />
    ) : (
      <span className="truncate">{item.name}</span>
    )

    const defaultIcon = item.type === "folder" ? "folder" : "file"

    const layers = linkedLayersByDoc?.[item.id]
    const canvasAvailable = item.type === "file" && !layers?.canvas
    const databaseAvailable = item.type === "file" && !layers?.database
    const canAttach =
      (item.type === "canvas" && !!onAttachCanvas) ||
      (!!onAttachLayer && (canvasAvailable || databaseAvailable))

    const ctxItems = (
      <ContextMenuContent className="w-60 border-border bg-popover text-foreground">
        {/* Zone 1: actions affecting the selected file. */}
        {onOpenInNewTab && (
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => onOpenInNewTab(item.id)}
          >
            <SquareArrowOutUpRight className="size-3.5 text-muted-foreground" />
            {t("tree.openInNewTab")}
          </ContextMenuItem>
        )}
        {item.type === "file" && onOpenInNewWindow && (
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => onOpenInNewWindow(item.id)}
          >
            <AppWindow className="size-3.5 text-muted-foreground" />
            {t("tree.openInNewWindow")}
          </ContextMenuItem>
        )}
        {item.type === "file" && onCloneFile && (
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => onCloneFile(item.id)}
          >
            <Copy className="size-3.5 text-muted-foreground" />
            {t("tree.clone")}
          </ContextMenuItem>
        )}
        {canAttach && (
          <ContextMenuSub>
            <ContextMenuSubTrigger className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white data-[state=open]:bg-accent">
              <Paperclip className="size-3.5 text-muted-foreground" />
              {t("tree.attach")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-52 border-border bg-popover text-foreground">
              {item.type === "canvas" && onAttachCanvas && (
                <ContextMenuItem
                  className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                  onSelect={() => onAttachCanvas(item.id)}
                >
                  <FileText className="size-3.5 text-muted-foreground" />
                  {t("tree.attachToNote")}
                </ContextMenuItem>
              )}
              {canvasAvailable && (
                <ContextMenuItem
                  className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                  onSelect={() => setPendingAttach("canvas")}
                >
                  <LayoutGrid className="size-3.5 text-muted-foreground" />
                  {t("tree.attachCanvas")}
                </ContextMenuItem>
              )}
              {databaseAvailable && (
                <ContextMenuItem
                  className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                  onSelect={() => setPendingAttach("database")}
                >
                  <Database className="size-3.5 text-muted-foreground" />
                  {t("tree.attachDatabase")}
                </ContextMenuItem>
              )}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {item.type === "file" && onToggleFavorite && (
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => onToggleFavorite(item.id)}
          >
            {favorites?.has(item.id) ? (
              <BookmarkCheck className="size-3.5 text-amber-400" />
            ) : (
              <Bookmark className="size-3.5 text-muted-foreground" />
            )}
            {favorites?.has(item.id) ? t("tree.removeBookmark") : t("tree.addBookmark")}
          </ContextMenuItem>
        )}

        <ContextMenuSeparator className="bg-accent" />

        {/* Zone 2: visual appearance. */}
        <ContextMenuSub>
          <ContextMenuSubTrigger className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white data-[state=open]:bg-accent">
            <Smile className="size-3.5 text-muted-foreground" />
            {t("tree.fileAppearance")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-0 rounded-[10px] border-0 bg-transparent p-0 shadow-none">
            <EmojiPickerPanel
              onSelect={(emojiData) => onSetIcon?.(item.id, emojiData.native)}
              onClear={() => onSetIcon?.(item.id, defaultIcon)}
              clearLabel={t("tree.resetIcon")}
              onClose={() => {}}
            />
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSeparator className="bg-accent" />

        {/* Zone 3: creation. */}
        <ContextMenuItem
          className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
          onSelect={() => onNewFile?.(item.type === "canvas" ? null : item.id)}
        >
          <FileText className="size-3.5 text-muted-foreground" />
          {t("tree.newNote")}
        </ContextMenuItem>

        <ContextMenuSeparator className="bg-accent" />

        {/* Zone 4: filesystem operations. */}
        {onOpenInExplorer && (
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => onOpenInExplorer(item.path ?? item.id)}
          >
            <FolderOpen className="size-3.5 text-muted-foreground" />
            {t("tree.showInExplorer")}
          </ContextMenuItem>
        )}
        <ContextMenuItem
          className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
          onSelect={() => setTimeout(onStartEdit, 80)}
        >
          <Pencil className="size-3.5 text-muted-foreground" />
          {t("tree.rename")}
        </ContextMenuItem>
        <ContextMenuItem
          className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
          onSelect={() => onDelete?.(item.id)}
        >
          <Archive className="size-3.5 text-muted-foreground" />
          {t("tree.archive")}
        </ContextMenuItem>
        <ContextMenuItem
          className="flex items-center gap-2 text-[13px] text-red-400 focus:bg-accent focus:text-red-300"
          onSelect={() => onDelete?.(item.id)}
        >
          <Trash2 className="size-3.5" />
          {t("tree.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    )

    const attachDialog = (
      <Dialog
        open={pendingAttach !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAttach(null)
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="w-72 border-border bg-popover p-4 text-foreground sm:max-w-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              if (pendingAttach) {
                onAttachLayer?.(item.id, pendingAttach)
                setPendingAttach(null)
              }
            }
          }}
        >
          <p className="text-[13px] leading-snug">
            {pendingAttach === "canvas"
              ? t("tree.confirmAttachCanvas", { name: item.name })
              : t("tree.confirmAttachDatabase", { name: item.name })}
          </p>
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              className="rounded border border-border px-2.5 py-1 text-xs text-foreground hover:bg-card"
              onClick={() => setPendingAttach(null)}
            >
              {t("tree.cancel")}
            </button>
            <button
              type="button"
              autoFocus
              className="rounded bg-foreground px-2.5 py-1 text-xs font-medium text-background hover:bg-foreground/90"
              onClick={() => {
                if (pendingAttach) {
                  onAttachLayer?.(item.id, pendingAttach)
                  setPendingAttach(null)
                }
              }}
            >
              {t("tree.create")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    )

    const buttonCls = cn(
      "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[13px] transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      isSelected && "bg-accent",
      isDragSource && "opacity-40",
    )
    const selectedAttr = isSelected ? { "data-tree-selected": "true" } : {}

    // ── Folder / bundle-file row (has children) ─────────────────────────────────
    if (hasChildren) {
      return (
        <>
          <div
            data-drag-target={item.type === "folder" ? item.id : undefined}
            data-drag-target-path={item.type === "folder" ? item.path : undefined}
            className={cn(isDragTarget && "rounded bg-accent ring-1 ring-inset ring-ring")}
          >
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div className={buttonCls} style={{ paddingLeft }} {...selectedAttr}>
                  <button
                    type="button"
                    className="flex size-3 shrink-0 items-center justify-center text-muted-foreground"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleOpen()
                    }}
                    title={isOpen ? t("tree.collapse") : t("tree.expand")}
                  >
                    <ChevronRight
                      className={cn("size-3 transition-transform", isOpen && "rotate-90")}
                    />
                  </button>
                  <button
                    type="button"
                    data-tree-item-id={item.id}
                    role="treeitem"
                    aria-level={level + 1}
                    aria-expanded={isOpen}
                    aria-selected={isSelected}
                    tabIndex={isKeyboardFocused ? 0 : -1}
                    onFocus={() => onKeyboardFocus(item.id)}
                    onPointerDown={handlePointerDown}
                    onClick={() => {
                      if (!isEditing) onSelect(item.id)
                    }}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <TreeItemIcon item={item} className="text-muted-foreground" />
                    {nameNode}
                  </button>
                </div>
              </ContextMenuTrigger>
              {ctxItems}
            </ContextMenu>
          </div>
          {attachDialog}
        </>
      )
    }

    // ── Leaf file / canvas row ──────────────────────────────────────────────────
    return (
      <>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              data-drag-target={item.type === "folder" ? item.id : undefined}
              data-drag-target-path={item.type === "folder" ? item.path : undefined}
              className={cn(isDragTarget && "rounded bg-accent ring-1 ring-inset ring-ring")}
            >
              <button
                data-tree-item-id={item.id}
                role="treeitem"
                aria-level={level + 1}
                aria-selected={isSelected}
                tabIndex={isKeyboardFocused ? 0 : -1}
                onFocus={() => onKeyboardFocus(item.id)}
                onPointerDown={handlePointerDown}
                onClick={() => {
                  if (!isEditing) onSelect(item.id)
                }}
                className={buttonCls}
                style={{ paddingLeft: paddingLeft + 15 }}
                {...selectedAttr}
              >
                <TreeItemIcon item={item} className="text-muted-foreground" />
                {nameNode}
                {favorites?.has(item.id) && (
                  <Star className="ml-auto size-3 shrink-0 text-amber-400 fill-amber-400" />
                )}
              </button>
            </div>
          </ContextMenuTrigger>
          {ctxItems}
        </ContextMenu>
        {attachDialog}
      </>
    )
  },
  (prev, next) =>
    prev.item === next.item &&
    prev.selectedId === next.selectedId &&
    prev.isKeyboardFocused === next.isKeyboardFocused &&
    prev.isOpen === next.isOpen &&
    prev.isEditing === next.isEditing &&
    prev.onSelect === next.onSelect &&
    prev.onOpenInNewTab === next.onOpenInNewTab &&
    prev.ptrDragSourceId === next.ptrDragSourceId &&
    prev.ptrDragTargetId === next.ptrDragTargetId &&
    prev.favorites === next.favorites &&
    prev.linkedLayersByDoc === next.linkedLayersByDoc,
)
