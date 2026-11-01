"use client"

import { ChevronRight } from "lucide-react"

import { treeRowInsetStyle } from "../tree/tree-metrics"

const headingClassName =
  "amby-density-inline-padding-left flex w-full items-center gap-1 py-1 pr-2 text-left text-[12px] font-medium text-muted-foreground"

/**
 * The heading of a section of a panel list (bookmarks, files, and later ones). Its text stands
 * where the tree's icons stand. With `onToggle` it folds the section, showing the arrow only
 * while it is hovered or focused.
 */
export function PanelSectionHeading({
  title,
  open,
  onToggle,
}: {
  title: string
  open?: boolean
  onToggle?: () => void
}) {
  if (!onToggle) {
    return (
      <div style={treeRowInsetStyle()} className={headingClassName}>
        {title}
      </div>
    )
  }
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      style={treeRowInsetStyle()}
      className={`${headingClassName} group rounded hover:text-foreground`}
    >
      <span>{title}</span>
      <ChevronRight
        className={`size-3 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100 ${
          open ? "rotate-90" : ""
        }`}
      />
    </button>
  )
}
