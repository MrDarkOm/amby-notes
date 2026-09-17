import * as React from "react"
import { useTranslation } from "react-i18next"
import { FileText, Plus, X } from "lucide-react"
import type { DatabasePropertySummary } from "@/lib/storage"
import { IconValue } from "@/components/workspace/icon-value"
import { cn } from "@/lib/utils"
import {
  databaseCellText,
  encodeDatabaseCellDraft,
  readDatabaseCellValue,
} from "./database-cell-value"
import { RelationPickerPopover, type RelationItem } from "./relation-picker-popover"

interface DatabaseCellProps {
  property: DatabasePropertySummary
  valuesJson: string
  relationOptions?: RelationItem[]
  wrap?: boolean
  compact?: boolean
  pending: boolean
  error?: string | null
  targetDatabaseTitle?: string
  onCommit: (valueJson?: string) => Promise<void>
  onOpenNote?: (noteId: string) => void
  onCreateRelationRow?: (title: string) => Promise<string | void>
}

export function DatabaseCell({
  property,
  valuesJson,
  relationOptions = [],
  wrap = false,
  compact = false,
  pending,
  error,
  targetDatabaseTitle,
  onCommit,
  onOpenNote,
  onCreateRelationRow,
}: DatabaseCellProps) {
  const { t } = useTranslation()
  const [relationPickerOpen, setRelationPickerOpen] = React.useState(false)
  const value = React.useMemo(
    () => readDatabaseCellValue(valuesJson, property.propertyId),
    [property.propertyId, valuesJson],
  )
  const relationConfig = React.useMemo(() => {
    if (property.propertyType !== "relation") return null
    try {
      return JSON.parse(property.configJson) as {
        targetDatabaseId?: string
        maxItems?: number | null
        inversePropertyId?: string | null
      }
    } catch {
      return null
    }
  }, [property.configJson, property.propertyType])
  const [draft, setDraft] = React.useState(() => databaseCellText(value, property.propertyType))
  const initial = databaseCellText(value, property.propertyType)
  const wrappedTextRef = React.useRef<HTMLTextAreaElement>(null)

  React.useEffect(() => setDraft(initial), [initial])

  const resizeWrappedText = React.useCallback(() => {
    const textarea = wrappedTextRef.current
    if (!textarea) return
    textarea.style.height = "0px"
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [])

  React.useLayoutEffect(() => {
    if (wrap && compact && (property.propertyType === "text" || property.propertyType === "url")) {
      resizeWrappedText()
    }
  }, [compact, draft, property.propertyType, resizeWrappedText, wrap])

  const commitDraft = () => {
    if (draft === initial) return
    void onCommit(encodeDatabaseCellDraft(property.propertyType, draft))
  }
  const stopRowSelection = (event: React.SyntheticEvent) => event.stopPropagation()

  if (property.propertyType === "checkbox") {
    const checked = value?.checked === true
    return (
      <label
        className={cn("flex h-full items-center justify-start", compact ? "px-0" : "px-1")}
        title={error ?? undefined}
        onClick={stopRowSelection}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={pending}
          onChange={(event) =>
            void onCommit(JSON.stringify({ type: "checkbox", checked: event.target.checked }))
          }
        />
      </label>
    )
  }

  if (
    property.propertyType === "select" ||
    property.propertyType === "status" ||
    property.propertyType === "multiSelect"
  ) {
    const selected =
      property.propertyType === "multiSelect"
        ? Array.isArray(value?.optionIds)
          ? (value.optionIds as string[])
          : []
        : typeof value?.optionId === "string"
          ? value.optionId
          : ""
    return (
      <div className={cn("flex h-full items-center justify-start", compact ? "px-0" : "px-1")}>
        <select
          multiple={property.propertyType === "multiSelect"}
          value={selected}
          disabled={pending}
          title={error ?? undefined}
          className={cn(
            "max-w-full rounded-md bg-transparent text-left outline-none focus:bg-accent/30 disabled:opacity-60",
            compact ? "h-7 w-full min-w-0 px-1 text-xs" : "h-8 min-w-[4rem] px-2 text-sm",
          )}
          onClick={stopRowSelection}
          onChange={(event) => {
            if (property.propertyType === "multiSelect") {
              const optionIds = Array.from(event.target.selectedOptions, (option) => option.value)
              void onCommit(
                optionIds.length ? JSON.stringify({ type: "multiSelect", optionIds }) : undefined,
              )
              return
            }
            const optionId = event.target.value
            void onCommit(
              optionId ? JSON.stringify({ type: property.propertyType, optionId }) : undefined,
            )
          }}
        >
          {property.propertyType !== "multiSelect" && <option value="">—</option>}
          {property.options.map((option) => (
            <option key={option.optionId} value={option.optionId}>
              {option.name}
            </option>
          ))}
        </select>
      </div>
    )
  }

  if (property.propertyType === "relation") {
    const selected = Array.isArray(value?.targetNoteIds)
      ? value.targetNoteIds.filter((noteId): noteId is string => typeof noteId === "string")
      : []

    const handleSelectNotes = (nextIds: string[]) => {
      void onCommit(
        nextIds.length ? JSON.stringify({ type: "relation", targetNoteIds: nextIds }) : undefined,
      )
    }

    const handleRemoveOne = (noteIdToRemove: string) => {
      handleSelectNotes(selected.filter((id) => id !== noteIdToRemove))
    }

    const targetDatabaseId = relationConfig?.targetDatabaseId || ""
    const maxItems = relationConfig?.maxItems ?? null

    return (
      <div
        className={cn(
          "flex h-full w-full min-h-[30px] flex-wrap items-center gap-1 overflow-hidden",
          compact ? "px-0 py-0.5" : "px-1 py-1",
        )}
        onClick={stopRowSelection}
      >
        <RelationPickerPopover
          open={relationPickerOpen}
          onOpenChange={setRelationPickerOpen}
          targetDatabaseId={targetDatabaseId}
          targetDatabaseTitle={targetDatabaseTitle}
          maxItems={maxItems}
          selectedNoteIds={selected}
          options={relationOptions}
          isLoading={pending}
          onSelectNotes={handleSelectNotes}
          onCreatePage={onCreateRelationRow}
          onOpenNote={onOpenNote}
        >
          <div className="flex flex-wrap items-center gap-1 w-full min-w-0">
            {selected.map((noteId) => {
              const option = relationOptions.find((opt) => opt.noteId === noteId)
              const title = option?.title || noteId
              return (
                <span
                  key={noteId}
                  className="group/chip inline-flex items-center gap-1 rounded bg-muted/80 hover:bg-muted px-1.5 py-0.5 text-xs text-foreground max-w-full cursor-pointer select-none"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (onOpenNote) {
                      onOpenNote(noteId)
                    } else {
                      setRelationPickerOpen(true)
                    }
                  }}
                  title={title}
                >
                  <IconValue
                    value={option?.icon ?? undefined}
                    fallback={<FileText className="size-3 text-muted-foreground shrink-0" />}
                    className="size-3 shrink-0"
                  />
                  <span className="truncate max-w-[130px] font-medium">{title}</span>
                  {!pending && (
                    <button
                      type="button"
                      className="opacity-40 group-hover/chip:opacity-100 hover:text-destructive hover:bg-background/80 rounded p-0.5 shrink-0"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleRemoveOne(noteId)
                      }}
                      title={t("databaseWorkspace.relationRemoveItem")}
                    >
                      <X className="size-2.5" />
                    </button>
                  )}
                </span>
              )
            })}

            {!pending && (maxItems !== 1 || selected.length === 0) && (
              <button
                type="button"
                className="inline-flex items-center justify-center size-5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 shrink-0"
                onClick={(e) => {
                  e.stopPropagation()
                  setRelationPickerOpen(true)
                }}
                title={t("databaseWorkspace.relationAdd")}
              >
                <Plus className="size-3" />
              </button>
            )}

            {selected.length === 0 && (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground italic cursor-pointer"
                onClick={() => setRelationPickerOpen(true)}
              >
                —
              </button>
            )}
          </div>
        </RelationPickerPopover>
      </div>
    )
  }

  const supported = ["text", "url", "number", "date"].includes(property.propertyType)
  if (!supported) {
    return (
      <div
        className="flex h-full items-center justify-start truncate px-1 text-left text-sm text-muted-foreground"
        title={property.propertyType}
      >
        —
      </div>
    )
  }

  if (wrap && (property.propertyType === "text" || property.propertyType === "url")) {
    return (
      <div
        className={cn(
          "flex min-w-0 items-start justify-start overflow-hidden px-1",
          compact ? "min-h-8 py-0.5" : "h-full items-stretch",
        )}
      >
        <textarea
          ref={wrappedTextRef}
          value={draft}
          disabled={pending}
          title={error ?? undefined}
          rows={compact ? 1 : 2}
          className={cn(
            "min-w-0 w-full resize-none bg-transparent text-left outline-none focus:bg-accent/30 disabled:opacity-60",
            compact
              ? "min-h-7 overflow-hidden rounded-md px-1 py-1 text-xs leading-4 whitespace-pre-wrap break-words"
              : "h-full px-2 py-2 text-sm leading-5",
            error && "text-destructive",
          )}
          onClick={stopRowSelection}
          onChange={(event) => {
            setDraft(event.target.value)
            if (compact) resizeWrappedText()
          }}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === "Escape") {
              setDraft(initial)
              event.currentTarget.blur()
            }
          }}
        />
      </div>
    )
  }

  return (
    <div
      className={cn(
        "flex h-full min-w-0 items-center justify-start overflow-hidden",
        compact ? "px-0" : "px-1",
      )}
    >
      <input
        type={property.propertyType === "date" ? "date" : "text"}
        inputMode={property.propertyType === "number" ? "decimal" : undefined}
        value={draft}
        disabled={pending}
        title={error ?? undefined}
        style={
          compact
            ? undefined
            : {
                width: `${Math.max(property.propertyType === "date" ? 12 : 6, draft.length + 2)}ch`,
              }
        }
        className={cn(
          "min-w-0 max-w-full rounded-md bg-transparent text-left outline-none focus:bg-accent/30 disabled:opacity-60",
          compact ? "h-7 w-full px-1 text-xs" : "h-8 px-2 text-sm",
          error && "text-destructive",
        )}
        onClick={stopRowSelection}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === "Enter") event.currentTarget.blur()
          if (event.key === "Escape") {
            setDraft(initial)
            event.currentTarget.blur()
          }
        }}
      />
    </div>
  )
}
