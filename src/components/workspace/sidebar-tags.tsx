"use client"

import * as React from "react"
import { ChevronRight, FileText, Hash, Loader2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"
import { MotionSpinner } from "@/lib/motion"
import { motionTransitions } from "@/lib/motion-config"
import type { TreeItem } from "./sidebar-tree"
import { extractObsidianTags } from "./markdown-tags"
import { isTauri, listTags } from "@/lib/storage"
import { PanelHeader, PanelSearch } from "./panels/panel-header"

interface TagEntry {
  tag: string
  files: Array<{ item: TreeItem; path: string }>
}

interface SidebarTagsProps {
  items: TreeItem[]
  onSelect: (id: string) => void
  readFile?: (path: string) => Promise<string>
  vault?: string | null
}

function flattenFiles(items: TreeItem[], parentPath = ""): Array<{ item: TreeItem; path: string }> {
  const result: Array<{ item: TreeItem; path: string }> = []
  for (const item of items) {
    const displayPath = parentPath ? `${parentPath} › ${item.name}` : item.name
    if (item.type === "file") result.push({ item, path: parentPath })
    if (item.children) result.push(...flattenFiles(item.children, displayPath))
  }
  return result
}

export function SidebarTags({ items, onSelect, readFile, vault }: SidebarTagsProps) {
  const { t } = useTranslation()
  const [tags, setTags] = React.useState<TagEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [openTags, setOpenTags] = React.useState<Set<string>>(new Set())
  const [query, setQuery] = React.useState("")
  React.useEffect(() => {
    if (!readFile) return
    const read = readFile
    let cancelled = false
    setLoading(true)

    const flat = flattenFiles(items)
    const itemById = new Map(flat.map(({ item, path }) => [item.id, { item, path }]))
    const tagMap = new Map<string, Array<{ item: TreeItem; path: string }>>()

    async function load() {
      if (vault && isTauri()) {
        const indexed = await listTags(vault)
        for (const entry of indexed) {
          for (const note of entry.notes) {
            const file = itemById.get(note.id)
            if (!file) continue
            if (!tagMap.has(entry.tag)) tagMap.set(entry.tag, [])
            tagMap.get(entry.tag)!.push(file)
          }
        }
      } else {
        await Promise.allSettled(
          flat.map(async ({ item, path }) => {
            try {
              const content = await read(item.id)
              for (const match of extractObsidianTags(content)) {
                if (!tagMap.has(match.normalized)) tagMap.set(match.normalized, [])
                const list = tagMap.get(match.normalized)!
                if (!list.some((entry) => entry.item.id === item.id)) list.push({ item, path })
              }
            } catch {
              /* skip */
            }
          }),
        )
      }

      // Parent tag queries include every descendant (`inbox` includes `inbox/to-read`).
      for (const [tag, files] of [...tagMap.entries()]) {
        const parts = tag.split("/")
        for (let depth = 1; depth < parts.length; depth++) {
          const parent = parts.slice(0, depth).join("/")
          if (!tagMap.has(parent)) tagMap.set(parent, [])
          const parentFiles = tagMap.get(parent)!
          for (const file of files) {
            if (!parentFiles.some((entry) => entry.item.id === file.item.id)) {
              parentFiles.push(file)
            }
          }
        }
      }

      if (cancelled) return
      const sorted = [...tagMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([tag, files]) => ({ tag, files }))
      setTags(sorted)
      setLoading(false)
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [items, readFile, vault])

  function toggleTag(tag: string) {
    setOpenTags((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
  }
  const visibleTags = React.useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return tags
    return tags.filter((entry) => entry.tag.toLocaleLowerCase().includes(normalized))
  }, [query, tags])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title={t("panels.tags")} />
      {tags.length > 0 && (
        <PanelSearch
          value={query}
          onChange={setQuery}
          ariaLabel={t("tagsPanel.search")}
          placeholder={t("tagsPanel.search")}
        />
      )}
      {loading ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <MotionSpinner>
            <Loader2 className="size-5 text-muted-foreground" />
          </MotionSpinner>
          <p className="text-[12px] text-muted-foreground">{t("tagsPanel.scanning")}</p>
        </div>
      ) : !readFile ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-[12px] text-muted-foreground">{t("tagsPanel.noAccess")}</p>
        </div>
      ) : tags.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <Hash className="size-8 text-muted-foreground" />
          <p className="text-[12px] text-muted-foreground">{t("tagsPanel.empty")}</p>
          <p className="text-[11px] text-muted-foreground">{t("tagsPanel.emptyHint")}</p>
        </div>
      ) : visibleTags.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <p className="text-[12px] text-muted-foreground">{t("tagsPanel.noResults")}</p>
          <p className="text-[11px] text-muted-foreground">{t("tagsPanel.noResultsHint")}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="flex flex-col gap-px px-4 pb-4">
            {visibleTags.map(({ tag, files }) => {
              const isOpen = openTags.has(tag)
              const parts = tag.split("/")
              const depth = parts.length - 1
              const label = parts[parts.length - 1]
              return (
                <div key={tag}>
                  <button
                    onClick={() => toggleTag(tag)}
                    className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left hover:bg-accent"
                    style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
                    title={`#${tag}`}
                  >
                    <motion.span
                      className="flex shrink-0 text-muted-foreground"
                      initial={false}
                      animate={{ rotate: isOpen ? 90 : 0 }}
                      transition={motionTransitions.default}
                    >
                      <ChevronRight className="size-3" />
                    </motion.span>
                    <Hash className="size-3.5 shrink-0 text-primary" />
                    <span className="flex-1 truncate text-[13px] text-foreground">{label}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {files.length}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="ml-4 flex flex-col gap-px">
                      {files.map(({ item, path }) => (
                        <button
                          key={item.id}
                          onClick={() => onSelect(item.id)}
                          className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-accent"
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
      )}
    </div>
  )
}
