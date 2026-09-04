import type { DatabaseFieldRef, DatabaseRow } from "@/lib/storage"

export const EMPTY_BOARD_LANE = "__empty__"
export const ALL_BOARD_LANE = "__all__"

export interface BoardLane {
  key: string
  rows: DatabaseRow[]
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

export function groupBoardRows(rows: DatabaseRow[], field: DatabaseFieldRef | null): BoardLane[] {
  if (!field || field.kind !== "property") return [{ key: ALL_BOARD_LANE, rows }]
  const lanes = new Map<string, DatabaseRow[]>()
  for (const row of rows) {
    const key = fieldValue(row, field) ?? EMPTY_BOARD_LANE
    lanes.set(key, [...(lanes.get(key) ?? []), row])
  }
  return [...lanes.entries()].map(([key, groupedRows]) => ({ key, rows: groupedRows }))
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
