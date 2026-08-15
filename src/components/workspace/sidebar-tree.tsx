"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  AppWindow,
  Bookmark,
  BookmarkCheck,
  BookOpenText,
  ChevronRight,
  Copy,
  Database,
  FileText,
  Folder,
  FolderOpen,
  LayoutGrid,
  Paperclip,
  PenLine,
  Pencil,
  PanelsTopLeft,
  Smile,
  SquareArrowOutUpRight,
  Star,
  Trash2,
} from "lucide-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "@/lib/utils"
import { IconValue } from "./icon-value"
import { isRichIconValue } from "./icon-values"
import { EmojiPickerPanel } from "./tiptap/EmojiPickerPanel"
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
import { setTreeDragPayload, clearTreeDragPayload } from "@/lib/canvas-dnd"
import { isSuperNoteItem } from "./workspace-tree-utils"

type AttachableLayer = "canvas" | "database"
interface NodeLayers {
  canvas: boolean
  database: boolean
  sketch: boolean
}

export interface TreeItem {
  id: string
  path: string
  name: string
  type: "folder" | "file" | "canvas"
  icon?: string
  /** Filesystem timestamps in Unix seconds, used by the file-panel sorter. */
  created?: number
  modified?: number
  children?: TreeItem[]
}

const KNOWN_ICONS = new Set([
  "folder",
  "file",
  "supernote",
  "page",
  "workspace",
  "canvas",
  "draft",
  "brain",
])
const ROOT_DROP_TARGET = "__amby_root__"

interface PtrDrag {
  sourceId: string
  sourceName: string
  startX: number
  startY: number
  ghostX: number
  ghostY: number
  active: boolean
  targetId: string | null
}

export interface SidebarTreeProps {
  items: TreeItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  onRename?: (id: string, newName: string) => void
  onDelete?: (id: string) => void
  onNewFile?: (parentId: string | null) => void
  onAttachCanvas?: (id: string) => void
  onOpenInNewTab?: (id: string) => void
  onOpenInNewWindow?: (id: string) => void
  onCloneFile?: (id: string) => void
  onOpenInExplorer?: (id: string) => void
  onMoveItem?: (sourceId: string, targetId: string | null) => void
  onSetIcon?: (id: string, icon: string) => void
  triggerRenameId?: string | null
  folderResetKey?: number
  folderTargetOpen?: boolean
  favorites?: Set<string>
  onToggleFavorite?: (id: string) => void
  onAttachLayer?: (id: string, layer: AttachableLayer) => void
  linkedLayersByDoc?: Record<string, NodeLayers>
  /** Increment to scroll the currently selected item into view. */
  findActiveKey?: number
}

// ── Flat row descriptor produced by flattenVisible ────────────────────────────
type FlatRow = { item: TreeItem; level: number }

function flattenVisible(items: TreeItem[], closedIds: Set<string>, level = 0): FlatRow[] {
  const rows: FlatRow[] = []
  for (const item of items) {
    rows.push({ item, level })
    const hasChildren = (item.children && item.children.length > 0) || item.type === "folder"
    if (hasChildren && !closedIds.has(item.id) && item.children?.length) {
      for (const child of flattenVisible(item.children, closedIds, level + 1)) {
        rows.push(child)
      }
    }
  }
  return rows
}

// ── Utility icons ─────────────────────────────────────────────────────────────
function BrainIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 2V14" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 5C9.5 5 11 6 11 8C11 10 9.5 11 8 11" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function WorkspaceIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </svg>
  )
}

function getIcon(icon: string | undefined, className?: string) {
  const cls = cn("size-4 shrink-0", className)
  if (isRichIconValue(icon)) return <IconValue value={icon} className={cls} />
  if (icon && !KNOWN_ICONS.has(icon)) {
    return (
      <span className="size-4 shrink-0 text-[14px] leading-4 flex items-center justify-center">
        {icon}
      </span>
    )
  }
  switch (icon) {
    case "folder":
      return <Folder className={cls} />
    case "supernote":
      return <BookOpenText className={cls} />
    case "workspace":
      return <WorkspaceIcon className={cls} />
    case "brain":
      return <BrainIcon className={cls} />
    case "canvas":
      return <LayoutGrid className={cls} />
    case "draft":
      return <PenLine className={cls} />
    case "page":
      return <PanelsTopLeft className={cls} />
    default:
      return <FileText className={cls} />
  }
}

function itemIcon(item: TreeItem): string | undefined {
  if (item.icon && item.icon !== "file") return item.icon
  return isSuperNoteItem(item) ? "supernote" : item.type === "folder" ? "folder" : "file"
}

// ── TreeNode props ────────────────────────────────────────────────────────────
// Flat, single-row renderer — no children are rendered here.
// All folder open/close state and edit state live in SidebarTree above.
interface TreeNodeProps {
  item: TreeItem
  level: number
  // Folder open state (ignored for non-folders)
  isOpen: boolean
  onToggleOpen: () => void
  // Inline rename state
  isEditing: boolean
  onStartEdit: () => void
  onFinishEdit: (newName: string | null) => void
  // Shared tree state
  selectedId: string | null
  isKeyboardFocused: boolean
  onKeyboardFocus: (id: string) => void
  onSelect: (id: string) => void
  onDelete?: (id: string) => void
  onNewFile?: (parentId: string | null) => void
  onAttachCanvas?: (id: string) => void
  onOpenInNewTab?: (id: string) => void
  onOpenInNewWindow?: (id: string) => void
  onCloneFile?: (id: string) => void
  onOpenInExplorer?: (id: string) => void
  onSetIcon?: (id: string, icon: string) => void
  onPtrDragStart: (id: string, name: string, path: string, x: number, y: number) => void
  ptrDragSourceId: string | null
  ptrDragTargetId: string | null
  favorites?: Set<string>
  onToggleFavorite?: (id: string) => void
  onAttachLayer?: (id: string, layer: AttachableLayer) => void
  linkedLayersByDoc?: Record<string, NodeLayers>
}

const TreeNode = React.memo(
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
    const isDragTarget =
      ptrDragTargetId === item.id && (item.type === "folder" || item.type === "file")
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
        {item.type === "file" && onOpenInNewTab && (
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
          onSelect={() => onNewFile?.(item.type === "folder" ? item.id : null)}
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
            data-drag-target={item.type === "folder" || item.type === "file" ? item.id : undefined}
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
                    {getIcon(itemIcon(item), "text-muted-foreground")}
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
              data-drag-target={
                item.type === "folder" || item.type === "file" ? item.id : undefined
              }
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
                {getIcon(itemIcon(item), "text-muted-foreground")}
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
    prev.ptrDragSourceId === next.ptrDragSourceId &&
    prev.ptrDragTargetId === next.ptrDragTargetId &&
    prev.favorites === next.favorites &&
    prev.linkedLayersByDoc === next.linkedLayersByDoc,
)

// ── SidebarTree ───────────────────────────────────────────────────────────────
export function SidebarTree({
  items,
  selectedId,
  onSelect,
  onRename,
  onDelete,
  onNewFile,
  onAttachCanvas,
  onOpenInNewTab,
  onOpenInNewWindow,
  onCloneFile,
  onOpenInExplorer,
  onMoveItem,
  onSetIcon,
  triggerRenameId,
  folderResetKey,
  folderTargetOpen,
  favorites,
  onToggleFavorite,
  onAttachLayer,
  linkedLayersByDoc,
  findActiveKey,
}: SidebarTreeProps) {
  const { t } = useTranslation()
  // ── Folder open/close state ─────────────────────────────────────────────────
  // IDs in `closedIds` are collapsed; everything else is open (default = all open).
  const [closedIds, setClosedIds] = React.useState<Set<string>>(() => new Set())

  const toggleOpen = React.useCallback((id: string) => {
    setClosedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // ── Inline rename state ─────────────────────────────────────────────────────
  const [editingId, setEditingId] = React.useState<string | null>(null)

  // The tree uses roving tab focus: one item is reachable with Tab, then arrows
  // move through visible rows without making every file a separate tab stop.
  const [keyboardFocusId, setKeyboardFocusId] = React.useState<string | null>(selectedId)

  // ── Respond to external expand/collapse trigger ─────────────────────────────
  const prevFolderResetKeyRef = React.useRef<number | undefined>(undefined)
  React.useEffect(() => {
    if (folderResetKey === undefined || folderResetKey === prevFolderResetKeyRef.current) return
    prevFolderResetKeyRef.current = folderResetKey
    if (folderTargetOpen === false) {
      const ids = new Set<string>()
      function collect(list: TreeItem[]) {
        for (const it of list) {
          ids.add(it.id)
          if (it.children) collect(it.children)
        }
      }
      collect(items)
      setClosedIds(ids)
    } else {
      setClosedIds(new Set())
    }
  }, [folderResetKey, folderTargetOpen, items])

  // ── Respond to external rename trigger ─────────────────────────────────────
  React.useEffect(() => {
    if (!triggerRenameId) return
    const timer = setTimeout(() => setEditingId(triggerRenameId), 80)
    return () => clearTimeout(timer)
  }, [triggerRenameId])

  // ── Flat visible row list ───────────────────────────────────────────────────
  const flatRows = React.useMemo(() => flattenVisible(items, closedIds), [items, closedIds])

  // ── Virtualizer ─────────────────────────────────────────────────────────────
  const scrollRef = React.useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 29, // px per row (py-1 row ~28px + 1px gap)
    overscan: 6,
  })

  const focusRow = React.useCallback(
    (id: string) => {
      setKeyboardFocusId(id)
      const index = flatRows.findIndex((row) => row.item.id === id)
      if (index !== -1) virtualizer.scrollToIndex(index, { align: "auto" })
    },
    [flatRows, virtualizer],
  )

  React.useEffect(() => {
    if (!keyboardFocusId) return
    const index = flatRows.findIndex((row) => row.item.id === keyboardFocusId)
    if (index === -1) return
    virtualizer.scrollToIndex(index, { align: "auto" })
    const frame = requestAnimationFrame(() => {
      const row = Array.from(
        scrollRef.current?.querySelectorAll<HTMLElement>("[data-tree-item-id]") ?? [],
      ).find((element) => element.dataset.treeItemId === keyboardFocusId)
      row?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [flatRows, keyboardFocusId, virtualizer])

  const parentIdFor = React.useCallback(
    (id: string): string | null => {
      function findParent(list: TreeItem[], parentId: string | null): string | null | undefined {
        for (const item of list) {
          if (item.id === id) return parentId
          if (item.children) {
            const found = findParent(item.children, item.id)
            if (found !== undefined) return found
          }
        }
        return undefined
      }
      return findParent(items, null) ?? null
    },
    [items],
  )

  const handleTreeKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement
      if (target.closest("input, textarea, [contenteditable='true']")) return

      const focusedId = target.closest<HTMLElement>("[data-tree-item-id]")?.dataset.treeItemId
      const id = focusedId ?? keyboardFocusId ?? selectedId
      const index = id ? flatRows.findIndex((row) => row.item.id === id) : -1
      const current = index === -1 ? null : flatRows[index]
      const moveTo = (nextIndex: number) => {
        const row = flatRows[nextIndex]
        if (row) focusRow(row.item.id)
      }
      const openContextMenu = () => {
        const row =
          target.closest<HTMLElement>("[data-tree-item-id]") ??
          Array.from(
            scrollRef.current?.querySelectorAll<HTMLElement>("[data-tree-item-id]") ?? [],
          ).find((element) => element.dataset.treeItemId === id)
        if (!row) return
        const rect = row.getBoundingClientRect()
        row.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          }),
        )
      }

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault()
          moveTo(Math.min(index + 1, flatRows.length - 1))
          break
        case "ArrowUp":
          event.preventDefault()
          moveTo(Math.max(index - 1, 0))
          break
        case "Home":
          event.preventDefault()
          moveTo(0)
          break
        case "End":
          event.preventDefault()
          moveTo(flatRows.length - 1)
          break
        case "ArrowRight": {
          if (!current) break
          const hasChildren = current.item.type === "folder" || !!current.item.children?.length
          if (!hasChildren) break
          event.preventDefault()
          if (closedIds.has(current.item.id)) toggleOpen(current.item.id)
          else if (current.item.children?.[0]) focusRow(current.item.children[0].id)
          break
        }
        case "ArrowLeft": {
          if (!current) break
          event.preventDefault()
          if (
            !closedIds.has(current.item.id) &&
            (current.item.type === "folder" || current.item.children?.length)
          ) {
            toggleOpen(current.item.id)
          } else {
            const parentId = parentIdFor(current.item.id)
            if (parentId) focusRow(parentId)
          }
          break
        }
        case "Enter":
        case " ":
          if (!current) break
          event.preventDefault()
          onSelect(current.item.id)
          break
        case "F2":
          if (!current) break
          event.preventDefault()
          setEditingId(current.item.id)
          break
        case "ContextMenu":
          event.preventDefault()
          openContextMenu()
          break
        case "F10":
          if (!event.shiftKey) break
          event.preventDefault()
          openContextMenu()
          break
      }
    },
    [closedIds, flatRows, focusRow, keyboardFocusId, onSelect, parentIdFor, selectedId, toggleOpen],
  )

  // Scroll selected item into view when selection changes or "find active" fires.
  const prevSelectedIdRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (selectedId === prevSelectedIdRef.current) return
    prevSelectedIdRef.current = selectedId
    if (!selectedId) return
    const idx = flatRows.findIndex((r) => r.item.id === selectedId)
    if (idx !== -1) virtualizer.scrollToIndex(idx, { align: "auto" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const prevFindActiveKeyRef = React.useRef<number | undefined>(undefined)
  React.useEffect(() => {
    if (findActiveKey === undefined || findActiveKey === prevFindActiveKeyRef.current) return
    prevFindActiveKeyRef.current = findActiveKey
    if (!selectedId) return
    const idx = flatRows.findIndex((r) => r.item.id === selectedId)
    if (idx !== -1) virtualizer.scrollToIndex(idx, { align: "center" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findActiveKey])

  // ── Pointer drag-and-drop ───────────────────────────────────────────────────
  const [ptrDrag, setPtrDrag] = React.useState<PtrDrag | null>(null)
  const ptrDragRef = React.useRef<PtrDrag | null>(null)
  const onMoveItemRef = React.useRef(onMoveItem)
  const pointerDownRef = React.useRef<{
    id: string
    name: string
    path: string
    x: number
    y: number
  } | null>(null)

  React.useEffect(() => {
    ptrDragRef.current = ptrDrag
  }, [ptrDrag])
  React.useEffect(() => {
    onMoveItemRef.current = onMoveItem
  }, [onMoveItem])

  const onPtrDragStart = React.useCallback(
    (id: string, name: string, path: string, x: number, y: number) => {
      pointerDownRef.current = { id, name, path, x, y }
    },
    [],
  )

  React.useEffect(() => {
    function onMove(e: PointerEvent) {
      const pd = pointerDownRef.current
      const drag = ptrDragRef.current

      if (drag) {
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
        const targetEl = el?.closest("[data-drag-target]") as HTMLElement | null
        const candidate = targetEl?.getAttribute("data-drag-target") ?? null
        const validTarget =
          candidate === ROOT_DROP_TARGET
            ? ROOT_DROP_TARGET
            : candidate && candidate !== drag.sourceId && !candidate.startsWith(drag.sourceId + "/")
              ? candidate
              : null
        setPtrDrag((prev) =>
          prev ? { ...prev, ghostX: e.clientX, ghostY: e.clientY, targetId: validTarget } : null,
        )
        return
      }

      if (pd) {
        const dx = Math.abs(e.clientX - pd.x)
        const dy = Math.abs(e.clientY - pd.y)
        if (dx > 5 || dy > 5) {
          const { id: startId, name: startName, path: startPath } = pd
          pointerDownRef.current = null
          const suppress = (ev: MouseEvent) => {
            ev.stopPropagation()
            ev.preventDefault()
            document.removeEventListener("click", suppress, true)
          }
          document.addEventListener("click", suppress, true)
          setTreeDragPayload({ id: startId, name: startName, path: startPath })
          setPtrDrag({
            sourceId: startId,
            sourceName: startName,
            startX: pd.x,
            startY: pd.y,
            ghostX: e.clientX,
            ghostY: e.clientY,
            active: true,
            targetId: null,
          })
        }
      }
    }

    function onUp(_e: PointerEvent) {
      const drag = ptrDragRef.current
      pointerDownRef.current = null
      if (drag) {
        if (drag.targetId) {
          onMoveItemRef.current?.(
            drag.sourceId,
            drag.targetId === ROOT_DROP_TARGET ? null : drag.targetId,
          )
        }
        setPtrDrag(null)
      }
      setTimeout(() => clearTreeDragPayload(), 0)
    }

    document.addEventListener("pointermove", onMove)
    document.addEventListener("pointerup", onUp)
    return () => {
      document.removeEventListener("pointermove", onMove)
      document.removeEventListener("pointerup", onUp)
    }
  }, [])

  // ── Render ──────────────────────────────────────────────────────────────────
  const totalSize = virtualizer.getTotalSize()

  return (
    <>
      {/* Scroll container — owns the ref the virtualizer needs */}
      <div
        ref={scrollRef}
        data-drag-target={ROOT_DROP_TARGET}
        role="tree"
        aria-label={t("panels.files")}
        tabIndex={keyboardFocusId ? -1 : 0}
        onKeyDown={handleTreeKeyDown}
        className="h-full overflow-y-auto select-none focus:outline-none"
        style={{ cursor: ptrDrag ? "grabbing" : undefined }}
      >
        {/* Virtualized content — absolute-positioned rows inside a sized container */}
        <div style={{ height: totalSize, position: "relative", padding: "6px" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = flatRows[virtualRow.index]
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${virtualRow.start}px)`,
                  padding: "0 0 1px", // 1px gap between rows
                }}
              >
                <TreeNode
                  item={row.item}
                  level={row.level}
                  isOpen={!closedIds.has(row.item.id)}
                  onToggleOpen={() => toggleOpen(row.item.id)}
                  isEditing={editingId === row.item.id}
                  onStartEdit={() => setEditingId(row.item.id)}
                  onFinishEdit={(newName) => {
                    if (newName) onRename?.(row.item.id, newName)
                    setEditingId(null)
                  }}
                  selectedId={selectedId}
                  isKeyboardFocused={keyboardFocusId === row.item.id}
                  onKeyboardFocus={setKeyboardFocusId}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  onNewFile={onNewFile}
                  onAttachCanvas={onAttachCanvas}
                  onOpenInNewTab={onOpenInNewTab}
                  onOpenInNewWindow={onOpenInNewWindow}
                  onCloneFile={onCloneFile}
                  onOpenInExplorer={onOpenInExplorer}
                  onSetIcon={onSetIcon}
                  onPtrDragStart={onPtrDragStart}
                  ptrDragSourceId={ptrDrag?.sourceId ?? null}
                  ptrDragTargetId={ptrDrag?.targetId ?? null}
                  favorites={favorites}
                  onToggleFavorite={onToggleFavorite}
                  onAttachLayer={onAttachLayer}
                  linkedLayersByDoc={linkedLayersByDoc}
                />
              </div>
            )
          })}
        </div>

        {/* Root-level drop zone shown at the bottom of the list */}
        <div
          className={cn(
            "mx-1.5 mt-1 min-h-10 rounded border border-transparent",
            ptrDrag?.targetId === ROOT_DROP_TARGET && "border-blue-500 bg-blue-900/20",
          )}
        />
      </div>

      {/* Drag ghost */}
      {ptrDrag?.active && (
        <div
          style={{
            position: "fixed",
            left: ptrDrag.ghostX + 14,
            top: ptrDrag.ghostY + 10,
            pointerEvents: "none",
            zIndex: 9999,
          }}
          className="flex items-center gap-1.5 rounded bg-accent px-2 py-1 text-[12px] text-foreground shadow-xl ring-1 ring-border"
        >
          <FileText className="size-3.5 shrink-0" />
          <span className="max-w-32 truncate">{ptrDrag.sourceName}</span>
        </div>
      )}
    </>
  )
}
