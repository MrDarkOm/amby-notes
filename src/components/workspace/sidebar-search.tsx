"use client"

import * as React from "react"
import { FileText, Search, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { TreeItem } from "./sidebar-tree"

interface SearchResult {
  item: TreeItem
  path: string        // display path like "Work › Notes"
  matchType: "name" | "content"
  snippet?: string    // content excerpt with match
  score: number
}

interface SidebarSearchProps {
  items: TreeItem[]
  onSelect: (id: string) => void
  readFile?: (path: string) => Promise<string>
}

function flattenTree(items: TreeItem[], parentPath = ""): Array<{ item: TreeItem; path: string }> {
  const result: Array<{ item: TreeItem; path: string }> = []
  for (const item of items) {
    const displayPath = parentPath ? `${parentPath} › ${item.name}` : item.name
    if (item.type === "file") {
      result.push({ item, path: parentPath })
    }
    if (item.children) {
      result.push(...flattenTree(item.children, displayPath))
    }
  }
  return result
}

function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-transparent text-violet-400 font-semibold">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  )
}

function getSnippet(content: string, query: string, radius = 60): string {
  const lower = content.toLowerCase()
  const idx = lower.indexOf(query.toLowerCase())
  if (idx === -1) return ""
  const start = Math.max(0, idx - radius)
  const end = Math.min(content.length, idx + query.length + radius)
  return (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "")
}

export function SidebarSearch({ items, onSelect, readFile }: SidebarSearchProps) {
  const [query, setQuery] = React.useState("")
  const [results, setResults] = React.useState<SearchResult[]>([])
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const [searching, setSearching] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const listRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  React.useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!query.trim()) { setResults([]); setSelectedIndex(0); return }

    const q = query.trim().toLowerCase()
    const flat = flattenTree(items)

    // Immediate name match
    const nameResults: SearchResult[] = flat
      .filter(({ item }) => item.name.toLowerCase().includes(q))
      .map(({ item, path }) => ({
        item,
        path,
        matchType: "name" as const,
        score: item.name.toLowerCase().startsWith(q) ? 2 : 1,
      }))
      .sort((a, b) => b.score - a.score)

    setResults(nameResults)
    setSelectedIndex(0)

    // Debounced content search
    if (readFile) {
      setSearching(true)
      debounceRef.current = setTimeout(async () => {
        const contentResults: SearchResult[] = []
        const nameMatchIds = new Set(nameResults.map(r => r.item.id))

        await Promise.allSettled(
          flat
            .filter(({ item }) => !nameMatchIds.has(item.id))
            .map(async ({ item, path }) => {
              try {
                const content = await readFile(item.id)
                if (content.toLowerCase().includes(q)) {
                  contentResults.push({
                    item,
                    path,
                    matchType: "content",
                    snippet: getSnippet(content, query.trim()),
                    score: 0,
                  })
                }
              } catch { /* skip unreadable files */ }
            })
        )

        setResults(prev => [...prev, ...contentResults])
        setSearching(false)
      }, 300)
    }

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, items, readFile])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (results[selectedIndex]) onSelect(results[selectedIndex].item.id)
    } else if (e.key === "Escape") {
      setQuery("")
    }
  }

  // Scroll selected item into view
  React.useEffect(() => {
    const el = listRef.current?.querySelector(`[data-result="${selectedIndex}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  return (
    <div className="flex h-full flex-col">
      {/* Input */}
      <div className="shrink-0 border-b border-zinc-800 p-2">
        <div className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 focus-within:border-zinc-500">
          <Search className="size-3.5 shrink-0 text-zinc-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Поиск заметок..."
            className="flex-1 bg-transparent text-[13px] text-zinc-200 placeholder:text-zinc-600 outline-none"
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-zinc-600 hover:text-zinc-400">
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      {/* Results */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {!query.trim() ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Search className="mb-2 size-8 text-zinc-700" />
            <p className="text-[12px] text-zinc-600">Введи текст для поиска</p>
            <p className="mt-1 text-[11px] text-zinc-700">Поиск по именам и содержимому</p>
          </div>
        ) : results.length === 0 && !searching ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <p className="text-[12px] text-zinc-500">Ничего не найдено</p>
            <p className="mt-1 text-[11px] text-zinc-700">«{query}»</p>
          </div>
        ) : (
          <div className="flex flex-col gap-px p-1.5">
            {results.map((result, i) => (
              <button
                key={result.item.id}
                data-result={i}
                onClick={() => onSelect(result.item.id)}
                onMouseEnter={() => setSelectedIndex(i)}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left transition-colors",
                  i === selectedIndex ? "bg-zinc-800" : "hover:bg-zinc-800/60"
                )}
              >
                <div className="flex items-center gap-1.5 w-full min-w-0">
                  <FileText className="size-3.5 shrink-0 text-zinc-500" />
                  <span className="truncate text-[13px] text-zinc-200">
                    {highlight(result.item.name, query.trim())}
                  </span>
                  {result.matchType === "content" && (
                    <span className="ml-auto shrink-0 text-[10px] text-zinc-600">содержимое</span>
                  )}
                </div>
                {result.path && (
                  <span className="truncate pl-5 text-[11px] text-zinc-600">{result.path}</span>
                )}
                {result.snippet && (
                  <p className="pl-5 text-[11px] leading-tight text-zinc-500 line-clamp-2">
                    {highlight(result.snippet, query.trim())}
                  </p>
                )}
              </button>
            ))}
            {searching && (
              <p className="px-2 py-1 text-[11px] text-zinc-700">Поиск по содержимому…</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
