import * as React from "react"
import { Check, Plus, Settings2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { DatabasePropertySummary } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { useOptionActions } from "./option-actions"
import { StatusBadge } from "./property-value"
import { missingOptionChip, safeOptionColor, type DisplayChip } from "./value-format"

interface OptionCellProps {
  property: DatabasePropertySummary
  /** The stored value of the cell. */
  value: Record<string, unknown> | null
  compact?: boolean
  /** Chips may take several lines; otherwise they stay on one line and are clipped. */
  wrap?: boolean
  pending: boolean
  error?: string | null
  onCommit: (valueJson?: string) => Promise<void>
}

function chipFor(property: DatabasePropertySummary, optionId: string): DisplayChip {
  const option = property.options.find((candidate) => candidate.optionId === optionId)
  return option
    ? {
        key: optionId,
        kind: "option",
        label: option.name,
        color: safeOptionColor(option.color),
      }
    : missingOptionChip(optionId, optionId)
}

/** Select, Status and Multi-select: colored labels that open a list of the options. */
export function OptionCell({
  property,
  value,
  compact,
  wrap = true,
  pending,
  error,
  onCommit,
}: OptionCellProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [creating, setCreating] = React.useState(false)
  const actions = useOptionActions()
  const multi = property.propertyType === "multiSelect"
  const selected = React.useMemo(() => {
    if (multi) {
      return Array.isArray(value?.optionIds)
        ? (value.optionIds as unknown[]).filter((id): id is string => typeof id === "string")
        : []
    }
    return typeof value?.optionId === "string" && value.optionId ? [value.optionId] : []
  }, [multi, value])

  const commit = (next: string[]) => {
    if (multi) {
      void onCommit(
        next.length ? JSON.stringify({ type: "multiSelect", optionIds: next }) : undefined,
      )
    } else {
      void onCommit(
        next.length
          ? JSON.stringify({ type: property.propertyType, optionId: next[0] })
          : undefined,
      )
    }
  }
  const trimmedQuery = query.trim()
  const visibleOptions = trimmedQuery
    ? property.options.filter((option) =>
        option.name.toLowerCase().includes(trimmedQuery.toLowerCase()),
      )
    : property.options
  const exactMatch = property.options.find(
    (option) => option.name.trim().toLowerCase() === trimmedQuery.toLowerCase(),
  )
  const canCreate = Boolean(actions && trimmedQuery && !exactMatch)

  async function createFromQuery() {
    if (!actions || !trimmedQuery || creating) return
    setCreating(true)
    try {
      const optionId = await actions.createOption(property.propertyId, trimmedQuery)
      if (!optionId) return
      setQuery("")
      if (multi) {
        commit(selected.includes(optionId) ? selected : [...selected, optionId])
      } else {
        commit([optionId])
        setOpen(false)
      }
    } finally {
      setCreating(false)
    }
  }
  const toggle = (optionId: string) => {
    if (multi) {
      commit(
        selected.includes(optionId)
          ? selected.filter((id) => id !== optionId)
          : [...selected, optionId],
      )
      return
    }
    commit(selected[0] === optionId ? [] : [optionId])
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery("")
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={pending}
          title={error ?? property.name}
          aria-label={property.name}
          className={cn(
            "flex w-full min-w-0 items-center gap-1 rounded-md text-left outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60",
            wrap ? "flex-wrap" : "flex-nowrap overflow-hidden",
            compact ? "min-h-7 px-1 py-0.5 hover:bg-accent/40" : "h-full min-h-8 px-2",
            error && "text-destructive",
          )}
          onClick={(event) => event.stopPropagation()}
        >
          {selected.length === 0 ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : (
            selected.map((id) => <StatusBadge key={id} chip={chipFor(property, id)} />)
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-56 p-1"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          disabled={creating}
          aria-label={t("databaseOptions.searchOrCreate")}
          placeholder={actions ? t("databaseOptions.searchOrCreate") : t("databaseOptions.search")}
          className="mb-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key !== "Enter") return
            event.preventDefault()
            if (exactMatch) {
              toggle(exactMatch.optionId)
              setQuery("")
            } else if (canCreate) void createFromQuery()
            else if (visibleOptions.length === 1) toggle(visibleOptions[0].optionId)
          }}
        />
        <div
          role="listbox"
          aria-multiselectable={multi}
          aria-label={property.name}
          className="max-h-64 overflow-y-auto"
        >
          {visibleOptions.map((option) => {
            const checked = selected.includes(option.optionId)
            return (
              <button
                key={option.optionId}
                type="button"
                role="option"
                aria-selected={checked}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                onClick={() => toggle(option.optionId)}
              >
                <StatusBadge chip={chipFor(property, option.optionId)} />
                {checked && <Check className="ml-auto size-3.5 text-primary" />}
              </button>
            )
          })}
          {selected.length > 0 && (
            <button
              type="button"
              className="mt-0.5 w-full rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent"
              onClick={() => {
                commit([])
                setOpen(false)
              }}
            >
              {t("databaseValue.clear")}
            </button>
          )}
          {canCreate && (
            <button
              type="button"
              disabled={creating}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:opacity-60"
              onClick={() => void createFromQuery()}
            >
              <Plus className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {t("databaseOptions.createNamed", { name: trimmedQuery })}
              </span>
            </button>
          )}
          {property.options.length === 0 && !canCreate && (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {actions ? t("databaseOptions.emptyHint") : t("databaseValue.noOptions")}
            </p>
          )}
          {property.options.length > 0 && visibleOptions.length === 0 && !canCreate && (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {t("databaseOptions.noMatches")}
            </p>
          )}
        </div>
        {actions && (
          <button
            type="button"
            className="mt-1 flex w-full items-center gap-2 border-t border-border/60 px-2 pt-2 pb-1 text-left text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              setOpen(false)
              setQuery("")
              actions.editOptions(property.propertyId)
            }}
          >
            <Settings2 className="size-3.5" />
            {t("databaseOptions.edit")}
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
