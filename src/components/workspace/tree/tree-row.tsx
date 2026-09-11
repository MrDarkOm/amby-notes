"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"
import {
  Archive,
  AppWindow,
  ChevronRight,
  Copy,
  Database,
  FileText,
  FolderOpen,
  LayoutGrid,
  Paperclip,
  Pencil,
  PenLine,
  Smile,
  SquareArrowOutUpRight,
  Star,
  Trash2,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { motionTransitions } from "@/lib/motion-config"
import { countFolderContents } from "../folder-view-utils"
import { EmojiPickerPanel } from "../tiptap/EmojiPickerPanel"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { TreeItemIcon, TreeItemStatusIcon } from "./tree-icons"
import { treeItemHasChildren, type AttachableLayer, type TreeNodeProps } from "./tree-types"

export const TreeNode = React.memo(
  function TreeNode({
    item,
    level,
    isOpen,
    onToggleOpen,
    isEditing,
    onStartEdit,
    onFinishEdit,
    selectedIds,
    isKeyboardFocused,
    onKeyboardFocus,
    onSelect,
    onDelete,
    onDeleteMany,
    onNewFile,
    onAttachCanvas,
    onOpenInNewTab,
    onOpenInNewWindow,
    onCloneFile,
    onOpenInExplorer,
    onSetIcon,
    onContextMenuSelect,
    onPtrDragStart,
    isPtrDragSource,
    isPtrDragTarget,
    favorites,
    onToggleFavorite,
    onAttachLayer,
    canCreateDatabaseLayer = false,
    linkedLayersByDoc,
  }: TreeNodeProps) {
    const { t } = useTranslation()
    const [pendingAttach, setPendingAttach] = React.useState<AttachableLayer | null>(null)
    const [editValue, setEditValue] = React.useState(item.name)
    const inputRef = React.useRef<HTMLInputElement>(null)
    const nameRef = React.useRef<HTMLSpanElement>(null)
    const [nameIsTruncated, setNameIsTruncated] = React.useState(false)

    const hasChildren = treeItemHasChildren(item)
    const isSelected = selectedIds.has(item.id)
    const contextSelectionIds = isSelected ? [...selectedIds] : [item.id]
    const isMultiSelection = contextSelectionIds.length > 1
    const isDragSource = isPtrDragSource
    const canReceiveDrop = item.type === "folder" || item.type === "file"
    const canReceiveMove = item.type === "folder" || hasChildren
    const isDragTarget = isPtrDragTarget && canReceiveDrop
    // Keep the tree content close to the panel edge while preserving one
    // icon-sized branch step per nested level. Expandable rows do not need a
    // separate chevron reservation because the chevron overlays the icon.
    const paddingLeft = 14 + level * 22

    // Sync edit value and focus when entering edit mode. Deferring focus until
    // the browser has completed the row update avoids a transient blur from
    // virtualization/context-menu event handlers.
    React.useEffect(() => {
      if (isEditing) {
        setEditValue(item.name)
        const timer = window.setTimeout(() => {
          inputRef.current?.focus()
          inputRef.current?.select()
        }, 0)
        return () => window.clearTimeout(timer)
      }
    }, [isEditing, item.name])

    React.useLayoutEffect(() => {
      if (isEditing) {
        setNameIsTruncated(false)
        return
      }
      const element = nameRef.current
      if (!element) return

      const measure = () => {
        const truncated = element.scrollWidth > element.clientWidth + 1
        setNameIsTruncated((current) => (current === truncated ? current : truncated))
      }

      measure()
      if (typeof ResizeObserver === "undefined") return
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      if (element.parentElement) observer.observe(element.parentElement)
      return () => observer.disconnect()
    }, [isEditing, item.name])

    function commitRename() {
      const trimmed = editValue.trim()
      onFinishEdit(item.id, trimmed && trimmed !== item.name ? trimmed : null)
    }

    function handleKeyDown(e: React.KeyboardEvent) {
      if (e.key === "Enter") commitRename()
      if (e.key === "Escape") onFinishEdit(item.id, null)
      e.stopPropagation()
    }

    function handlePointerDown(e: React.PointerEvent) {
      if (e.button !== 0 || isEditing) return
      onPtrDragStart(item.id, item.name, item.path ?? item.id, e.clientX, e.clientY)
    }

    function handleDoubleClick(e: React.MouseEvent) {
      if (isEditing) return
      e.preventDefault()
      e.stopPropagation()
      onStartEdit(item.id)
    }

    function handleContextMenu(e: React.MouseEvent) {
      e.stopPropagation()
      if (!isSelected) onContextMenuSelect?.(item.id)
    }

    const folderCounts =
      item.type === "folder" || hasChildren ? countFolderContents(item) : undefined
    const folderContentsTooltip = folderCounts
      ? t("tree.folderContents", {
          files: folderCounts.notes,
          folders: folderCounts.folders,
        })
      : undefined

    const nameNode = isEditing ? (
      <input
        ref={inputRef}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={commitRename}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="w-full min-w-0 rounded bg-accent p-0 text-[13px] leading-4 text-foreground outline-none ring-1 ring-inset ring-ring"
      />
    ) : (
      <span
        ref={nameRef}
        data-amby-tooltip={
          nameIsTruncated
            ? [item.name, folderContentsTooltip].filter(Boolean).join("\n")
            : undefined
        }
        className="min-w-0 flex-1 truncate"
      >
        {item.name}
      </span>
    )

    const isFavorite = favorites?.has(item.id) ?? false
    const statusNode = (
      <TreeItemStatusIcon
        item={item}
        isFavorite={isFavorite}
        onActivate={
          item.type === "file" && onToggleFavorite ? () => onToggleFavorite(item.id) : undefined
        }
        label={
          item.type === "file"
            ? isFavorite
              ? t("tree.removeBookmark")
              : t("tree.addBookmark")
            : undefined
        }
      />
    )

    const defaultIcon = item.type === "folder" ? "folder" : "file"
    const layers = linkedLayersByDoc?.[item.id]
    const canvasAvailable = item.type === "file" && !layers?.canvas
    const databaseAvailable = canCreateDatabaseLayer && item.type === "file" && !layers?.database
    const sketchAvailable = item.type === "file" && !layers?.sketch
    const canAttach =
      (item.type === "canvas" && !!onAttachCanvas) ||
      (!!onAttachLayer && (canvasAvailable || databaseAvailable || sketchAvailable))

    const ctxItems = (
      <ContextMenuContent className="w-60 border-border bg-popover text-foreground">
        {isMultiSelection && (
          <ContextMenuLabel className="text-xs text-muted-foreground">
            {t("tree.selectedCount", { count: contextSelectionIds.length })}
          </ContextMenuLabel>
        )}
        {/* Zone 1: actions affecting the selected file. */}
        {!isMultiSelection && onOpenInNewTab && (
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => onOpenInNewTab(item.id)}
          >
            <SquareArrowOutUpRight className="size-3.5 text-muted-foreground" />
            {t("tree.openInNewTab")}
          </ContextMenuItem>
        )}
        {!isMultiSelection && item.type === "file" && onOpenInNewWindow && (
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => onOpenInNewWindow(item.id)}
          >
            <AppWindow className="size-3.5 text-muted-foreground" />
            {t("tree.openInNewWindow")}
          </ContextMenuItem>
        )}
        {!isMultiSelection && item.type === "file" && onCloneFile && (
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => onCloneFile(item.id)}
          >
            <Copy className="size-3.5 text-muted-foreground" />
            {t("tree.clone")}
          </ContextMenuItem>
        )}
        {!isMultiSelection && canAttach && (
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
              {sketchAvailable && (
                <ContextMenuItem
                  className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                  onSelect={() => setPendingAttach("sketch")}
                >
                  <PenLine className="size-3.5 text-muted-foreground" />
                  {t("tree.attachSketch")}
                </ContextMenuItem>
              )}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {!isMultiSelection && item.type === "file" && onToggleFavorite && (
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => onToggleFavorite(item.id)}
          >
            {favorites?.has(item.id) ? (
              <Star className="size-3.5 fill-current text-primary" />
            ) : (
              <Star className="size-3.5 text-muted-foreground" />
            )}
            {favorites?.has(item.id) ? t("tree.removeBookmark") : t("tree.addBookmark")}
          </ContextMenuItem>
        )}

        {!isMultiSelection && <ContextMenuSeparator className="bg-accent" />}

        {/* Zone 2: visual appearance. */}
        {!isMultiSelection && (
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
        )}

        {!isMultiSelection && <ContextMenuSeparator className="bg-accent" />}

        {/* Zone 3: creation. */}
        {!isMultiSelection && (
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => {
              // Let Radix finish restoring focus after the context menu closes;
              // otherwise that restore can blur the rename input immediately.
              const parentId = item.type === "canvas" ? null : item.id
              window.setTimeout(() => void onNewFile?.(parentId), 80)
            }}
          >
            <FileText className="size-3.5 text-muted-foreground" />
            {t("tree.newNote")}
          </ContextMenuItem>
        )}

        {!isMultiSelection && <ContextMenuSeparator className="bg-accent" />}

        {/* Zone 4: filesystem operations. */}
        {!isMultiSelection && onOpenInExplorer && (
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => onOpenInExplorer(item.path ?? item.id)}
          >
            <FolderOpen className="size-3.5 text-muted-foreground" />
            {t("tree.showInExplorer")}
          </ContextMenuItem>
        )}
        {!isMultiSelection && (
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => setTimeout(() => onStartEdit(item.id), 80)}
          >
            <Pencil className="size-3.5 text-muted-foreground" />
            {t("tree.rename")}
          </ContextMenuItem>
        )}
        {isMultiSelection ? (
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] text-red-400 focus:bg-accent focus:text-red-300"
            onSelect={() => {
              if (onDeleteMany) onDeleteMany(contextSelectionIds)
              else onDelete?.(item.id)
            }}
          >
            <Trash2 className="size-3.5" />
            {t("tree.deleteSelected", { count: contextSelectionIds.length })}
          </ContextMenuItem>
        ) : (
          <>
            <ContextMenuItem
              className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
              onSelect={() => onDelete?.(item.id, "archive")}
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
          </>
        )}
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
              : pendingAttach === "database"
                ? t("tree.confirmAttachDatabase", { name: item.name })
                : t("tree.confirmAttachSketch", { name: item.name })}
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
      "amby-tree-row flex w-full items-center gap-1.5 rounded pl-0 py-1 pr-3 text-left text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      isSelected && "bg-accent",
      isDragSource && "opacity-40",
    )
    const selectedAttr = isSelected ? { "data-tree-selected": "true" } : {}
    const mainIconClassName = "amby-tree-main-icon text-muted-foreground"
    const folderIconNode = hasChildren ? (
      <span className="amby-tree-folder-icon relative inline-flex size-4 shrink-0 items-center justify-center">
        <TreeItemIcon item={item} className={mainIconClassName} />
        <button
          type="button"
          className="amby-tree-folder-toggle absolute inset-0 z-10 flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={isOpen ? t("tree.collapse") : t("tree.expand")}
          title={isOpen ? t("tree.collapse") : t("tree.expand")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onToggleOpen(item.id)
          }}
        >
          <motion.span
            className="flex"
            initial={false}
            animate={{ rotate: isOpen ? 90 : 0 }}
            transition={motionTransitions.default}
          >
            <ChevronRight className="size-3" />
          </motion.span>
        </button>
      </span>
    ) : null

    // ── Folder / bundle-file row (has children) ─────────────────────────────────
    if (hasChildren) {
      return (
        <>
          <div
            data-drag-target={canReceiveDrop ? item.id : undefined}
            data-drag-target-path={canReceiveDrop ? item.path : undefined}
            data-tree-reorder-target={item.id}
            data-tree-reorder-target-path={item.path}
            data-tree-move-target={canReceiveMove ? item.id : undefined}
            className={cn(isDragTarget && "rounded bg-accent ring-1 ring-inset ring-ring")}
          >
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  className={buttonCls}
                  style={{ paddingLeft }}
                  title={folderContentsTooltip}
                  onContextMenu={handleContextMenu}
                  onClick={(event) => {
                    // Keep clicks on the toggle and the item action button
                    // out of the row-level selection handler.
                    if (!isEditing && !(event.target as HTMLElement).closest("button")) {
                      onSelect(item.id, event)
                    }
                  }}
                  {...selectedAttr}
                >
                  {folderIconNode}
                  {isEditing ? (
                    <div
                      data-tree-item-id={item.id}
                      role="treeitem"
                      aria-level={level + 1}
                      aria-expanded={isOpen}
                      aria-selected={isSelected}
                      tabIndex={-1}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      {...selectedAttr}
                    >
                      {nameNode}
                      {statusNode}
                    </div>
                  ) : (
                    <button
                      type="button"
                      draggable={false}
                      data-tree-item-id={item.id}
                      role="treeitem"
                      aria-level={level + 1}
                      aria-expanded={isOpen}
                      aria-selected={isSelected}
                      tabIndex={isKeyboardFocused ? 0 : -1}
                      onFocus={() => onKeyboardFocus(item.id)}
                      onPointerDown={handlePointerDown}
                      onClick={(event) => onSelect(item.id, event)}
                      onDoubleClick={handleDoubleClick}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      {...selectedAttr}
                    >
                      {nameNode}
                      {statusNode}
                    </button>
                  )}
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
              data-drag-target={canReceiveDrop ? item.id : undefined}
              data-drag-target-path={canReceiveDrop ? item.path : undefined}
              data-tree-reorder-target={item.id}
              data-tree-reorder-target-path={item.path}
              data-tree-move-target={canReceiveMove ? item.id : undefined}
              className={cn(isDragTarget && "rounded bg-accent ring-1 ring-inset ring-ring")}
              title={folderContentsTooltip}
              onContextMenu={handleContextMenu}
            >
              {isEditing ? (
                <div
                  data-tree-item-id={item.id}
                  role="treeitem"
                  aria-level={level + 1}
                  aria-selected={isSelected}
                  tabIndex={-1}
                  className={buttonCls}
                  style={{ paddingLeft }}
                  {...selectedAttr}
                >
                  <TreeItemIcon item={item} className={mainIconClassName} />
                  {nameNode}
                  {statusNode}
                </div>
              ) : (
                <button
                  draggable={false}
                  data-tree-item-id={item.id}
                  role="treeitem"
                  aria-level={level + 1}
                  aria-selected={isSelected}
                  tabIndex={isKeyboardFocused ? 0 : -1}
                  onFocus={() => onKeyboardFocus(item.id)}
                  onPointerDown={handlePointerDown}
                  onClick={(event) => onSelect(item.id, event)}
                  onDoubleClick={handleDoubleClick}
                  className={buttonCls}
                  style={{ paddingLeft }}
                  {...selectedAttr}
                >
                  <TreeItemIcon item={item} className={mainIconClassName} />
                  {nameNode}
                  {statusNode}
                </button>
              )}
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
    prev.level === next.level &&
    prev.selectedIds === next.selectedIds &&
    prev.isKeyboardFocused === next.isKeyboardFocused &&
    prev.isOpen === next.isOpen &&
    prev.isEditing === next.isEditing &&
    prev.onToggleOpen === next.onToggleOpen &&
    prev.onStartEdit === next.onStartEdit &&
    prev.onFinishEdit === next.onFinishEdit &&
    prev.onSelect === next.onSelect &&
    prev.onDelete === next.onDelete &&
    prev.onDeleteMany === next.onDeleteMany &&
    prev.onNewFile === next.onNewFile &&
    prev.onAttachCanvas === next.onAttachCanvas &&
    prev.onOpenInNewTab === next.onOpenInNewTab &&
    prev.onOpenInNewWindow === next.onOpenInNewWindow &&
    prev.onCloneFile === next.onCloneFile &&
    prev.onOpenInExplorer === next.onOpenInExplorer &&
    prev.onSetIcon === next.onSetIcon &&
    prev.onContextMenuSelect === next.onContextMenuSelect &&
    prev.onPtrDragStart === next.onPtrDragStart &&
    prev.isPtrDragSource === next.isPtrDragSource &&
    prev.isPtrDragTarget === next.isPtrDragTarget &&
    prev.favorites === next.favorites &&
    prev.onToggleFavorite === next.onToggleFavorite &&
    prev.linkedLayersByDoc === next.linkedLayersByDoc &&
    prev.onAttachLayer === next.onAttachLayer &&
    prev.canCreateDatabaseLayer === next.canCreateDatabaseLayer,
)
