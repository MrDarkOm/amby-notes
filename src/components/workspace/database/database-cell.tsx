import * as React from "react"
import { useTranslation } from "react-i18next"
import { Plus } from "lucide-react"
import type { DatabasePropertySummary } from "@/lib/storage"
import { useViewStateStore } from "@/components/workspace/use-view-state-store"
import { cn } from "@/lib/utils"
import {
  databaseCellText,
  encodeDatabaseCellDraft,
  readDatabaseCellValue,
} from "./database-cell-value"
import { formatComputedValue } from "./value-format"
import { DateCell } from "./date-cell"
import { OptionCell } from "./option-cell"
import { RelationChip } from "./relation-chip"
import { RelationPickerPopover } from "./relation-picker-popover"
import { useRecordReferences } from "./use-record-references"

const MAX_VISIBLE_RELATIONS = 3

interface DatabaseCellProps {
  property: DatabasePropertySummary
  valuesJson: string
  wrap?: boolean
  compact?: boolean
  pending: boolean
  error?: string | null
  targetDatabaseTitle?: string
  /** Message of a calculation failure in this database, shown on computed cells without a value. */
  computedError?: string
  onCommit: (valueJson?: string) => Promise<void>
  onOpenNote?: (noteId: string) => void
  onCreateRelationRow?: (title: string) => Promise<string | void>
}

export function DatabaseCell({
  property,
  valuesJson,
  wrap = false,
  compact = false,
  pending,
  error,
  targetDatabaseTitle,
  computedError,
  onCommit,
  onOpenNote,
  onCreateRelationRow,
}: DatabaseCellProps) {
  const { t, i18n } = useTranslation()
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
  const relationNoteIds = React.useMemo(
    () =>
      property.propertyType === "relation" && Array.isArray(value?.targetNoteIds)
        ? value.targetNoteIds.filter((noteId): noteId is string => typeof noteId === "string")
        : [],
    [property.propertyType, value],
  )
  const relationReferences = useRecordReferences(relationNoteIds)
  const iconOverrides = useViewStateStore((state) => state.iconOverrides)
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
        className={cn(
          "flex h-full items-center justify-start",
          !pending && "cursor-pointer",
          compact ? "px-0" : "px-1",
        )}
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
    return (
      <OptionCell
        property={property}
        value={value}
        compact={compact}
        wrap={wrap || compact}
        pending={pending}
        error={error}
        onCommit={onCommit}
      />
    )
  }

  if (property.propertyType === "date") {
    return (
      <DateCell
        property={property}
        value={value}
        compact={compact}
        pending={pending}
        error={error}
        onCommit={onCommit}
      />
    )
  }

  if (property.propertyType === "relation") {
    const stored = Array.isArray(value?.targetNoteIds)
      ? value.targetNoteIds.filter((noteId): noteId is string => typeof noteId === "string")
      : []
    // Links beyond a one-page limit set later stay stored; only the first is available.
    const selected = relationConfig?.maxItems === 1 ? stored.slice(0, 1) : stored

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
          "flex h-full w-full items-center gap-1 overflow-hidden",
          !pending && "cursor-pointer",
          wrap && "flex-wrap",
          compact ? "px-0 py-0.5" : "px-1 py-1",
        )}
        onClick={(event) => {
          event.stopPropagation()
          // Anywhere in the cell that is not a chip or a button opens the picker.
          if (!pending && !(event.target as HTMLElement).closest("button, a, [data-chip]")) {
            setRelationPickerOpen(true)
          }
        }}
      >
        <RelationPickerPopover
          open={relationPickerOpen}
          onOpenChange={setRelationPickerOpen}
          targetDatabaseId={targetDatabaseId}
          targetDatabaseTitle={targetDatabaseTitle}
          maxItems={maxItems}
          selectedNoteIds={selected}
          pending={pending}
          onSelectNotes={handleSelectNotes}
          onCreatePage={onCreateRelationRow}
          onOpenNote={onOpenNote}
        >
          <div className={cn("flex w-full min-w-0 items-center gap-1", wrap && "flex-wrap")}>
            {(wrap ? selected : selected.slice(0, MAX_VISIBLE_RELATIONS)).map((noteId) => (
              <RelationChip
                key={noteId}
                view={relationReferences[noteId] ?? { status: "loading" }}
                icon={iconOverrides[noteId]}
                onOpen={onOpenNote ? () => onOpenNote(noteId) : () => setRelationPickerOpen(true)}
                onUnlink={pending ? undefined : () => handleRemoveOne(noteId)}
              />
            ))}
            {!wrap && selected.length > MAX_VISIBLE_RELATIONS && (
              <button
                type="button"
                className="rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation()
                  setRelationPickerOpen(true)
                }}
              >
                {t("databaseWorkspace.relationMore", {
                  count: selected.length - MAX_VISIBLE_RELATIONS,
                })}
              </button>
            )}

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

  if (property.propertyType === "formula" || property.propertyType === "rollup") {
    const text = formatComputedValue(value, property, i18n.language)
    // No stored value at all means the calculation failed (or has not run yet);
    // "no data" is a stored null, and zero is a stored 0.
    const failed = value === null && Boolean(computedError)
    return (
      <div
        className={cn(
          "flex h-full items-center justify-start truncate px-1 text-left text-sm",
          failed
            ? "text-destructive"
            : text === null
              ? "italic text-muted-foreground"
              : "tabular-nums",
        )}
        title={failed ? computedError : undefined}
        aria-label={property.name}
      >
        {failed
          ? t("databaseRollup.error")
          : (text ?? (value === null ? "—" : t("databaseRollup.noData")))}
      </div>
    )
  }

  const supported = ["text", "url", "number"].includes(property.propertyType)
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
            "min-w-0 w-full cursor-pointer resize-none bg-transparent text-left outline-none focus:cursor-text focus:bg-accent/30 disabled:cursor-default disabled:opacity-60",
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
        className={cn(
          "min-w-0 w-full max-w-full cursor-pointer rounded-md bg-transparent text-left outline-none focus:cursor-text focus:bg-accent/30 disabled:cursor-default disabled:opacity-60",
          compact ? "h-7 px-1 text-xs" : "h-full min-h-8 px-2 text-sm",
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
