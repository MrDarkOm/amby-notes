import * as React from "react"
import type { DatabasePropertySummary } from "@/lib/storage"
import { cn } from "@/lib/utils"
import {
  databaseCellText,
  encodeDatabaseCellDraft,
  readDatabaseCellValue,
} from "./database-cell-value"

interface DatabaseCellProps {
  property: DatabasePropertySummary
  valuesJson: string
  wrap?: boolean
  compact?: boolean
  pending: boolean
  error?: string | null
  onCommit: (valueJson?: string) => Promise<void>
}

export function DatabaseCell({
  property,
  valuesJson,
  wrap = false,
  compact = false,
  pending,
  error,
  onCommit,
}: DatabaseCellProps) {
  const value = React.useMemo(
    () => readDatabaseCellValue(valuesJson, property.propertyId),
    [property.propertyId, valuesJson],
  )
  const [draft, setDraft] = React.useState(() => databaseCellText(value, property.propertyType))
  const initial = databaseCellText(value, property.propertyType)

  React.useEffect(() => setDraft(initial), [initial])

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
      <div className="flex h-full min-w-0 items-stretch justify-start overflow-hidden px-1">
        <textarea
          value={draft}
          disabled={pending}
          title={error ?? undefined}
          rows={2}
          className={`h-full min-w-0 w-full resize-none bg-transparent px-2 py-2 text-left text-sm leading-5 outline-none focus:bg-accent/30 disabled:opacity-60 ${error ? "text-destructive" : ""}`}
          onClick={stopRowSelection}
          onChange={(event) => setDraft(event.target.value)}
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
