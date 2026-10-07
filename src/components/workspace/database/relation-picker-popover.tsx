"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Check, Database, ExternalLink, FileText, Loader2, Plus, Search, X } from "lucide-react"
import { PickerShell } from "./picker-shell"
import { Button } from "@/components/ui/button"
import { IconValue } from "@/components/workspace/icon-value"
import { useViewStateStore } from "@/components/workspace/use-view-state-store"
import { MotionSpinner } from "@/lib/motion"
import { cn } from "@/lib/utils"
import { RelationChip } from "./relation-chip"
import { useRecordReferences } from "./use-record-references"
import { useRelationCandidates } from "./use-relation-candidates"

export interface RelationItem {
  noteId: string
  title: string
  icon?: string | null
}

interface RelationPickerPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  targetDatabaseId: string
  targetDatabaseTitle?: string
  maxItems?: number | null
  selectedNoteIds: string[]
  pending?: boolean
  onSelectNotes: (noteIds: string[]) => void
  onCreatePage?: (title: string) => Promise<string | void>
  onOpenNote?: (noteId: string) => void
  trigger?: React.ReactNode
  children?: React.ReactNode
  align?: "start" | "center" | "end"
  className?: string
}

export function RelationPickerPopover({
  open,
  onOpenChange,
  targetDatabaseId,
  targetDatabaseTitle,
  maxItems,
  selectedNoteIds,
  pending = false,
  onSelectNotes,
  onCreatePage,
  onOpenNote,
  trigger,
  children,
  align = "start",
  className,
}: RelationPickerPopoverProps) {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState("")
  const [creating, setCreating] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (open) {
      setQuery("")
      setCreating(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const candidates = useRelationCandidates({
    databaseId: targetDatabaseId,
    query,
    enabled: open,
  })
  const selectedReferences = useRecordReferences(selectedNoteIds)
  const iconOverrides = useViewStateStore((state) => state.iconOverrides)
  const trimmedQuery = query.trim()
  const settled = candidates.status === "ready" && candidates.settledQuery === trimmedQuery

  // Offer to create a page only when the answer is complete: while results are
  // loading, failed, or only a first page, a missing exact match proves nothing.
  const canCreate =
    Boolean(onCreatePage) &&
    Boolean(trimmedQuery) &&
    settled &&
    !candidates.hasMore &&
    !candidates.items.some((item) => item.title.trim().toLowerCase() === trimmedQuery.toLowerCase())

  const isSingleLimit = maxItems === 1

  const handleToggleNote = (noteId: string) => {
    const isSelected = selectedNoteIds.includes(noteId)
    if (isSelected) {
      onSelectNotes(selectedNoteIds.filter((id) => id !== noteId))
    } else {
      if (isSingleLimit) {
        onSelectNotes([noteId])
      } else {
        onSelectNotes([...selectedNoteIds, noteId])
      }
    }
  }

  const handleClearAll = () => {
    onSelectNotes([])
  }

  const handleCreate = async () => {
    const title = query.trim()
    if (!title || !onCreatePage || creating || !canCreate) return
    setCreating(true)
    try {
      const createdId = await onCreatePage(title)
      if (createdId && typeof createdId === "string") {
        if (isSingleLimit) {
          onSelectNotes([createdId])
        } else {
          onSelectNotes([...selectedNoteIds, createdId])
        }
      }
      setQuery("")
    } finally {
      setCreating(false)
    }
  }

  return (
    <PickerShell
      open={open}
      onOpenChange={onOpenChange}
      trigger={trigger || children}
      align={align}
      popoverClassName={cn(
        "w-80 p-0 shadow-lg border border-border bg-popover text-popover-foreground rounded-lg overflow-hidden flex flex-col max-h-[380px]",
        className,
      )}
      inlineClassName="p-0"
      onContentKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation()
          onOpenChange(false)
        }
      }}
    >
      {/* Search header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/80 bg-muted/20">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          className="w-full bg-transparent text-xs sm:text-sm outline-none placeholder:text-muted-foreground text-foreground"
          placeholder={t("databaseWorkspace.relationSearchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canCreate) {
              e.preventDefault()
              void handleCreate()
            }
          }}
        />
        {(candidates.status === "loading" || candidates.status === "loadingMore") && (
          <MotionSpinner className="shrink-0">
            <Loader2 className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </MotionSpinner>
        )}
        {query && (
          <button
            type="button"
            className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50"
            onClick={() => setQuery("")}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {/* Target database badge & Clear all header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/60 bg-muted/10 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-1.5 truncate max-w-[180px]">
          <Database className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">
            {targetDatabaseTitle || t("databaseWorkspace.relationTarget")}
          </span>
          {isSingleLimit && (
            <span className="rounded bg-muted px-1 py-0.2 text-[10px] text-muted-foreground shrink-0">
              1
            </span>
          )}
        </div>
        {selectedNoteIds.length > 0 && (
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground hover:underline shrink-0"
            onClick={handleClearAll}
          >
            {t("databaseWorkspace.relationClearAll")}
          </button>
        )}
      </div>

      {/* Selected pages: named by the backend, independent of the search results */}
      {selectedNoteIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-border/60 px-3 py-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("databaseWorkspace.relationSelected")}
          </span>
          {selectedNoteIds.map((noteId) => (
            <RelationChip
              key={noteId}
              view={selectedReferences[noteId] ?? { status: "loading" }}
              icon={iconOverrides[noteId]}
              onUnlink={
                pending
                  ? undefined
                  : () => onSelectNotes(selectedNoteIds.filter((id) => id !== noteId))
              }
            />
          ))}
        </div>
      )}

      {/* Items list */}
      <div
        className="flex-1 overflow-y-auto py-1 min-h-[120px] max-h-[260px]"
        role="listbox"
        aria-multiselectable={!isSingleLimit}
        onScroll={(event) => {
          const element = event.currentTarget
          if (element.scrollTop + element.clientHeight >= element.scrollHeight - 48) {
            candidates.loadMore()
          }
        }}
      >
        {candidates.status === "error" ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-2 px-3 py-6 text-center text-xs text-destructive"
          >
            <span>{t("databaseWorkspace.relationSearchError")}</span>
            <span className="text-[11px] text-muted-foreground">{candidates.error}</span>
            <Button variant="ghost" size="sm" onClick={candidates.retry}>
              {t("databaseWorkspace.relationRetry")}
            </Button>
          </div>
        ) : candidates.status === "loading" && candidates.items.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-xs text-muted-foreground gap-2">
            <MotionSpinner>
              <Loader2 className="size-4 text-muted-foreground" />
            </MotionSpinner>
            <span>{t("common.loading")}</span>
          </div>
        ) : candidates.items.length === 0 && candidates.status !== "idle" ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            {trimmedQuery
              ? t("databaseWorkspace.relationNoResults")
              : t("databaseWorkspace.relationNoPages")}
          </div>
        ) : (
          <>
            {candidates.items.map((item) => {
              const isSelected = selectedNoteIds.includes(item.noteId)
              const location = item.path.includes("/")
                ? item.path.slice(0, item.path.lastIndexOf("/"))
                : ""
              return (
                <div
                  key={item.noteId}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={0}
                  className={cn(
                    "group flex items-center justify-between gap-2 px-3 py-1.5 text-xs sm:text-sm cursor-pointer hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none select-none",
                    isSelected && "bg-accent/30 font-medium text-foreground",
                  )}
                  onClick={() => handleToggleNote(item.noteId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      handleToggleNote(item.noteId)
                    }
                  }}
                >
                  <div className="flex items-center gap-2 truncate min-w-0 flex-1">
                    <div
                      className={cn(
                        "size-4 rounded flex items-center justify-center border shrink-0",
                        isSelected
                          ? "bg-primary border-primary text-primary-foreground"
                          : "border-muted-foreground/40 group-hover:border-muted-foreground",
                      )}
                    >
                      {isSelected && <Check className="size-3 stroke-[2.5]" />}
                    </div>
                    <IconValue
                      value={iconOverrides[item.noteId] ?? undefined}
                      fallback={<FileText className="size-3.5 text-muted-foreground shrink-0" />}
                      className="size-3.5 shrink-0"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{item.title || t("editor.untitled")}</span>
                      {location && (
                        <span className="truncate text-[10px] text-muted-foreground">
                          {location}
                        </span>
                      )}
                    </span>
                  </div>

                  {onOpenNote && (
                    <button
                      type="button"
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1 rounded hover:bg-background text-muted-foreground hover:text-foreground shrink-0"
                      title={t("databaseWorkspace.relationOpenPage")}
                      aria-label={t("databaseWorkspace.relationOpenPage")}
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpenNote(item.noteId)
                      }}
                    >
                      <ExternalLink className="size-3.5" />
                    </button>
                  )}
                </div>
              )
            })}
            {candidates.status === "loadingMore" && (
              <div className="flex items-center justify-center py-2 text-xs text-muted-foreground">
                <MotionSpinner>
                  <Loader2 className="size-3.5" />
                </MotionSpinner>
              </div>
            )}
            {candidates.hasMore && candidates.status === "ready" && (
              <button
                type="button"
                className="w-full py-2 text-center text-xs text-muted-foreground hover:text-foreground hover:underline"
                onClick={candidates.loadMore}
              >
                {t("databaseWorkspace.relationLoadMore")}
              </button>
            )}
          </>
        )}
      </div>

      {/* Create new page action */}
      {canCreate && onCreatePage && (
        <div className="border-t border-border/80 p-1 bg-muted/20">
          <Button
            variant="ghost"
            size="sm"
            disabled={creating}
            className="w-full justify-start h-8 px-2.5 text-xs text-primary hover:text-primary hover:bg-accent/60 gap-2 font-normal"
            onClick={handleCreate}
          >
            {creating ? (
              <MotionSpinner className="size-3.5 shrink-0">
                <Loader2 className="size-3.5" />
              </MotionSpinner>
            ) : (
              <Plus className="size-3.5 shrink-0" />
            )}
            <span className="truncate">
              {t("databaseWorkspace.relationCreatePage", {
                title: query.trim(),
                database: targetDatabaseTitle || "",
              })}
            </span>
          </Button>
        </div>
      )}
    </PickerShell>
  )
}
