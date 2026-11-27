"use client"

import * as React from "react"
import { ArrowDownUp, Check, ChevronRight, Hash, Loader2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MotionSpinner } from "@/lib/motion"
import type { TreeItem } from "./sidebar-tree"
import { extractObsidianTags } from "./markdown-tags"
import { isTauri, listTags } from "@/lib/storage"
import { PanelHeader, PanelSearch } from "./panels/panel-header"
import { useTagFocusStore } from "./tags/tag-focus-store"
import { buildTagTree, sortTagTree, type TagNode, type TagSort } from "./tags/tag-tree"
import { TreeItemIcon } from "./tree/tree-icons"
import { treeRowInsetStyle } from "./tree/tree-metrics"

type TagFileEntry = { item: TreeItem; path: string }

interface TagEntry {
  tag: string
  files: TagFileEntry[]
  /** The notes carrying exactly this tag, not one of its nested tags. */
  direct: TagFileEntry[]
}

const TAG_SORT_STORAGE_KEY = "amby:tags-sort"

function readTagSort(): TagSort {
  try {
    return localStorage.getItem(TAG_SORT_STORAGE_KEY) === "count" ? "count" : "name"
  } catch {
    return "name"
  }
}

const rowClassName =
  "amby-density-inline-padding-left amby-tree-row flex w-full items-center gap-1.5 rounded py-1 pr-[23px] text-left text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

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

      const directByTag = new Map([...tagMap.entries()].map(([tag, files]) => [tag, [...files]]))

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
        .map(([tag, files]) => ({ tag, files, direct: directByTag.get(tag) ?? [] }))
      setTags(sorted)
      setLoading(false)
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [items, readFile, vault])

  // A tag clicked elsewhere is searched for here and unfolded once the tags are known.
  const pendingFocus = useTagFocusStore((s) => s.pending)
  React.useEffect(() => {
    if (pendingFocus === null) return
    setQuery(pendingFocus)
    if (loading || tags.length === 0) return
    const wanted = pendingFocus.toLocaleLowerCase()
    const match = tags.find((entry) => entry.tag.toLocaleLowerCase() === wanted)
    if (match) setOpenTags((prev) => new Set(prev).add(match.tag))
    useTagFocusStore.getState().clear()
  }, [loading, pendingFocus, tags])

  function toggleTag(tag: string) {
    setOpenTags((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
  }
  const [sort, setSort] = React.useState<TagSort>(readTagSort)
  function chooseSort(next: TagSort) {
    setSort(next)
    try {
      localStorage.setItem(TAG_SORT_STORAGE_KEY, next)
    } catch {
      // The order is a convenience; the list works without remembering it.
    }
  }
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const roots = React.useMemo(() => sortTagTree(buildTagTree(tags), sort), [sort, tags])
  // A search lists the matching tags flat, each under its full name; otherwise tags nest.
  const searchResults = React.useMemo(() => {
    if (!normalizedQuery) return null
    const matches = tags.filter((entry) => entry.tag.toLocaleLowerCase().includes(normalizedQuery))
    return sortTagTree(
      matches.map((entry) => ({ ...entry, label: entry.tag, children: [] })),
      sort,
    )
  }, [normalizedQuery, sort, tags])
  const visibleRoots = searchResults ?? roots

  function renderNode(node: TagNode<TreeItem>, level: number): React.ReactNode {
    const isOpen = openTags.has(node.tag)
    return (
      <div key={node.tag}>
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={() => toggleTag(node.tag)}
          className={rowClassName}
          style={treeRowInsetStyle(level)}
          title={`#${node.tag}`}
        >
          <span className="amby-tree-folder-icon relative inline-flex size-4 shrink-0 items-center justify-center">
            <Hash className="amby-tree-main-icon size-4 text-muted-foreground" />
            <span className="amby-tree-folder-toggle absolute inset-0 flex items-center justify-center text-muted-foreground">
              <ChevronRight className={`size-3 transition ${isOpen ? "rotate-90" : ""}`} />
            </span>
          </span>
          <span className="min-w-0 flex-1 truncate text-foreground">{node.label}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{node.files.length}</span>
        </button>
        {isOpen && (
          <>
            {node.children.map((child) => renderNode(child, level + 1))}
            {node.direct.map(({ item, path }) => (
              <button
                type="button"
                key={item.id}
                onClick={() => onSelect(item.id)}
                className={rowClassName}
                style={treeRowInsetStyle(level + 1)}
                title={path ? `${path} › ${item.name}` : item.name}
              >
                <TreeItemIcon item={item} className="text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-foreground">{item.name}</span>
              </button>
            ))}
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title={t("panels.tags")}
        actions={
          tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:bg-accent hover:text-white"
                  title={t("tagsPanel.sortOrder")}
                  aria-label={t("tagsPanel.sortOrder")}
                >
                  <ArrowDownUp className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-56 border-border bg-popover text-foreground"
              >
                {(["name", "count"] as const).map((key) => (
                  <DropdownMenuItem
                    key={key}
                    className="relative pr-8 text-[13px] focus:bg-accent focus:text-white"
                    onSelect={() => chooseSort(key)}
                  >
                    {t(key === "name" ? "tagsPanel.sortName" : "tagsPanel.sortCount")}
                    {sort === key && <Check className="absolute right-2 size-3.5 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }
      />
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
      ) : visibleRoots.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <p className="text-[12px] text-muted-foreground">{t("tagsPanel.noResults")}</p>
          <p className="text-[11px] text-muted-foreground">{t("tagsPanel.noResultsHint")}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto pb-4">
          {visibleRoots.map((node) => renderNode(node, 0))}
        </div>
      )}
    </div>
  )
}
