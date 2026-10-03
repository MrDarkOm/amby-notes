import * as React from "react"
import { useTranslation } from "react-i18next"
import type { DatabasePropertySummary } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { dateInputValue, storedDate } from "./date-input"
import { dateDisplayOf, formatDateValue } from "./value-format"

interface DateCellProps {
  property: DatabasePropertySummary
  /** The stored value of the cell, if any. */
  value: Record<string, unknown> | null
  compact?: boolean
  pending: boolean
  error?: string | null
  onCommit: (valueJson?: string) => Promise<void>
}

/**
 * A Date value shown in the property's own format (date format, 12/24 hour time);
 * pressing it opens the browser's date (or date and time) field.
 */
export function DateCell({ property, value, compact, pending, error, onCommit }: DateCellProps) {
  const { i18n } = useTranslation()
  const display = React.useMemo(() => dateDisplayOf(property.configJson), [property.configJson])
  const start = typeof value?.start === "string" ? value.start : ""
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState("")
  const inputRef = React.useRef<HTMLInputElement>(null)

  const open = () => {
    setDraft(dateInputValue(start, display.includeTime))
    setEditing(true)
  }
  React.useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    try {
      inputRef.current?.showPicker?.()
    } catch {
      // Some environments only open the picker from a user gesture.
    }
  }, [editing])

  const commit = () => {
    setEditing(false)
    if (draft === dateInputValue(start, display.includeTime)) return
    const next = storedDate(draft, display.includeTime)
    if (next === null) {
      void onCommit(undefined)
      return
    }
    // The end of a range and the time zone of the stored value stay as they were.
    void onCommit(
      JSON.stringify({
        type: "date",
        start: next,
        end: typeof value?.end === "string" ? value.end : null,
        timeZone: typeof value?.timeZone === "string" ? value.timeZone : null,
      }),
    )
  }

  if (editing) {
    return (
      <div className={cn("flex h-full min-w-0 items-center", compact ? "px-0" : "px-1")}>
        <input
          ref={inputRef}
          type={display.includeTime ? "datetime-local" : "date"}
          value={draft}
          aria-label={property.name}
          className={cn(
            "min-w-0 max-w-full rounded-md bg-accent/30 text-left outline-none",
            compact ? "h-7 w-full px-1 text-xs" : "h-8 px-2 text-sm",
          )}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === "Enter") event.currentTarget.blur()
            if (event.key === "Escape") {
              setDraft(dateInputValue(start, display.includeTime))
              setEditing(false)
            }
          }}
        />
      </div>
    )
  }
  const text = start ? formatDateValue(start, display, i18n.language) : ""
  return (
    <button
      type="button"
      disabled={pending}
      title={error ?? property.name}
      aria-label={property.name}
      className={cn(
        "flex h-full w-full min-w-0 items-center rounded-md text-left outline-none hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60",
        compact ? "min-h-7 px-1 text-xs" : "px-2 text-sm",
        !text && "text-muted-foreground",
        error && "text-destructive",
      )}
      onClick={(event) => {
        event.stopPropagation()
        open()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <span className="truncate">{text || "—"}</span>
    </button>
  )
}
