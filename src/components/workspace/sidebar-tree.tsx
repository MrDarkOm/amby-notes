"use client"

import * as React from "react"
import { ChevronRight, FileText, Folder, LayoutGrid, PenLine } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

export interface TreeItem {
  id: string
  name: string
  type: "folder" | "file" | "canvas"
  icon?: "folder" | "file" | "workspace" | "canvas" | "draft" | "brain"
  children?: TreeItem[]
}

interface SidebarTreeProps {
  items: TreeItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  onRename?: (id: string, newName: string) => void
  onDelete?: (id: string) => void
  onNewFile?: (parentId: string | null) => void
}

interface TreeNodeProps {
  item: TreeItem
  level: number
  selectedId: string | null
  onSelect: (id: string) => void
  onRename?: (id: string, newName: string) => void
  onDelete?: (id: string) => void
  onNewFile?: (parentId: string | null) => void
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

function getIcon(type: TreeItem["icon"], className?: string) {
  const cls = cn("size-4 shrink-0", className)
  switch (type) {
    case "folder":    return <Folder className={cls} />
    case "workspace": return <WorkspaceIcon className={cls} />
    case "brain":     return <BrainIcon className={cls} />
    case "canvas":    return <LayoutGrid className={cls} />
    case "draft":     return <PenLine className={cls} />
    default:          return <FileText className={cls} />
  }
}

function TreeNode({ item, level, selectedId, onSelect, onRename, onDelete, onNewFile }: TreeNodeProps) {
  const [isOpen, setIsOpen] = React.useState(true)
  const [isEditing, setIsEditing] = React.useState(false)
  const [editValue, setEditValue] = React.useState(item.name)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const hasChildren = (item.children && item.children.length > 0) || item.type === "folder"
  const isSelected = selectedId === item.id
  const paddingLeft = 6 + level * 12

  React.useEffect(() => {
    if (isEditing) {
      setEditValue(item.name)
      setTimeout(() => inputRef.current?.select(), 0)
    }
  }, [isEditing, item.name])

  function commitRename() {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== item.name) onRename?.(item.id, trimmed)
    setIsEditing(false)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") commitRename()
    if (e.key === "Escape") setIsEditing(false)
    e.stopPropagation()
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
    <span className="truncate" onDoubleClick={() => setIsEditing(true)}>
      {item.name}
    </span>
  )

  const ctxMenu = (trigger: React.ReactNode) => (
    <ContextMenu>
      <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
      <ContextMenuContent className="w-44 border-zinc-800 bg-zinc-900 text-zinc-300">
        {item.type === "folder" && (
          <>
            <ContextMenuItem
              className="text-[13px] focus:bg-zinc-800 focus:text-white"
              onClick={() => onNewFile?.(item.id)}
            >
              New File Here
            </ContextMenuItem>
            <ContextMenuSeparator className="bg-zinc-800" />
          </>
        )}
        <ContextMenuItem
          className="text-[13px] focus:bg-zinc-800 focus:text-white"
          onClick={() => setIsEditing(true)}
        >
          Rename
        </ContextMenuItem>
        <ContextMenuItem
          className="text-[13px] text-red-400 focus:bg-zinc-800 focus:text-red-300"
          onClick={() => onDelete?.(item.id)}
        >
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )

  if (hasChildren) {
    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        {ctxMenu(
          <CollapsibleTrigger asChild>
            <button
              onClick={() => onSelect(item.id)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[13px] transition-colors hover:bg-accent",
                isSelected && "bg-accent"
              )}
              style={{ paddingLeft }}
            >
              <ChevronRight
                className={cn(
                  "size-3 shrink-0 text-muted-foreground transition-transform",
                  isOpen && "rotate-90"
                )}
              />
              {getIcon(item.icon || "folder", "text-muted-foreground")}
              {nameNode}
            </button>
          </CollapsibleTrigger>
        )}
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
            />
          ))}
        </CollapsibleContent>
      </Collapsible>
    )
  }

  return ctxMenu(
    <button
      onClick={() => onSelect(item.id)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[13px] transition-colors hover:bg-accent",
        isSelected && "bg-accent"
      )}
      style={{ paddingLeft: paddingLeft + 15 }}
    >
      {getIcon(item.icon || "file", "text-muted-foreground")}
      {nameNode}
    </button>
  )
}

export function SidebarTree({ items, selectedId, onSelect, onRename, onDelete, onNewFile }: SidebarTreeProps) {
  return (
    <div className="flex flex-col gap-px">
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
        />
      ))}
    </div>
  )
}
