"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"

import type { TreeItem } from "@/lib/storage"
import { TreeItemIcon, TreeItemStatusIcon } from "../tree/tree-icons"
import { treeRowInsetStyle } from "../tree/tree-metrics"
import { PanelSectionHeading } from "./panel-section"

const FAVORITES_SECTION_STORAGE_KEY = "amby:favorites-section-open"

function readOpen(): boolean {
  try {
    return localStorage.getItem(FAVORITES_SECTION_STORAGE_KEY) !== "false"
  } catch {
    return true
  }
}

/** Bookmarked notes pinned above the file tree; hidden while there are none. */
export function FavoritesSection({
  items,
  selectedId,
  onSelect,
  onToggleFavorite,
}: {
  items: TreeItem[]
  selectedId?: string | null
  onSelect: (id: string) => void
  onToggleFavorite?: (id: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(readOpen)
  if (items.length === 0) return null

  function toggle() {
    setOpen((current) => {
      try {
        localStorage.setItem(FAVORITES_SECTION_STORAGE_KEY, String(!current))
      } catch {
        // Remembering the fold is a convenience only.
      }
      return !current
    })
  }

  const rowStyle = treeRowInsetStyle()

  return (
    <div data-help-target="favorites" className="shrink-0 pb-3">
      <PanelSectionHeading title={t("panels.favorites")} open={open} onToggle={toggle} />
      {open && (
        <ul className="max-h-40 overflow-y-auto">
          {items.map((item) => (
            <li
              key={item.id}
              style={rowStyle}
              className={`amby-density-inline-padding-left amby-tree-row group mb-px flex cursor-pointer items-center gap-1.5 rounded py-1 pr-[23px] text-[13px] hover:bg-accent ${
                item.id === selectedId ? "bg-accent" : ""
              }`}
              onClick={() => onSelect(item.id)}
            >
              <TreeItemIcon item={item} className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-foreground">{item.name}</span>
              <button
                type="button"
                aria-label={t("favoritesPanel.removeBookmark")}
                title={t("favoritesPanel.removeBookmark")}
                onClick={(event) => {
                  event.stopPropagation()
                  onToggleFavorite?.(item.id)
                }}
              >
                <TreeItemStatusIcon item={item} isFavorite />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
