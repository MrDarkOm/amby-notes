import type { DatabaseFieldRef, DatabasePropertySummary, DatabaseRow } from "@/lib/storage"
import { safeOptionColor } from "../value-format"

export const EMPTY_BOARD_LANE = "__empty__"
export const ALL_BOARD_LANE = "__all__"

export interface BoardLane {
  key: string
  rows: DatabaseRow[]
  /** Option name; `null` for the no-value lane and for options missing from the schema. */
  label: string | null
  color: string | null
  /** Rows in the whole view; the loaded `rows` may be fewer. */
  count?: number
  hasMore?: boolean
  status?: "loading" | "ready" | "loadingMore" | "error"
}

function fieldValue(row: DatabaseRow, field: DatabaseFieldRef | null): string | null {
  if (!field || field.kind !== "property") return null
  let values: unknown
  try {
    values = JSON.parse(row.valuesJson)
  } catch {
    return null
  }
  const value =
    values && typeof values === "object"
      ? (values as Record<string, unknown>)[field.propertyId]
      : null
  if (!value || typeof value !== "object") return null
  const typed = value as { type?: unknown; optionId?: unknown }
  if ((typed.type !== "select" && typed.type !== "status") || typeof typed.optionId !== "string")
    return null
  return typed.optionId || null
}

/**
 * Lanes follow the property's options in schema order, empty ones included, so
 * the board does not depend on which rows happen to be loaded. Values naming an
 * option that no longer exists get their own lane after the schema lanes, and
 * the no-value lane always comes last. Without a Select/Status schema the lanes
 * are derived from the loaded rows only.
 */
export function groupBoardRows(
  rows: DatabaseRow[],
  field: DatabaseFieldRef | null,
  properties?: DatabasePropertySummary[],
): BoardLane[] {
  if (!field || field.kind !== "property") {
    return [{ key: ALL_BOARD_LANE, rows, label: null, color: null }]
  }
  const property = properties?.find((candidate) => candidate.propertyId === field.propertyId)
  const schemaBacked =
    property && (property.propertyType === "select" || property.propertyType === "status")
  const grouped = new Map<string, DatabaseRow[]>()
  for (const row of rows) {
    const key = fieldValue(row, field) ?? EMPTY_BOARD_LANE
    grouped.set(key, [...(grouped.get(key) ?? []), row])
  }
  if (!schemaBacked) {
    return [...grouped.entries()].map(([key, laneRows]) => ({
      key,
      rows: laneRows,
      label: null,
      color: null,
    }))
  }
  const lanes: BoardLane[] = property.options.map((option) => ({
    key: option.optionId,
    rows: grouped.get(option.optionId) ?? [],
    label: option.name,
    color: safeOptionColor(option.color),
  }))
  const known = new Set(property.options.map((option) => option.optionId))
  for (const [key, laneRows] of grouped) {
    if (key !== EMPTY_BOARD_LANE && !known.has(key)) {
      lanes.push({ key, rows: laneRows, label: null, color: null })
    }
  }
  lanes.push({
    key: EMPTY_BOARD_LANE,
    rows: grouped.get(EMPTY_BOARD_LANE) ?? [],
    label: null,
    color: null,
  })
  return lanes
}

export function moveRowToBoardLane(
  rows: DatabaseRow[],
  noteId: string,
  field: DatabaseFieldRef,
  laneKey: string,
): DatabaseRow[] {
  if (field.kind !== "property" || laneKey === ALL_BOARD_LANE) return rows
  return rows.map((row) => {
    if (row.noteId !== noteId) return row
    let values: unknown
    try {
      values = JSON.parse(row.valuesJson)
    } catch {
      return row
    }
    if (!values || typeof values !== "object") return row
    const current = (values as Record<string, unknown>)[field.propertyId]
    if (!current || typeof current !== "object") return row
    const typed = current as { type?: unknown; optionId?: unknown }
    if (typed.type !== "select" && typed.type !== "status") return row
    const nextValues = { ...(values as Record<string, unknown>) }
    nextValues[field.propertyId] = {
      ...(current as Record<string, unknown>),
      optionId: laneKey === EMPTY_BOARD_LANE ? "" : laneKey,
    }
    return { ...row, valuesJson: JSON.stringify(nextValues) }
  })
}

export interface GroupDisplay {
  sort: "manual" | "alphabetical" | "reverseAlphabetical"
  /** The manual order of the columns (keys). */
  order: string[]
  /** Columns left out. */
  hidden: string[]
  /** Leave out columns with no cards. */
  hideEmpty: boolean
}

/**
 * The columns as the view shows them: hidden and (optionally) empty ones left out,
 * the rest ordered manually or by name. A column the manual order does not know
 * (a new option) goes after the known ones; the no-value column stays where it was
 * when sorting by name, so a name sort never moves it into the middle.
 */
export function arrangeLanes(lanes: BoardLane[], display: GroupDisplay): BoardLane[] {
  const hidden = new Set(display.hidden)
  const visible = lanes.filter(
    (lane) =>
      !hidden.has(lane.key) && !(display.hideEmpty && (lane.count ?? lane.rows.length) === 0),
  )
  if (display.sort === "manual") {
    if (display.order.length === 0) return visible
    const position = (key: string) => {
      const at = display.order.indexOf(key)
      return at < 0 ? Number.POSITIVE_INFINITY : at
    }
    return visible
      .map((lane, index) => ({ lane, index }))
      .sort((a, b) => position(a.lane.key) - position(b.lane.key) || a.index - b.index)
      .map((entry) => entry.lane)
  }
  const named = visible.filter((lane) => lane.key !== EMPTY_BOARD_LANE)
  const empty = visible.filter((lane) => lane.key === EMPTY_BOARD_LANE)
  const direction = display.sort === "alphabetical" ? 1 : -1
  named.sort((a, b) => direction * (a.label ?? "").localeCompare(b.label ?? ""))
  // The no-value column keeps the end it had in the natural order.
  const lastInNatural = lanes[lanes.length - 1]?.key === EMPTY_BOARD_LANE
  return lastInNatural ? [...named, ...empty] : [...empty, ...named]
}

/** All the view's columns in the order the settings list shows them, hidden ones too. */
export function groupListOrder(lanes: BoardLane[], display: GroupDisplay): BoardLane[] {
  return arrangeLanes(lanes, { ...display, hidden: [], hideEmpty: false })
}
