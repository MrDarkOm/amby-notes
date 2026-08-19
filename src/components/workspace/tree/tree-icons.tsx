"use client"

import { BookOpenText, FileText, Folder, LayoutGrid, PanelsTopLeft, PenLine } from "lucide-react"

import { cn } from "@/lib/utils"
import { IconValue } from "../icon-value"
import { isRichIconValue } from "../icon-values"
import { isSuperNoteItem } from "../workspace-tree-utils"
import { KNOWN_ICONS, type TreeItem } from "./tree-types"

export function BrainIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 2V14" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 5C9.5 5 11 6 11 8C11 10 9.5 11 8 11" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

export function WorkspaceIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </svg>
  )
}

export function TreeIcon({ icon, className }: { icon?: string; className?: string }) {
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

export function TreeItemIcon({ item, className }: { item: TreeItem; className?: string }) {
  const icon =
    item.icon && item.icon !== "file"
      ? item.icon
      : isSuperNoteItem(item)
        ? "supernote"
        : item.type === "folder"
          ? "folder"
          : "file"
  return <TreeIcon icon={icon} className={className} />
}
