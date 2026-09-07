"use client"

import * as React from "react"
import { Bookmark, BookmarkCheck, FileText } from "lucide-react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"

import { ScrollArea } from "@/components/ui/scroll-area"
import { motionTransitions } from "@/lib/motion-config"
import type { TreeItem } from "@/lib/storage"
import type { PanelRenderProps } from "../panel-registry"
import { PanelHeader, PanelSearch } from "./panel-header"

function flattenTreeItems(items: TreeItem[]): TreeItem[] {
  const result: TreeItem[] = []
  function walk(list: TreeItem[]) {
    for (const item of list) {
      result.push(item)
      if (item.children) walk(item.children)
    }
  }
  walk(items)
  return result
}

export function FavoritesPanel({
  treeItems,
  favorites,
  onSelect,
  onToggleFavorite,
}: PanelRenderProps) {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState("")
  const all = flattenTreeItems(treeItems)
  const favItems = all.filter((i) => i.type === "file" && favorites?.has(i.id))
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleItems = favItems.filter((item) =>
    item.name.toLocaleLowerCase().includes(normalizedQuery),
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title={t("panels.favorites")} />
      {favItems.length > 0 && (
        <PanelSearch
          value={query}
          onChange={setQuery}
          ariaLabel={t("favoritesPanel.search")}
          placeholder={t("favoritesPanel.search")}
        />
      )}
      {favItems.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <Bookmark className="size-8 text-muted-foreground" />
          <p className="text-[12px] text-muted-foreground">{t("favoritesPanel.empty")}</p>
          <p className="text-[11px] text-muted-foreground">{t("favoritesPanel.emptyHint")}</p>
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center">
          <p className="text-[12px] text-muted-foreground">{t("favoritesPanel.noResults")}</p>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-px px-4 pb-4">
            {visibleItems.map((item) => (
              <motion.div
                key={item.id}
                className="group flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
                initial="rest"
                whileHover="hover"
                onClick={() => onSelect(item.id)}
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate text-[13px] text-foreground">{item.name}</span>
                <motion.button
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleFavorite?.(item.id)
                  }}
                  variants={{ rest: { opacity: 0 }, hover: { opacity: 1 } }}
                  whileFocus={{ opacity: 1 }}
                  transition={motionTransitions.fast}
                  title={t("favoritesPanel.removeBookmark")}
                >
                  <BookmarkCheck className="size-3.5 text-amber-400" />
                </motion.button>
              </motion.div>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
