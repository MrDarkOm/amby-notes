"use client"

import {
  BookOpenText,
  FileText,
  Folder,
  LayoutGrid,
  PanelsTopLeft,
  PenLine,
  Star,
} from "lucide-react"

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
      <span className={cn(cls, "flex items-center justify-center text-[14px] leading-4")}>
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

export function FileStarIcon({
  className,
  Icon = FileText,
}: {
  className?: string
  Icon?: typeof FileText
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("relative inline-flex size-3.5 shrink-0 overflow-visible", className)}
    >
      <Icon className="size-3.5" />
      <Star className="absolute -bottom-0.5 -right-0.5 size-2.5 fill-current stroke-[2.25]" />
    </span>
  )
}

export function TreeItemStatusIcon({
  item,
  isFavorite,
  className,
  onActivate,
  label,
}: {
  item: TreeItem
  isFavorite: boolean
  className?: string
  onActivate?: () => void
  label?: string
}) {
  const isFavoriteNote = item.type === "file" && isFavorite
  const isInteractive = item.type === "file" && !!onActivate
  const isSuperNote = isSuperNoteItem(item)
  const Icon =
    item.type === "folder"
      ? Folder
      : item.type === "canvas"
        ? LayoutGrid
        : isSuperNote
          ? BookOpenText
          : FileText

  return (
    <span
      aria-hidden={isInteractive ? undefined : true}
      data-tree-file-status={
        item.type === "folder" ? "folder" : isFavoriteNote ? "favorite" : item.type
      }
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-label={isInteractive ? label : undefined}
      aria-pressed={isInteractive ? isFavoriteNote : undefined}
      title={isInteractive ? label : undefined}
      onClick={
        isInteractive
          ? (event) => {
              event.stopPropagation()
              onActivate?.()
            }
          : undefined
      }
      onKeyDown={
        isInteractive
          ? (event) => {
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              event.stopPropagation()
              onActivate?.()
            }
          : undefined
      }
      className={cn(
        "ml-auto inline-flex size-3.5 shrink-0",
        isFavoriteNote ? "text-primary" : "text-muted-foreground/40",
        isInteractive &&
          "cursor-pointer rounded-sm hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      {isFavoriteNote ? <FileStarIcon Icon={Icon} /> : <Icon className="size-3.5" />}
    </span>
  )
}
