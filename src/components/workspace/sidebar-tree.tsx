"use client"

import * as React from "react"
import { ChevronRight, FileText, Folder, LayoutGrid, PenLine } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

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
}

interface TreeNodeProps {
  item: TreeItem
  level: number
  selectedId: string | null
  onSelect: (id: string) => void
}

// Custom brain/split circle icon matching the Figma design
function BrainIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 2V14" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 5C9.5 5 11 6 11 8C11 10 9.5 11 8 11" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

// Workspace icon (circle with hash)
function WorkspaceIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </svg>
  )
}

function getIcon(type: TreeItem["icon"], className?: string) {
  const iconClass = cn("size-4 shrink-0", className)
  switch (type) {
    case "folder":
      return <Folder className={iconClass} />
    case "workspace":
      return <WorkspaceIcon className={iconClass} />
    case "brain":
      return <BrainIcon className={iconClass} />
    case "canvas":
      return <LayoutGrid className={iconClass} />
    case "draft":
      return <PenLine className={iconClass} />
    default:
      return <FileText className={iconClass} />
  }
}

function TreeNode({ item, level, selectedId, onSelect }: TreeNodeProps) {
  const [isOpen, setIsOpen] = React.useState(true)
  const hasChildren = item.children && item.children.length > 0
  const isSelected = selectedId === item.id
  const paddingLeft = 6 + level * 12

  if (hasChildren) {
    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
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
            <span className="truncate">{item.name}</span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {item.children?.map((child) => (
            <TreeNode
              key={child.id}
              item={child}
              level={level + 1}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </CollapsibleContent>
      </Collapsible>
    )
  }

  return (
    <button
      onClick={() => onSelect(item.id)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[13px] transition-colors hover:bg-accent",
        isSelected && "bg-accent"
      )}
      style={{ paddingLeft: paddingLeft + 15 }}
    >
      {getIcon(item.icon || "file", "text-muted-foreground")}
      <span className="truncate">{item.name}</span>
    </button>
  )
}

export function SidebarTree({ items, selectedId, onSelect }: SidebarTreeProps) {
  return (
    <div className="flex flex-col gap-px">
      {items.map((item) => (
        <TreeNode
          key={item.id}
          item={item}
          level={0}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}
