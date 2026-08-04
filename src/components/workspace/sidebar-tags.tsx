"use client"

import * as React from "react"
import { ChevronRight, FileText, Hash, Loader2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import type { TreeItem } from "./sidebar-tree"

interface TagEntry {
  tag: string
  files: Array<{ item: TreeItem; path: string }>
}

interface SidebarTagsProps {
  items: TreeItem[]
  onSelect: (id: string) => void
  readFile?: (path: string) => Promise<string>
}

const TAG_RE = /(?<=^|\s)#(\p{L}[\p{L}\p{N}_-]*)/gu

function flattenFiles(items: TreeItem[], parentPath = ""): Array<{ item: TreeItem; path: string }> {
  const result: Array<{ item: TreeItem; path: string }> = []
  for (const item of items) {
    const displayPath = parentPath ? `${parentPath} › ${item.name}` : item.name
    if (item.type === "file") result.push({ item, path: parentPath })
    if (item.children) result.push(...flattenFiles(item.children, displayPath))
  }
  return result
}

export function SidebarTags({ items, onSelect, readFile }: SidebarTagsProps) {
  const { t } = useTranslation()
  const [tags, setTags] = React.useState<TagEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [openTags, setOpenTags] = React.useState<Set<string>>(new Set())
  const loadedRef = React.useRef(false)

  React.useEffect(() => {
    if (loadedRef.current || !readFile) return
    loadedRef.current = true
    setLoading(true)

    const flat = flattenFiles(items)
    const tagMap = new Map<string, Array<{ item: TreeItem; path: string }>>()

    Promise.allSettled(
      flat.map(async ({ item, path }) => {
        try {
          const content = await readFile(item.id)
          const matches = [...content.matchAll(TAG_RE)]
          for (const m of matches) {
            const tag = m[1].toLowerCase()
            if (!tagMap.has(tag)) tagMap.set(tag, [])
            const list = tagMap.get(tag)!
            if (!list.some((e) => e.item.id === item.id)) list.push({ item, path })
          }
        } catch {
          /* skip */
        }
      }),
    ).then(() => {
      const sorted = [...tagMap.entries()]
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
        .map(([tag, files]) => ({ tag, files }))
      setTags(sorted)
      setLoading(false)
    })
  }, [items, readFile])

  function toggleTag(tag: string) {
    setOpenTags((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
  }

  if (loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <p className="text-[12px] text-muted-foreground">{t("tagsPanel.scanning")}</p>
      </div>
    )
  }

  if (!readFile) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center">
        <p className="text-[12px] text-muted-foreground">{t("tagsPanel.noAccess")}</p>
      </div>
    )
  }

  if (tags.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center px-4">
        <Hash className="size-8 text-muted-foreground" />
        <p className="text-[12px] text-muted-foreground">{t("tagsPanel.empty")}</p>
        <p className="text-[11px] text-muted-foreground">{t("tagsPanel.emptyHint")}</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex flex-col gap-px p-1.5">
        {tags.map(({ tag, files }) => {
          const isOpen = openTags.has(tag)
          return (
            <div key={tag}>
              <button
                onClick={() => toggleTag(tag)}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-accent"
              >
                <ChevronRight
                  className={cn(
                    "size-3 shrink-0 text-muted-foreground transition-transform",
                    isOpen && "rotate-90",
                  )}
                />
                <Hash className="size-3.5 shrink-0 text-primary" />
                <span className="flex-1 truncate text-[13px] text-foreground">{tag}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{files.length}</span>
              </button>
              {isOpen && (
                <div className="ml-4 flex flex-col gap-px">
                  {files.map(({ item, path }) => (
                    <button
                      key={item.id}
                      onClick={() => onSelect(item.id)}
                      className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left transition-colors hover:bg-accent"
                    >
                      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <p className="truncate text-[12px] text-foreground">{item.name}</p>
                        {path && (
                          <p className="truncate text-[10px] text-muted-foreground">{path}</p>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
