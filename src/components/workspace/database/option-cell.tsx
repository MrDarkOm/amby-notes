import * as React from "react"
import { Check, MoreHorizontal, Plus } from "lucide-react"
import { Reorder } from "motion/react"
import { useTranslation } from "react-i18next"
import { PickerShell } from "./picker-shell"
import type { DatabasePropertySummary } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { useOptionActions } from "./option-actions"
import { OptionMenuTrigger } from "./option-edit-menu"
import {
  STATUS_GROUPS,
  applyDraftPatch,
  draftsFromProperty,
  findDraftProblem,
  type OptionDraft,
} from "./option-model"
import { ReorderableRow } from "./reorderable-row"
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
  // The options as a list that can be reordered, renamed, recolored and removed on the spot.
  const drafts = React.useMemo(() => draftsFromProperty(property), [property])
  const [order, setOrder] = React.useState(drafts)
  React.useEffect(() => setOrder(drafts), [drafts])
  const orderRef = React.useRef(order)
  orderRef.current = order
  const [listError, setListError] = React.useState<string | null>(null)
  const editable = Boolean(actions) && !pending
  const status = property.propertyType === "status"
  const saveList = async (next: OptionDraft[]) => {
    const found = findDraftProblem(next)
    if (found) throw new Error(t(`databaseOptions.${found.problem}`))
    setListError(null)
    try {
      await actions?.saveOptions(property.propertyId, next)
    } catch (failure) {
      setOrder(drafts)
      throw failure
    }
  }
  const saveQuietly = (next: OptionDraft[]) =>
    void saveList(next).catch((failure) =>
      setListError(failure instanceof Error ? failure.message : String(failure)),
    )
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
    <PickerShell
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery("")
      }}
      popoverClassName="w-56 p-1"
      trigger={
        <button
          type="button"
          disabled={pending}
          title={error ?? property.name}
          aria-label={property.name}
          className={cn(
            "flex w-full min-w-0 cursor-pointer items-center gap-1 rounded-md text-left outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60",
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
      }
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
        {(() => {
          const shown = order.filter((draft) =>
            visibleOptions.some((option) => option.optionId === draft.id),
          )
          const renderRow = (draft: OptionDraft, index: number, reorderable: boolean) => {
            const checked = draft.id !== null && selected.includes(draft.id)
            const choose = (
              <button
                type="button"
                role="option"
                aria-selected={checked}
                className="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1.5 text-left text-xs outline-none focus-visible:bg-accent"
                onClick={() => draft.id && toggle(draft.id)}
              >
                <StatusBadge chip={chipFor(property, draft.id ?? "")} />
                {checked && <Check className="ml-auto size-3.5 text-primary" />}
              </button>
            )
            const more = editable ? (
              <OptionMenuTrigger
                draft={draft}
                status={status}
                onChange={(patch) => saveList(applyDraftPatch(order, draft.key, patch, multi))}
                onRemove={() => saveQuietly(order.filter((other) => other.key !== draft.key))}
                trigger={
                  <button
                    type="button"
                    aria-label={t("databaseOptions.moreActions")}
                    title={t("databaseOptions.moreActions")}
                    className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover/option:opacity-100 data-[state=open]:opacity-100"
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                }
              />
            ) : null
            if (!reorderable) {
              return (
                <div
                  key={draft.key}
                  className="group/option flex items-center gap-1 rounded-md hover:bg-accent/60"
                >
                  {choose}
                  {more}
                </div>
              )
            }
            return (
              <ReorderableRow
                key={draft.key}
                value={draft}
                className="group/option rounded-md hover:bg-accent/60"
                onMove={(offset) => {
                  const next = [...orderRef.current]
                  const target = index + offset
                  if (target < 0 || target >= next.length) return
                  ;[next[index], next[target]] = [next[target], next[index]]
                  setOrder(next)
                  saveQuietly(next)
                }}
                onDropped={() => {
                  const current = orderRef.current
                  if (current.map((d) => d.key).join() !== drafts.map((d) => d.key).join()) {
                    saveQuietly(current)
                  }
                }}
              >
                {choose}
                {more}
              </ReorderableRow>
            )
          }
          // A Status is listed by stage, each with its heading; stages are reordered in the editor.
          if (status) {
            const stages = STATUS_GROUPS.map((group) => ({
              group,
              items: shown.filter((draft) => draft.group === group),
            })).filter((stage) => stage.items.length > 0)
            return stages.map((stage, position) => (
              <div
                key={stage.group}
                role="group"
                aria-label={t(`databaseOptions.group_${stage.group}`)}
              >
                {position > 0 && <div role="separator" className="mx-1 my-1 h-px bg-border" />}
                <p className="px-1.5 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground">
                  {t(`databaseOptions.group_${stage.group}`)}
                </p>
                {stage.items.map((draft, index) => renderRow(draft, index, false))}
              </div>
            ))
          }
          // While searching the list is filtered, so it is not reordered.
          return editable && !trimmedQuery ? (
            <Reorder.Group axis="y" values={order} onReorder={setOrder} className="space-y-0.5">
              {order.map((draft, index) => renderRow(draft, index, true))}
            </Reorder.Group>
          ) : (
            shown.map((draft, index) => renderRow(draft, index, false))
          )
        })()}
        {listError && (
          <p role="alert" className="px-2 py-1 text-xs leading-snug text-destructive">
            {listError}
          </p>
        )}
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
    </PickerShell>
  )
}
