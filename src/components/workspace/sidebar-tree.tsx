"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Bookmark,
  BookmarkCheck,
  ChevronRight,
  Database,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  PenLine,
  Smile,
  SquareArrowOutUpRight,
  Star,
} from "lucide-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "@/lib/utils"
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
  children?: TreeItem[]
}

const KNOWN_ICONS = new Set(["folder", "file", "workspace", "canvas", "draft", "brain"])
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
  onNewFolder?: (parentId: string | null) => void
  onNewCanvas?: (parentId: string | null) => void
  onAttachCanvas?: (id: string) => void
  onOpenInNewTab?: (id: string) => void
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
    case "workspace":
      return <WorkspaceIcon className={cls} />
    case "brain":
      return <BrainIcon className={cls} />
    case "canvas":
      return <LayoutGrid className={cls} />
    case "draft":
      return <PenLine className={cls} />
    default:
      return <FileText className={cls} />
  }
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
  onSelect: (id: string) => void
  onDelete?: (id: string) => void
  onNewFile?: (parentId: string | null) => void
  onNewFolder?: (parentId: string | null) => void
  onNewCanvas?: (parentId: string | null) => void
  onAttachCanvas?: (id: string) => void
  onOpenInNewTab?: (id: string) => void
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
    onSelect,
    onDelete,
    onNewFile,
    onNewFolder,
    onNewCanvas,
    onAttachCanvas,
    onOpenInNewTab,
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
        className="w-full min-w-0 rounded bg-accent px-1 text-[13px] text-foreground outline-none ring-1 ring-blue-500"
      />
    ) : (
      <span className="truncate">{item.name}</span>
    )

    const defaultIcon = item.type === "folder" ? "folder" : "file"

    const ctxItems = (
      <ContextMenuContent className="w-52 border-border bg-popover text-foreground">
        <ContextMenuItem
          className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
          onSelect={() =>
            onNewFile?.(item.type === "folder" || item.type === "file" ? item.id : null)
          }
        >
          <FileText className="size-3.5 text-muted-foreground" />
          {t("tree.newNote")}
        </ContextMenuItem>
        <ContextMenuItem
          className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
          onSelect={() => onNewFolder?.(item.type === "folder" ? item.id : null)}
        >
          <FolderPlus className="size-3.5 text-muted-foreground" />
          {t("tree.newFolder")}
        </ContextMenuItem>
        <ContextMenuItem
          className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
          onSelect={() =>
            onNewCanvas?.(item.type === "folder" || item.type === "file" ? item.id : null)
          }
        >
          <LayoutGrid className="size-3.5 text-muted-foreground" />
          {t("tree.newCanvas")}
        </ContextMenuItem>
        {item.type === "canvas" && onAttachCanvas && (
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => onAttachCanvas(item.id)}
          >
            <FileText className="size-3.5 text-muted-foreground" />
            {t("tree.attachToNote")}
          </ContextMenuItem>
        )}
        {item.type === "file" &&
          onAttachLayer &&
          (() => {
            const layers = linkedLayersByDoc?.[item.id]
            const canvasAvail = !layers?.canvas
            const dbAvail = !layers?.database
            if (!canvasAvail && !dbAvail) return null
            return (
              <>
                {canvasAvail && (
                  <ContextMenuItem
                    className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                    onSelect={() => setPendingAttach("canvas")}
                  >
                    <LayoutGrid className="size-3.5 text-muted-foreground" />
                    {t("tree.attachCanvas")}
                  </ContextMenuItem>
                )}
                {dbAvail && (
                  <ContextMenuItem
                    className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                    onSelect={() => setPendingAttach("database")}
                  >
                    <Database className="size-3.5 text-muted-foreground" />
                    {t("tree.attachDatabase")}
                  </ContextMenuItem>
                )}
              </>
            )
          })()}

        <ContextMenuSeparator className="bg-accent" />

        <ContextMenuSub>
          <ContextMenuSubTrigger className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white data-[state=open]:bg-accent">
            <Smile className="size-3.5 text-muted-foreground" />
            {t("tree.icon")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="border-border bg-popover p-0 shadow-xl">
            <EmojiPickerPanel
              onSelect={(emojiData) => onSetIcon?.(item.id, emojiData.native)}
              onClose={() => {}}
            />
            <div className="border-t border-border p-1">
              <ContextMenuItem
                onSelect={() => onSetIcon?.(item.id, defaultIcon)}
                className="text-[12px] text-muted-foreground focus:bg-accent focus:text-foreground"
              >
                {t("tree.resetIcon")}
              </ContextMenuItem>
            </div>
          </ContextMenuSubContent>
        </ContextMenuSub>

        {(item.type === "file" && onOpenInNewTab) || onOpenInExplorer ? (
          <>
            <ContextMenuSeparator className="bg-accent" />
            {item.type === "file" && onOpenInNewTab && (
              <ContextMenuItem
                className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                onSelect={() => onOpenInNewTab(item.id)}
              >
                <SquareArrowOutUpRight className="size-3.5 text-muted-foreground" />
                {t("tree.openInNewTab")}
              </ContextMenuItem>
            )}
            {onOpenInExplorer && (
              <ContextMenuItem
                className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                onSelect={() => onOpenInExplorer(item.path ?? item.id)}
              >
                <FolderOpen className="size-3.5 text-muted-foreground" />
                {t("tree.showInExplorer")}
              </ContextMenuItem>
            )}
          </>
        ) : null}

        <ContextMenuSeparator className="bg-accent" />

        {item.type === "file" && onToggleFavorite && (
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => onToggleFavorite(item.id)}
          >
            {favorites?.has(item.id) ? (
              <>
                <BookmarkCheck className="size-3.5 text-amber-400" />
                {t("tree.removeBookmark")}
              </>
            ) : (
              <>
                <Bookmark className="size-3.5 text-muted-foreground" />
                {t("tree.addBookmark")}
              </>
            )}
          </ContextMenuItem>
        )}

        <ContextMenuItem
          className="text-[13px] focus:bg-accent focus:text-white"
          onSelect={() => setTimeout(onStartEdit, 80)}
        >
          {t("tree.rename")}
        </ContextMenuItem>
        <ContextMenuItem
          className="text-[13px] text-red-400 focus:bg-accent focus:text-red-300"
          onSelect={() => onDelete?.(item.id)}
        >
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
      "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[13px] transition-colors hover:bg-accent",
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
            className={cn(isDragTarget && "rounded ring-1 ring-inset ring-blue-500 bg-blue-900/20")}
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
                    onPointerDown={handlePointerDown}
                    onClick={() => {
                      if (!isEditing) onSelect(item.id)
                    }}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    {getIcon(item.icon || "folder", "text-muted-foreground")}
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
              className={cn(
                isDragTarget && "rounded ring-1 ring-inset ring-blue-500 bg-blue-900/20",
              )}
            >
              <button
                onPointerDown={handlePointerDown}
                onClick={() => {
                  if (!isEditing) onSelect(item.id)
                }}
                className={buttonCls}
                style={{ paddingLeft: paddingLeft + 15 }}
                {...selectedAttr}
              >
                {getIcon(item.icon || "file", "text-muted-foreground")}
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
  onNewFolder,
  onNewCanvas,
  onAttachCanvas,
  onOpenInNewTab,
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
        className="h-full overflow-y-auto select-none"
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
                  onSelect={onSelect}
                  onDelete={onDelete}
                  onNewFile={onNewFile}
                  onNewFolder={onNewFolder}
                  onNewCanvas={onNewCanvas}
                  onAttachCanvas={onAttachCanvas}
                  onOpenInNewTab={onOpenInNewTab}
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
