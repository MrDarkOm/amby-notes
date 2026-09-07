"use client"

import { Bookmark, BookmarkCheck, FileText } from "lucide-react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"

import { ScrollArea } from "@/components/ui/scroll-area"
import { motionTransitions } from "@/lib/motion-config"
import type { TreeItem } from "@/lib/storage"
import type { PanelRenderProps } from "../panel-registry"

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
  const all = flattenTreeItems(treeItems)
  const favItems = all.filter((i) => i.type === "file" && favorites?.has(i.id))

  if (favItems.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center px-4">
        <Bookmark className="size-8 text-muted-foreground" />
        <p className="text-[12px] text-muted-foreground">{t("favoritesPanel.empty")}</p>
        <p className="text-[11px] text-muted-foreground">{t("favoritesPanel.emptyHint")}</p>
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <div className="flex flex-col gap-px p-1">
        {favItems.map((item) => (
          <motion.div
            key={item.id}
            className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent cursor-pointer"
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
  )
}
