"use client"

import * as React from "react"
import {
  ChevronRight, Database, FileText, Folder, FolderPlus,
  LayoutGrid, PenLine, Smile, SquareArrowOutUpRight,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  ContextMenu, ContextMenuContent, ContextMenuItem,
  ContextMenuSeparator, ContextMenuTrigger,
  ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
} from "@/components/ui/context-menu"

export interface TreeItem {
  id: string
  name: string
  type: "folder" | "file" | "canvas"
  icon?: string
  children?: TreeItem[]
}

const KNOWN_ICONS = new Set(["folder", "file", "workspace", "canvas", "draft", "brain"])

const EMOJI_LIST = [
  "📝","📄","📃","📋","📊","📈","📜","📌",
  "⭐","🔖","💡","🎯","🔥","💎","🚀","⚡",
  "😀","🤔","👍","❤️","🎉","✅","❌","⚠️",
  "🏠","🌍","🔧","📚","🎮","🎨","🎵","🎬",
  "🐛","🦋","🌸","🍀","🌙","☀️","🌈","🌊",
]

interface PtrDrag {
  sourceId: string
  sourceName: string
  startX: number
  startY: number
  ghostX: number
  ghostY: number
  active: boolean
  targetFolderId: string | null
}

interface SidebarTreeProps {
  items: TreeItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  onRename?: (id: string, newName: string) => void
  onDelete?: (id: string) => void
  onNewFile?: (parentId: string | null) => void
  onNewFolder?: (parentId: string | null) => void
  onOpenInNewTab?: (id: string) => void
  onMoveItem?: (sourceId: string, targetFolderId: string) => void
  onSetIcon?: (id: string, icon: string) => void
  triggerRenameId?: string | null
  folderResetKey?: number
  folderTargetOpen?: boolean
}

interface TreeNodeProps {
  item: TreeItem
  level: number
  selectedId: string | null
  onSelect: (id: string) => void
  onRename?: (id: string, newName: string) => void
  onDelete?: (id: string) => void
  onNewFile?: (parentId: string | null) => void
  onNewFolder?: (parentId: string | null) => void
  onOpenInNewTab?: (id: string) => void
  onSetIcon?: (id: string, icon: string) => void
  triggerRenameId?: string | null
  onPtrDragStart: (id: string, name: string, x: number, y: number) => void
  ptrDragSourceId: string | null
  ptrDragTargetId: string | null
  folderResetKey?: number
  folderTargetOpen?: boolean
}

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
    return <span className="size-4 shrink-0 text-[14px] leading-4 flex items-center justify-center">{icon}</span>
  }
  switch (icon) {
    case "folder":    return <Folder className={cls} />
    case "workspace": return <WorkspaceIcon className={cls} />
    case "brain":     return <BrainIcon className={cls} />
    case "canvas":    return <LayoutGrid className={cls} />
    case "draft":     return <PenLine className={cls} />
    default:          return <FileText className={cls} />
  }
}

function TreeNode({
  item, level, selectedId, onSelect, onRename, onDelete,
  onNewFile, onNewFolder, onOpenInNewTab, onSetIcon,
  triggerRenameId, onPtrDragStart, ptrDragSourceId, ptrDragTargetId,
  folderResetKey, folderTargetOpen,
}: TreeNodeProps) {
  const [isOpen, setIsOpen] = React.useState(true)
  const prevResetKey = React.useRef<number | undefined>(undefined)
  React.useEffect(() => {
    if (folderResetKey !== undefined && folderResetKey !== prevResetKey.current) {
      prevResetKey.current = folderResetKey
      if (item.type === "folder") setIsOpen(folderTargetOpen ?? true)
    }
  }, [folderResetKey, folderTargetOpen, item.type])
  const [isEditing, setIsEditing] = React.useState(false)
  const [editValue, setEditValue] = React.useState(item.name)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const hasChildren = (item.children && item.children.length > 0) || item.type === "folder"
  const isSelected = selectedId === item.id
  const isDragSource = ptrDragSourceId === item.id
  const isDragTarget = ptrDragTargetId === item.id && item.type === "folder"
  const paddingLeft = 6 + level * 12

  React.useEffect(() => {
    if (triggerRenameId === item.id) setTimeout(() => setIsEditing(true), 80)
  }, [triggerRenameId, item.id])

  React.useEffect(() => {
    if (isEditing) {
      setEditValue(item.name)
      setTimeout(() => { inputRef.current?.select(); inputRef.current?.focus() }, 0)
    }
  }, [isEditing, item.name])

  function commitRename() {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== item.name) onRename?.(item.id, trimmed)
    setIsEditing(false)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") commitRename()
    if (e.key === "Escape") { setEditValue(item.name); setIsEditing(false) }
    e.stopPropagation()
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || isEditing) return
    onPtrDragStart(item.id, item.name, e.clientX, e.clientY)
  }

  const nameNode = isEditing ? (
    <input
      ref={inputRef}
      value={editValue}
      onChange={e => setEditValue(e.target.value)}
      onBlur={commitRename}
      onKeyDown={handleKeyDown}
      onClick={e => e.stopPropagation()}
      className="w-full min-w-0 rounded bg-zinc-800 px-1 text-[13px] text-zinc-100 outline-none ring-1 ring-blue-500"
    />
  ) : (
    <span className="truncate">{item.name}</span>
  )

  const defaultIcon = item.type === "folder" ? "folder" : "file"

  const ctxItems = (
    <ContextMenuContent className="w-52 border-zinc-800 bg-black text-zinc-300">
      <ContextMenuItem
        className="flex items-center gap-2 text-[13px] focus:bg-zinc-800 focus:text-white"
        onSelect={() => onNewFile?.(item.type === "folder" ? item.id : null)}
      >
        <FileText className="size-3.5 text-zinc-500" />
        Новая заметка
      </ContextMenuItem>
      <ContextMenuItem
        className="flex items-center gap-2 text-[13px] focus:bg-zinc-800 focus:text-white"
        onSelect={() => onNewFolder?.(item.type === "folder" ? item.id : null)}
      >
        <FolderPlus className="size-3.5 text-zinc-500" />
        Новая папка
      </ContextMenuItem>
      <ContextMenuItem disabled className="flex items-center gap-2 text-[13px] text-zinc-600">
        <Database className="size-3.5" />
        База данных
        <span className="ml-auto text-[10px] text-zinc-700">Скоро</span>
      </ContextMenuItem>

      <ContextMenuSeparator className="bg-zinc-800" />

      <ContextMenuSub>
        <ContextMenuSubTrigger className="flex items-center gap-2 text-[13px] focus:bg-zinc-800 focus:text-white data-[state=open]:bg-zinc-800">
          <Smile className="size-3.5 text-zinc-500" />
          Иконка
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="border-zinc-800 bg-black p-1.5 shadow-xl">
          <div className="grid grid-cols-8 gap-px">
            {EMOJI_LIST.map(emoji => (
              <ContextMenuItem
                key={emoji}
                onSelect={() => onSetIcon?.(item.id, emoji)}
                className="flex size-7 items-center justify-center rounded p-0 text-[15px] focus:bg-zinc-700 cursor-pointer"
              >
                {emoji}
              </ContextMenuItem>
            ))}
          </div>
          <div className="mt-1 border-t border-zinc-800 pt-1">
            <ContextMenuItem
              onSelect={() => onSetIcon?.(item.id, defaultIcon)}
              className="text-[12px] text-zinc-400 focus:bg-zinc-800 focus:text-zinc-300"
            >
              Сбросить иконку
            </ContextMenuItem>
          </div>
        </ContextMenuSubContent>
      </ContextMenuSub>

      {item.type === "file" && onOpenInNewTab && (
        <>
          <ContextMenuSeparator className="bg-zinc-800" />
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-zinc-800 focus:text-white"
            onSelect={() => onOpenInNewTab(item.id)}
          >
            <SquareArrowOutUpRight className="size-3.5 text-zinc-500" />
            Открыть в новой вкладке
          </ContextMenuItem>
        </>
      )}

      <ContextMenuSeparator className="bg-zinc-800" />

      <ContextMenuItem
        className="text-[13px] focus:bg-zinc-800 focus:text-white"
        onSelect={() => setTimeout(() => setIsEditing(true), 80)}
      >
        Переименовать
      </ContextMenuItem>
      <ContextMenuItem
        className="text-[13px] text-red-400 focus:bg-zinc-800 focus:text-red-300"
        onSelect={() => onDelete?.(item.id)}
      >
        Удалить
      </ContextMenuItem>
    </ContextMenuContent>
  )

  const buttonCls = cn(
    "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[13px] transition-colors hover:bg-accent",
    isSelected && "bg-accent",
    isDragSource && "opacity-40",
  )
  const selectedAttr = isSelected ? { "data-tree-selected": "true" } : {}

  if (hasChildren) {
    return (
      <div
        data-drag-folder={item.type === "folder" ? item.id : undefined}
        className={cn(isDragTarget && "rounded ring-1 ring-inset ring-blue-500 bg-blue-900/20")}
      >
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <CollapsibleTrigger asChild>
                <button
                  onPointerDown={handlePointerDown}
                  onClick={() => { if (!isEditing) onSelect(item.id) }}
                  className={buttonCls}
                  style={{ paddingLeft }}
                  {...selectedAttr}
                >
                  <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                  {getIcon(item.icon || "folder", "text-muted-foreground")}
                  {nameNode}
                </button>
              </CollapsibleTrigger>
            </ContextMenuTrigger>
            {ctxItems}
          </ContextMenu>
          <CollapsibleContent>
            {item.children?.map(child => (
              <TreeNode
                key={child.id}
                item={child}
                level={level + 1}
                selectedId={selectedId}
                onSelect={onSelect}
                onRename={onRename}
                onDelete={onDelete}
                onNewFile={onNewFile}
                onNewFolder={onNewFolder}
                onOpenInNewTab={onOpenInNewTab}
                onSetIcon={onSetIcon}
                triggerRenameId={triggerRenameId}
                onPtrDragStart={onPtrDragStart}
                ptrDragSourceId={ptrDragSourceId}
                ptrDragTargetId={ptrDragTargetId}
                folderResetKey={folderResetKey}
                folderTargetOpen={folderTargetOpen}
              />
            ))}
          </CollapsibleContent>
        </Collapsible>
      </div>
    )
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onPointerDown={handlePointerDown}
          onClick={() => { if (!isEditing) onSelect(item.id) }}
          className={buttonCls}
          style={{ paddingLeft: paddingLeft + 15 }}
          {...selectedAttr}
        >
          {getIcon(item.icon || "file", "text-muted-foreground")}
          {nameNode}
        </button>
      </ContextMenuTrigger>
      {ctxItems}
    </ContextMenu>
  )
}

export function SidebarTree({
  items, selectedId, onSelect, onRename, onDelete,
  onNewFile, onNewFolder, onOpenInNewTab, onMoveItem, onSetIcon, triggerRenameId,
  folderResetKey, folderTargetOpen,
}: SidebarTreeProps) {
  const [ptrDrag, setPtrDrag] = React.useState<PtrDrag | null>(null)
  const ptrDragRef = React.useRef<PtrDrag | null>(null)
  const onMoveItemRef = React.useRef(onMoveItem)
  const pointerDownRef = React.useRef<{ id: string; name: string; x: number; y: number } | null>(null)

  React.useEffect(() => { ptrDragRef.current = ptrDrag }, [ptrDrag])
  React.useEffect(() => { onMoveItemRef.current = onMoveItem }, [onMoveItem])

  function onPtrDragStart(id: string, name: string, x: number, y: number) {
    pointerDownRef.current = { id, name, x, y }
  }

  React.useEffect(() => {
    function onMove(e: PointerEvent) {
      const pd = pointerDownRef.current
      const drag = ptrDragRef.current

      if (drag) {
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
        const folderEl = el?.closest('[data-drag-folder]') as HTMLElement | null
        const candidate = folderEl?.getAttribute('data-drag-folder') ?? null
        const validTarget = (candidate && candidate !== drag.sourceId && !candidate.startsWith(drag.sourceId + '/'))
          ? candidate : null
        setPtrDrag(prev => prev ? { ...prev, ghostX: e.clientX, ghostY: e.clientY, targetFolderId: validTarget } : null)
        return
      }

      if (pd) {
        const dx = Math.abs(e.clientX - pd.x)
        const dy = Math.abs(e.clientY - pd.y)
        if (dx > 5 || dy > 5) {
          const startId = pd.id
          const startName = pd.name
          pointerDownRef.current = null
          // suppress the click that fires after drag ends
          const suppress = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault(); document.removeEventListener('click', suppress, true) }
          document.addEventListener('click', suppress, true)
          setPtrDrag({ sourceId: startId, sourceName: startName, startX: pd.x, startY: pd.y, ghostX: e.clientX, ghostY: e.clientY, active: true, targetFolderId: null })
        }
      }
    }

    function onUp(_e: PointerEvent) {
      const drag = ptrDragRef.current
      pointerDownRef.current = null
      if (drag) {
        if (drag.targetFolderId) {
          onMoveItemRef.current?.(drag.sourceId, drag.targetFolderId)
        }
        setPtrDrag(null)
      }
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
  }, [])

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="flex flex-col gap-px select-none"
            style={{ cursor: ptrDrag ? 'grabbing' : undefined, minHeight: '100%' }}
          >
            {items.map(item => (
              <TreeNode
                key={item.id}
                item={item}
                level={0}
                selectedId={selectedId}
                onSelect={onSelect}
                onRename={onRename}
                onDelete={onDelete}
                onNewFile={onNewFile}
                onNewFolder={onNewFolder}
                onOpenInNewTab={onOpenInNewTab}
                onSetIcon={onSetIcon}
                triggerRenameId={triggerRenameId}
                onPtrDragStart={onPtrDragStart}
                ptrDragSourceId={ptrDrag?.sourceId ?? null}
                ptrDragTargetId={ptrDrag?.targetFolderId ?? null}
                folderResetKey={folderResetKey}
                folderTargetOpen={folderTargetOpen}
              />
            ))}
            <div style={{ minHeight: '100vh' }} />
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent className="w-52 border-zinc-800 bg-black text-zinc-300">
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-zinc-800 focus:text-white"
            onSelect={() => onNewFile?.(null)}
          >
            <FileText className="size-3.5 text-zinc-500" />
            Новая заметка
          </ContextMenuItem>
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-zinc-800 focus:text-white"
            onSelect={() => onNewFolder?.(null)}
          >
            <FolderPlus className="size-3.5 text-zinc-500" />
            Новая папка
          </ContextMenuItem>
          <ContextMenuItem disabled className="flex items-center gap-2 text-[13px] text-zinc-600">
            <Database className="size-3.5" />
            База данных
            <span className="ml-auto text-[10px] text-zinc-700">Скоро</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {ptrDrag?.active && (
        <div
          style={{ position: 'fixed', left: ptrDrag.ghostX + 14, top: ptrDrag.ghostY + 10, pointerEvents: 'none', zIndex: 9999 }}
          className="flex items-center gap-1.5 rounded bg-zinc-800 px-2 py-1 text-[12px] text-zinc-200 shadow-xl ring-1 ring-zinc-600"
        >
          <FileText className="size-3.5 shrink-0" />
          <span className="max-w-32 truncate">{ptrDrag.sourceName}</span>
        </div>
      )}
    </>
  )
}
