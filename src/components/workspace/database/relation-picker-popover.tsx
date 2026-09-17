"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Check, Database, ExternalLink, FileText, Loader2, Plus, Search, X } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { IconValue } from "@/components/workspace/icon-value"
import { MotionSpinner } from "@/lib/motion"
import { cn } from "@/lib/utils"

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
  options: RelationItem[]
  isLoading?: boolean
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
  targetDatabaseId: _targetDatabaseId,
  targetDatabaseTitle,
  maxItems,
  selectedNoteIds,
  options,
  isLoading = false,
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

  const filteredOptions = React.useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return options
    return options.filter((opt) => (opt.title || "").toLowerCase().includes(trimmed))
  }, [options, query])

  const hasExactMatch = React.useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return true
    return options.some((opt) => (opt.title || "").toLowerCase() === trimmed)
  }, [options, query])

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
    if (!title || !onCreatePage || creating) return
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
    <Popover open={open} onOpenChange={onOpenChange}>
      {(trigger || children) && <PopoverTrigger asChild>{trigger || children}</PopoverTrigger>}
      <PopoverContent
        align={align}
        sideOffset={6}
        className={cn(
          "w-80 p-0 shadow-lg border border-border bg-popover text-popover-foreground rounded-lg overflow-hidden flex flex-col max-h-[380px]",
          className,
        )}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
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
              if (e.key === "Enter" && !hasExactMatch && query.trim() && onCreatePage) {
                e.preventDefault()
                void handleCreate()
              }
            }}
          />
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

        {/* Items list */}
        <div className="flex-1 overflow-y-auto py-1 min-h-[120px] max-h-[260px]">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground gap-2">
              <MotionSpinner>
                <Loader2 className="size-4 text-muted-foreground" />
              </MotionSpinner>
              <span>{t("common.loading")}</span>
            </div>
          ) : filteredOptions.length === 0 && !query.trim() ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              {t("databaseWorkspace.relationNoPages")}
            </div>
          ) : (
            filteredOptions.map((item) => {
              const isSelected = selectedNoteIds.includes(item.noteId)
              return (
                <div
                  key={item.noteId}
                  className={cn(
                    "group flex items-center justify-between gap-2 px-3 py-1.5 text-xs sm:text-sm cursor-pointer hover:bg-accent/50 select-none",
                    isSelected && "bg-accent/30 font-medium text-foreground",
                  )}
                  onClick={() => handleToggleNote(item.noteId)}
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
                      value={item.icon ?? undefined}
                      fallback={<FileText className="size-3.5 text-muted-foreground shrink-0" />}
                      className="size-3.5 shrink-0"
                    />
                    <span className="truncate">{item.title || t("editor.untitled")}</span>
                  </div>

                  {onOpenNote && (
                    <button
                      type="button"
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-background text-muted-foreground hover:text-foreground shrink-0"
                      title={t("databaseWorkspace.relationOpenPage")}
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
            })
          )}
        </div>

        {/* Create new page action */}
        {query.trim() && !hasExactMatch && onCreatePage && (
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
      </PopoverContent>
    </Popover>
  )
}
