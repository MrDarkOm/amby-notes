"use client"

import * as React from "react"
import { Check, ChevronDown, Folder, Hash, Plus, Search, X } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { motionTransition } from "@/lib/motion-config"
import { cn } from "@/lib/utils"
import type { SearchResult as StorageSearchResult } from "@/lib/storage"
import type { TreeItem } from "./sidebar-tree"
import { TreeItemIcon } from "./tree/tree-icons"
import { caseInsensitiveRange } from "./search-text"
import { isInSearchScope, type SearchScope } from "./search-scope"
import { rankQuickOpenFiles } from "./quick-open-utils"
import { spotlightResizeTransition } from "./spotlight-motion"

interface SearchResult {
  item: TreeItem
  path: string
  /** `item` comes from the names in the tree; the others from the search index. */
  matchType: "item" | "name" | "content" | "tag"
  snippet?: string
}

/** Something else the window can create, shown as an icon next to "Create a new note". */
export interface SpotlightCreateAction {
  id: string
  label: string
  icon: LucideIcon
  run: () => void
}

/** What a search is narrowed to; `tag` searches tags instead of names and text. */
type SearchKind = "all" | "file" | "folder" | "database" | "canvas" | "sketch" | "tag"
const KINDS: SearchKind[] = ["all", "file", "folder", "database", "canvas", "sketch", "tag"]

interface SidebarSearchProps {
  items: TreeItem[]
  onSelect: (id: string) => void
  searchNotes?: (query: string) => Promise<StorageSearchResult[]>
  vault?: string | null
  /** Folders around the place search was opened from, nearest first, offered as "where". */
  scopes?: SearchScope[]
  /** The folders at the top of the vault, also offered as "where". */
  folderScopes?: SearchScope[]
  /** Shown in "Everywhere in …", so the vault is not mistaken for a folder of the same name. */
  vaultName?: string
  /**
   * Given when the window was opened to open a file (a new tab, Quick Open): the files are
   * listed before anything is typed, and the last row creates a note.
   */
  onCreateNote?: () => void
  createActions?: SpotlightCreateAction[]
}

/** Names matched in the tree, shown first and without waiting for the index. */
const NAME_MATCH_LIMIT = 50
/** Items listed before anything is typed when the window was opened to open a file. */
const BROWSE_LIMIT = 100

function flattenTree(items: TreeItem[], parentPath = ""): Array<{ item: TreeItem; path: string }> {
  const result: Array<{ item: TreeItem; path: string }> = []
  for (const item of items) {
    result.push({ item, path: parentPath })
    if (item.children) {
      const displayPath = parentPath ? `${parentPath} › ${item.name}` : item.name
      result.push(...flattenTree(item.children, displayPath))
    }
  }
  return result
}

function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text
  const range = caseInsensitiveRange(text, query)
  if (!range) return text
  const [start, end] = range
  return (
    <>
      {text.slice(0, start)}
      <mark className="bg-transparent font-semibold text-primary">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  )
}

/** Follows an element's height so the window can grow and shrink smoothly with its content. */
function useContentHeight(ref: React.RefObject<HTMLElement | null>) {
  const [height, setHeight] = React.useState(0)
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    setHeight(element.offsetHeight)
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return height
}

/** Spotlight-style search: one bar, with everything that matches growing under it. */
export function SidebarSearch({
  items,
  onSelect,
  searchNotes,
  vault,
  scopes = [],
  folderScopes = [],
  vaultName,
  onCreateNote,
  createActions = [],
}: SidebarSearchProps) {
  const { t } = useTranslation()
  const browsing = Boolean(onCreateNote)
  const [query, setQuery] = React.useState("")
  const [kind, setKind] = React.useState<SearchKind>("all")
  const [scopeId, setScopeId] = React.useState<string | null>(null)
  const allScopes = React.useMemo(() => [...scopes, ...folderScopes], [scopes, folderScopes])
  const activeScope = allScopes.find((scope) => scope.id === scopeId) ?? null
  const [indexResults, setIndexResults] = React.useState<SearchResult[]>([])
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const [searching, setSearching] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestRef = React.useRef(0)
  const listRef = React.useRef<HTMLDivElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const panelHeight = useContentHeight(panelRef)
  // Enter pressed before anything matched the current query opens the top result once the
  // index answers.
  const openFirstWhenReadyRef = React.useRef(false)
  const onSelectRef = React.useRef(onSelect)
  onSelectRef.current = onSelect

  const typed = query.trim()
  const tagSearch = kind === "tag" || typed.startsWith("#")
  // What goes to the index: the tag filter searches tags even without a typed "#".
  const indexQuery = kind === "tag" && typed && !typed.startsWith("#") ? `#${typed}` : typed
  const nameQuery = typed.startsWith("#") ? "" : typed

  const entries = React.useMemo(() => {
    const all = flattenTree(items)
    return activeScope ? all.filter((entry) => isInSearchScope(activeScope, entry.item)) : all
  }, [items, activeScope])

  // Kinds that have something to find; "all" and tags are always offered.
  const kinds = React.useMemo(() => {
    const present = new Set(entries.map((entry) => entry.item.type))
    return KINDS.filter((k) => k === "all" || k === "tag" || present.has(k))
  }, [entries])

  const nameResults = React.useMemo<SearchResult[]>(() => {
    if (tagSearch || (!nameQuery && !browsing)) return []
    const wanted = entries.filter((entry) =>
      kind === "all"
        ? // Before anything is typed folders would crowd out what is opened.
          nameQuery || entry.item.type !== "folder"
        : entry.item.type === kind,
    )
    const pathById = new Map(wanted.map((entry) => [entry.item.id, entry.path]))
    return rankQuickOpenFiles(
      wanted.map((entry) => entry.item),
      nameQuery,
      vault,
      nameQuery ? NAME_MATCH_LIMIT : BROWSE_LIMIT,
    ).map((item) => ({ item, path: pathById.get(item.id) ?? "", matchType: "item" }))
  }, [entries, nameQuery, tagSearch, browsing, kind, vault])

  // Index matches add what the names missed: titles matched word by word, then text and tags.
  // The index holds notes only, so it is skipped for the other kinds.
  const indexWanted = kind === "all" || kind === "file" || kind === "tag"
  const { nameGroup, textGroup } = React.useMemo(() => {
    const shown = new Set(nameResults.map((result) => result.item.id))
    const extra = indexWanted ? indexResults.filter((result) => !shown.has(result.item.id)) : []
    return {
      nameGroup: [...nameResults, ...extra.filter((result) => result.matchType === "name")],
      textGroup: extra.filter((result) => result.matchType !== "name"),
    }
  }, [nameResults, indexResults, indexWanted])
  const results = React.useMemo(() => [...nameGroup, ...textGroup], [nameGroup, textGroup])
  const createIndex = browsing ? results.length : -1
  const lastIndex = browsing ? results.length : results.length - 1

  React.useEffect(() => {
    setSelectedIndex(0)
  }, [typed, kind, scopeId])

  React.useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const request = ++requestRef.current
    openFirstWhenReadyRef.current = false
    if (!indexWanted || !indexQuery || indexQuery === "#" || !searchNotes) {
      setIndexResults([])
      setSearching(false)
      return
    }

    const byId = new Map(flattenTree(items).map((entry) => [entry.item.id, entry]))
    // The previous matches stay on screen until these arrive, so the window does not
    // collapse and grow again on every keystroke.
    setSearching(true)
    debounceRef.current = setTimeout(async () => {
      try {
        const matches = await searchNotes(indexQuery)
        if (request !== requestRef.current) return
        const next = matches
          .filter((match) => !activeScope || isInSearchScope(activeScope, match.note))
          .map((match): SearchResult => {
            const entry = byId.get(match.note.id)
            return {
              item: entry?.item ?? {
                id: match.note.id,
                path: match.note.path,
                name: match.note.title,
                type: "file" as const,
              },
              path: entry?.path ?? "",
              matchType: match.matchType,
              snippet: match.snippet,
            }
          })
        setIndexResults(next)
        if (openFirstWhenReadyRef.current && next[0]) onSelectRef.current(next[0].item.id)
      } finally {
        if (request === requestRef.current) {
          setSearching(false)
          openFirstWhenReadyRef.current = false
        }
      }
    }, 200)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [indexQuery, indexWanted, items, searchNotes, activeScope])

  function focusInput() {
    inputRef.current?.focus()
  }

  function activate(index: number) {
    if (index === createIndex) onCreateNote?.()
    else if (results[index]) onSelect(results[index].item.id)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, lastIndex))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (results.length === 0 && searching) openFirstWhenReadyRef.current = true
      else activate(selectedIndex)
    } else if (e.key === "Tab") {
      // Tab steps through the kinds instead of leaving the field.
      e.preventDefault()
      const at = kinds.indexOf(kind)
      const next = (at + (e.shiftKey ? -1 : 1) + kinds.length) % kinds.length
      setKind(kinds[next] ?? "all")
    } else if (e.key === "Escape" && query) {
      // The first Escape clears the query; the next one closes the window (see SearchModal).
      setQuery("")
    } else if (e.key === "Backspace" && !query && (kind !== "all" || activeScope)) {
      // An empty field gives back the filters one at a time.
      e.preventDefault()
      if (kind !== "all") setKind("all")
      else setScopeId(null)
    }
  }

  // Scroll selected item into view
  React.useEffect(() => {
    const el = listRef.current?.querySelector(
      `[data-result="${selectedIndex}"]`,
    ) as HTMLElement | null
    el?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  function renderResult(result: SearchResult, i: number) {
    return (
      <button
        key={result.item.id}
        type="button"
        data-result={i}
        onClick={() => onSelect(result.item.id)}
        onMouseEnter={() => setSelectedIndex(i)}
        className={cn(
          "flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left",
          i === selectedIndex ? "bg-accent" : "hover:bg-accent/60",
        )}
      >
        <div className="flex w-full min-w-0 items-center gap-2">
          {result.matchType === "tag" ? (
            <Hash className="size-4 shrink-0 text-primary" />
          ) : (
            <TreeItemIcon item={result.item} className="text-muted-foreground" />
          )}
          <span className="min-w-0 truncate text-[13px] text-foreground">
            {result.matchType === "tag" ? result.item.name : highlight(result.item.name, nameQuery)}
          </span>
          {result.path && (
            // The folder gives way before the name does.
            <span className="min-w-[3rem] shrink-[4] truncate text-[11px] text-muted-foreground">
              {result.path}
            </span>
          )}
        </div>
        {result.snippet && (
          <p className="line-clamp-2 w-full pl-6 text-[11px] leading-snug text-primary/70 [overflow-wrap:anywhere]">
            {result.matchType === "tag" ? result.snippet : highlight(result.snippet, nameQuery)}
          </p>
        )}
      </button>
    )
  }

  const scopeLabelClass = "text-[11px] font-medium uppercase tracking-wider text-muted-foreground"

  function renderScopeItem(scope: SearchScope) {
    return (
      <DropdownMenuItem
        key={scope.id}
        onSelect={() => setScopeId(scope.id)}
        className="text-[13px]"
      >
        <Check
          className={cn(
            "size-3.5 shrink-0",
            scope.id === activeScope?.id ? "opacity-100" : "opacity-0",
          )}
        />
        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{scope.name}</span>
          <span className="truncate text-[11px] text-muted-foreground">
            {[scope.path, t("search.entriesCount", { count: scope.itemCount })]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      </DropdownMenuItem>
    )
  }

  const groupHeadingClass =
    "px-2.5 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
  const showList = Boolean(typed) || browsing

  return (
    // min-w-0: a long name must be cut short, never widen the window and push the rest out.
    <div className="flex min-w-0 flex-col">
      {/* Search bar */}
      <div className="flex h-14 shrink-0 items-center gap-3 px-4">
        <Search className="size-5 shrink-0 text-muted-foreground" />
        {/* Focused on mount so keys typed right after opening are not lost. */}
        <input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            activeScope
              ? t("search.scopedPlaceholder", { name: activeScope.name })
              : t("search.placeholder")
          }
          className="min-w-0 flex-1 bg-transparent text-[18px] text-foreground placeholder:text-muted-foreground outline-none"
        />
        {query && (
          <button
            type="button"
            aria-label={t("search.clear")}
            onClick={() => {
              setQuery("")
              focusInput()
            }}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {/* Filters: what to look for, and where. */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-t border-border px-3">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              tabIndex={-1}
              onClick={() => {
                setKind(k)
                focusInput()
              }}
              className={cn(
                "shrink-0 rounded-md px-2 py-0.5 text-[12px]",
                k === kind
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {t(`search.kinds.${k}`)}
            </button>
          ))}
        </div>
        {allScopes.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                tabIndex={-1}
                className={cn(
                  "flex max-w-[40%] shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[12px]",
                  activeScope
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <Folder className="size-3.5 shrink-0" />
                <span className="truncate">{activeScope?.name ?? t("search.everywhere")}</span>
                <ChevronDown className="size-3 shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="max-h-[min(60vh,420px)] w-72 overflow-y-auto"
              onCloseAutoFocus={(event) => {
                event.preventDefault()
                focusInput()
              }}
            >
              <DropdownMenuItem onSelect={() => setScopeId(null)} className="text-[13px]">
                <Check className={cn("size-3.5", activeScope ? "opacity-0" : "opacity-100")} />
                <span className="truncate">
                  {vaultName
                    ? t("search.everywhereIn", { name: vaultName })
                    : t("search.everywhere")}
                </span>
              </DropdownMenuItem>
              {scopes.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className={scopeLabelClass}>
                    {t("search.scopesNearby")}
                  </DropdownMenuLabel>
                  {scopes.map(renderScopeItem)}
                </>
              )}
              {folderScopes.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className={scopeLabelClass}>
                    {t("search.scopesTopLevel")}
                  </DropdownMenuLabel>
                  {folderScopes.map(renderScopeItem)}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* The rest grows and shrinks with what it holds instead of jumping. */}
      <motion.div
        initial={false}
        animate={{ height: panelHeight }}
        transition={motionTransition(spotlightResizeTransition)}
        className="overflow-hidden"
      >
        <div ref={panelRef}>
          {showList && (
            <div className="border-t border-border">
              <div ref={listRef} className="max-h-[min(56vh,520px)] overflow-y-auto">
                {typed === "#" || (kind === "tag" && !typed) ? (
                  <div className="flex items-center gap-2 px-4 py-3 text-[12px] text-muted-foreground">
                    <Hash className="size-3.5 shrink-0" />
                    <span>
                      {t("search.keepTyping")} · {t("search.examplePrefix")}{" "}
                      <span className="text-primary">#{t("search.exampleTag")}</span>
                    </span>
                  </div>
                ) : results.length === 0 ? (
                  <div className="flex items-center gap-3 px-4 py-3 text-[12px] text-muted-foreground">
                    <span className="min-w-0 truncate">
                      {searching
                        ? t("search.searchingContent")
                        : typed
                          ? t("search.notFound")
                          : t("search.noFiles")}
                    </span>
                    {!searching && (activeScope || kind !== "all") && (
                      <button
                        type="button"
                        onClick={() => {
                          setScopeId(null)
                          setKind("all")
                          focusInput()
                        }}
                        className="ml-auto shrink-0 rounded-md bg-accent px-2 py-0.5 text-foreground hover:bg-accent/70"
                      >
                        {t("search.searchEverywhere")}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-px p-1.5">
                    {typed && nameGroup.length > 0 && (
                      <div className={groupHeadingClass}>{t("search.namesHeading")}</div>
                    )}
                    {nameGroup.map((result, i) => renderResult(result, i))}
                    {textGroup.length > 0 && (
                      <div className={groupHeadingClass}>
                        {tagSearch ? t("search.tagsHeading") : t("search.textHeading")}
                      </div>
                    )}
                    {textGroup.map((result, i) => renderResult(result, nameGroup.length + i))}
                  </div>
                )}
              </div>

              {browsing && (
                // Pinned under the list: it does not scroll away with the files.
                <div className="flex items-center gap-1 border-t border-border p-1.5">
                  <button
                    type="button"
                    onClick={() => onCreateNote?.()}
                    onMouseEnter={() => setSelectedIndex(createIndex)}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-foreground",
                      selectedIndex === createIndex ? "bg-accent" : "hover:bg-accent/60",
                    )}
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded bg-accent">
                      <Plus className="size-3.5 text-muted-foreground" />
                    </span>
                    <span className="truncate">{t("search.createNote")}</span>
                  </button>
                  {createActions.map(({ id, label, icon: Icon, run }) => (
                    <button
                      key={id}
                      type="button"
                      tabIndex={-1}
                      title={label}
                      aria-label={label}
                      onClick={run}
                      className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <Icon className="size-4" />
                    </button>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-3 border-t border-border px-4 py-1.5 text-[11px] text-muted-foreground">
                <span>
                  <kbd className="font-sans">↑↓</kbd> {t("search.hintNavigate")}
                </span>
                <span>
                  <kbd className="font-sans">↵</kbd> {t("search.hintOpen")}
                </span>
                <span>
                  <kbd className="font-sans">⇥</kbd> {t("search.hintKind")}
                </span>
                <span className="ml-auto">
                  <kbd className="font-sans">{t("search.keyEscape")}</kbd> {t("search.hintClose")}
                </span>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  )
}
