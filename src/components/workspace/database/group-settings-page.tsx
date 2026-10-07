"use client"

import * as React from "react"
import { Eye, EyeOff } from "lucide-react"
import { Reorder } from "motion/react"
import { useTranslation } from "react-i18next"
import type { DatabasePropertySummary } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { EMPTY_BOARD_LANE, groupListOrder, type BoardLane } from "./layouts/board-model"
import { safeOptionColor } from "./value-format"
import { ReorderableRow } from "./reorderable-row"
import { Row, SwitchRow } from "./view-settings-rows"
import type { GroupSort } from "./view-config"

export interface GroupSettingsPageProps {
  groupProperty: DatabasePropertySummary | undefined
  sort: GroupSort
  hideEmpty: boolean
  colorColumns: boolean
  order: string[]
  hidden: string[]
  disabled?: boolean
  onOpenGroupBy: () => void
  onOpenSort: () => void
  onHideEmptyChange: (hide: boolean) => void
  onColorColumnsChange: (colored: boolean) => void
  onOrderChange: (order: string[]) => void
  onHiddenChange: (hidden: string[]) => void
}

/** The groups of a property as the settings list: its options, then "no value". */
function naturalGroups(property: DatabasePropertySummary | undefined): BoardLane[] {
  if (!property) return []
  return [
    ...property.options.map((option) => ({
      key: option.optionId,
      rows: [],
      label: option.name,
      color: safeOptionColor(option.color),
    })),
    { key: EMPTY_BOARD_LANE, rows: [], label: null, color: null },
  ]
}

/**
 * The "Group" page of a board's settings: what it groups by, how the columns are
 * sorted, whether empty ones and colours show, and the list of columns itself, which
 * can be reordered by hand and hidden one by one.
 */
export function GroupSettingsPage({
  groupProperty,
  sort,
  hideEmpty,
  colorColumns,
  order,
  hidden,
  disabled = false,
  onOpenGroupBy,
  onOpenSort,
  onHideEmptyChange,
  onColorColumnsChange,
  onOrderChange,
  onHiddenChange,
}: GroupSettingsPageProps) {
  const { t } = useTranslation()
  const groups = React.useMemo(
    () =>
      groupListOrder(naturalGroups(groupProperty), {
        sort,
        order,
        hidden: [],
        hideEmpty: false,
      }),
    [groupProperty, order, sort],
  )
  // The list follows the drag at once; the order is saved when the row is let go.
  const [draft, setDraft] = React.useState(groups)
  React.useEffect(() => setDraft(groups), [groups])
  const hiddenSet = React.useMemo(() => new Set(hidden), [hidden])
  const manual = sort === "manual"

  const labelOf = (lane: BoardLane) => lane.label ?? t("databaseBoard.empty")
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset
    if (target < 0 || target >= draft.length) return
    const next = [...draft]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    setDraft(next)
    onOrderChange(next.map((lane) => lane.key))
  }
  const toggle = (key: string) =>
    onHiddenChange(hiddenSet.has(key) ? hidden.filter((entry) => entry !== key) : [...hidden, key])
  const allHidden = groups.length > 0 && groups.every((lane) => hiddenSet.has(lane.key))

  return (
    <div className="space-y-0.5">
      <Row
        label={t("databaseWorkspace.groupBy")}
        value={groupProperty?.name ?? t("databaseWorkspace.groupByNone")}
        chevron
        onClick={onOpenGroupBy}
      />
      <Row
        label={t("databaseWorkspace.groupSort")}
        value={t(`databaseWorkspace.groupSorts.${sort}`)}
        chevron
        disabled={disabled}
        onClick={onOpenSort}
      />
      <SwitchRow
        label={t("databaseWorkspace.hideEmptyGroups")}
        checked={hideEmpty}
        disabled={disabled}
        onChange={onHideEmptyChange}
      />
      <SwitchRow
        label={t("databaseWorkspace.colorColumns")}
        checked={colorColumns}
        disabled={disabled}
        onChange={onColorColumnsChange}
      />

      {groups.length > 0 && (
        <section className="mt-1.5 border-t border-border/60 pt-2">
          <div className="flex items-center justify-between px-2.5 pb-1.5 text-xs">
            <span className="font-medium text-muted-foreground">
              {t("databaseWorkspace.groupsList")}
            </span>
            <button
              type="button"
              className="text-primary hover:underline disabled:opacity-50"
              disabled={disabled}
              onClick={() => onHiddenChange(allHidden ? [] : groups.map((lane) => lane.key))}
            >
              {allHidden
                ? t("databaseWorkspace.showAllProperties")
                : t("databaseWorkspace.hideAllProperties")}
            </button>
          </div>
          {!manual && (
            <p className="px-2.5 pb-1.5 text-xs leading-snug text-muted-foreground">
              {t("databaseWorkspace.groupOrderManualHint")}
            </p>
          )}
          <Reorder.Group axis="y" values={draft} onReorder={setDraft} className="space-y-0.5">
            {draft.map((lane, index) => {
              const isHidden = hiddenSet.has(lane.key)
              return (
                <ReorderableRow
                  key={lane.key}
                  value={lane}
                  disabled={disabled || !manual}
                  onMove={(offset) => move(index, offset)}
                  onDropped={() => onOrderChange(draft.map((entry) => entry.key))}
                  className="min-h-8 gap-1.5 rounded-lg px-1 hover:bg-accent"
                >
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate rounded-md px-2 py-0.5 text-[13px]",
                      isHidden && "opacity-50",
                    )}
                    style={
                      lane.color
                        ? {
                            backgroundColor: `color-mix(in srgb, ${lane.color} 22%, transparent)`,
                          }
                        : undefined
                    }
                  >
                    {labelOf(lane)}
                  </span>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={!isHidden}
                    aria-label={`${isHidden ? t("databaseWorkspace.showGroup") : t("databaseWorkspace.hideGroup")}: ${labelOf(lane)}`}
                    title={
                      isHidden ? t("databaseWorkspace.showGroup") : t("databaseWorkspace.hideGroup")
                    }
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                    onClick={() => toggle(lane.key)}
                  >
                    {isHidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </ReorderableRow>
              )
            })}
          </Reorder.Group>
        </section>
      )}
    </div>
  )
}
