"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  FileUp,
  Folder,
  FolderOpen,
  Paperclip,
  Search,
  X,
} from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { Chat, TreeItem } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { toRelativeVaultPath } from "../workspace-tree-utils"

interface OpenDoc {
  title?: string
}

interface FilteredNode {
  item: TreeItem
  children: FilteredNode[]
}

function isAttachable(item: TreeItem): boolean {
  return item.type === "folder" || item.type === "file"
}

function displayTitle(item: TreeItem, openDocs: Record<string, OpenDoc | undefined>): string {
  if (item.type === "file") return openDocs[item.id]?.title || item.name
  return item.name
}

function filterTree(
  items: TreeItem[],
  query: string,
  openDocs: Record<string, OpenDoc | undefined>,
): FilteredNode[] {
  const needle = query.trim().toLocaleLowerCase()
  const walk = (nodes: TreeItem[]): FilteredNode[] => {
    const out: FilteredNode[] = []
    for (const item of nodes) {
      if (!isAttachable(item)) continue
      if (item.type === "folder") {
        const children = walk(item.children ?? [])
        const selfMatch = !needle || item.name.toLocaleLowerCase().includes(needle)
        if (selfMatch || children.length > 0) {
          out.push({ item, children })
        }
      } else {
        const label = displayTitle(item, openDocs).toLocaleLowerCase()
        if (!needle || label.includes(needle) || item.name.toLocaleLowerCase().includes(needle)) {
          out.push({ item, children: [] })
        }
      }
    }
    return out
  }
  return walk(items)
}

/**
 * Paperclip menu inside the AI composer: lets the user attach either text files from disk
 * or notes/folders from the vault via a tree picker popup.
 */
export function AttachMenu({
  chat,
  treeItems,
  openDocs,
  vault,
  currentDoc,
  disabled,
  triggerClassName,
  onChangeChat,
  onAddCurrent,
  onPickFile,
  getPanel,
}: {
  chat: Chat | null
  treeItems: TreeItem[]
  openDocs: Record<string, OpenDoc | undefined>
  vault: string | null
  currentDoc: OpenDoc | null
  disabled: boolean
  triggerClassName: string
  onChangeChat: (next: Chat) => void
  onAddCurrent: () => void
  onPickFile: () => void
  getPanel: () => HTMLElement | null
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [view, setView] = React.useState<"menu" | "tree">("menu")
  const [query, setQuery] = React.useState("")
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set())
  const [box, setBox] = React.useState<{ width: number; alignOffset: number }>()
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (disabled && open) setOpen(false)
  }, [disabled, open])

  React.useEffect(() => {
    if (open && view === "tree") {
      // Focus the search field when entering the tree view.
      const frame = requestAnimationFrame(() => searchRef.current?.focus())
      return () => cancelAnimationFrame(frame)
    }
  }, [open, view])

  const measure = () => {
    const panel = getPanel()?.getBoundingClientRect()
    const own = triggerRef.current?.getBoundingClientRect()
    if (panel && own && panel.width > 0) {
      setBox({ width: panel.width, alignOffset: panel.left - own.left })
    } else {
      setBox(undefined)
    }
  }

  const handleOpenChange = (next: boolean) => {
    if (next) measure()
    setOpen(next)
    if (!next) {
      setView("menu")
      setQuery("")
    }
  }

  const openTree = () => {
    measure()
    setView("tree")
  }

  const isAttached = (item: TreeItem): boolean => {
    if (!chat) return false
    if (item.type === "folder") {
      const rel = toRelativeVaultPath(item.path, vault)
      return chat.context.some((entry) => entry.kind === "folder" && entry.id === rel)
    }
    return chat.context.some(
      (entry) => (entry.kind === "note" || entry.kind === "current") && entry.id === item.id,
    )
  }

  const toggleItem = (item: TreeItem) => {
    if (!chat) return
    if (item.type === "folder") {
      const rel = toRelativeVaultPath(item.path, vault)
      const exists = chat.context.some((entry) => entry.kind === "folder" && entry.id === rel)
      if (exists) {
        onChangeChat({
          ...chat,
          context: chat.context.filter((entry) => !(entry.kind === "folder" && entry.id === rel)),
        })
      } else {
        onChangeChat({
          ...chat,
          context: [...chat.context, { kind: "folder", id: rel }],
        })
      }
      return
    }
    const existing = chat.context.find(
      (entry) => (entry.kind === "note" || entry.kind === "current") && entry.id === item.id,
    )
    if (existing) {
      onChangeChat({
        ...chat,
        autoCurrent: existing.kind === "current" ? false : chat.autoCurrent,
        context: chat.context.filter((entry) => entry !== existing),
      })
    } else {
      onChangeChat({
        ...chat,
        context: [...chat.context, { kind: "note", id: item.id }],
      })
    }
  }

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const filtered = React.useMemo(
    () => filterTree(treeItems, query, openDocs),
    [treeItems, query, openDocs],
  )
  const filtering = query.trim().length > 0

  const renderNodes = (nodes: FilteredNode[], depth: number): React.ReactNode =>
    nodes.map(({ item, children }) => {
      const attached = isAttached(item)
      if (item.type === "folder") {
        const hasChildren = children.length > 0
        const isOpen = filtering ? hasChildren : expanded.has(item.id)
        const FolderIcon = isOpen ? FolderOpen : Folder
        return (
          <div key={item.id} role="none">
            <div
              className={cn(
                "flex min-h-7 items-center rounded-md pr-1.5 text-xs hover:bg-accent",
                attached && "bg-accent/60",
              )}
              style={{ paddingLeft: `${depth * 14 + 4}px` }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  aria-label={t(isOpen ? "ai.attach.collapseFolder" : "ai.attach.expandFolder")}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleExpand(item.id)
                  }}
                  className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                >
                  {isOpen ? (
                    <ChevronDown className="size-3.5" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="size-3.5" aria-hidden="true" />
                  )}
                </button>
              ) : (
                <span className="size-5 shrink-0" aria-hidden="true" />
              )}
              <button
                type="button"
                role="treeitem"
                aria-selected={attached}
                aria-expanded={hasChildren ? isOpen : undefined}
                onClick={() => toggleItem(item)}
                className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
              >
                <FolderIcon
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                {attached && (
                  <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                )}
              </button>
            </div>
            {hasChildren && isOpen && <div role="group">{renderNodes(children, depth + 1)}</div>}
          </div>
        )
      }

      const label = displayTitle(item, openDocs)
      return (
        <div
          key={item.id}
          role="none"
          className={cn(
            "flex min-h-7 items-center rounded-md pr-1.5 text-xs hover:bg-accent",
            attached && "bg-accent/60",
          )}
          style={{ paddingLeft: `${depth * 14 + 4}px` }}
        >
          <span className="size-5 shrink-0" aria-hidden="true" />
          <button
            type="button"
            role="treeitem"
            aria-selected={attached}
            onClick={() => toggleItem(item)}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
          >
            <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {attached && <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />}
          </button>
        </div>
      )
    })

  return (
    <Popover open={open && !disabled} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          title={t("ai.attach.label")}
          aria-label={t("ai.attach.label")}
          aria-haspopup="menu"
          aria-expanded={open && !disabled}
          className={triggerClassName}
        >
          <Paperclip className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        alignOffset={box?.alignOffset ?? 0}
        style={box ? { width: box.width } : undefined}
        className={cn("max-w-none rounded-xl p-1.5 shadow-md", !box && "w-72")}
      >
        {view === "menu" ? (
          <div role="menu" aria-label={t("ai.attach.label")} className="flex flex-col">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                handleOpenChange(false)
                onPickFile()
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-accent"
            >
              <FileUp className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{t("ai.attach.file")}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={openTree}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-accent"
            >
              <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{t("ai.attach.note")}</span>
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <div
              role="tree"
              aria-label={t("ai.attach.noteTree")}
              className="flex max-h-60 flex-col overflow-y-auto"
            >
              {filtered.length > 0 ? (
                renderNodes(filtered, 0)
              ) : (
                <p className="p-2 text-xs text-muted-foreground">{t("ai.noMentions")}</p>
              )}
            </div>
            {chat && !chat.autoCurrent && currentDoc && !filtering && (
              <>
                <div role="separator" className="mx-1 h-px bg-border" />
                <button
                  type="button"
                  onClick={onAddCurrent}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs hover:bg-accent"
                >
                  <FileText
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="truncate">{t("ai.addContext")}</span>
                </button>
              </>
            )}
            <div className="flex items-center gap-1 border-t border-border pt-1">
              <button
                type="button"
                aria-label={t("ai.attach.back")}
                title={t("ai.attach.back")}
                onClick={() => {
                  setView("menu")
                  setQuery("")
                }}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" />
              </button>
              <div className="relative flex min-w-0 flex-1 items-center">
                <Search
                  className="pointer-events-none absolute left-1.5 size-3 text-muted-foreground"
                  aria-hidden="true"
                />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("ai.attach.searchNotes")}
                  aria-label={t("ai.attach.searchNotes")}
                  className="h-6 w-full min-w-0 rounded-md bg-transparent pl-6 pr-5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
                />
                {query && (
                  <button
                    type="button"
                    aria-label={t("ai.attach.clearSearch")}
                    onClick={() => setQuery("")}
                    className="absolute right-1 flex size-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
