import type { DatabasePropertySummary, DatabaseRow } from "@/lib/storage"
import {
  databaseCellText,
  parseDatabaseRowValues,
  pickDatabaseCellValue,
} from "./database-cell-value"

export const DEFAULT_ROW_HEIGHT = 40
export const WRAPPED_ROW_HEIGHT = 76
export const OVERSCAN = 8
export const MIN_PROPERTY_WIDTH = 56
export const MIN_TITLE_WIDTH = 80
export const ACTION_COLUMN_WIDTH = "3.5rem"
/** Left of the first column: the grip and the checkbox, outside the table's own borders. */
export const GUTTER_WIDTH = 64
/**
 * Pinning columns is a placeholder for now: the setting is kept in the view untouched, but no
 * column is held while the table scrolls sideways, and the menu item says it is coming.
 */
export const FREEZE_COLUMNS_AVAILABLE = false

export function canFilterType(propertyType: string): boolean {
  return [
    "text",
    "url",
    "number",
    "date",
    "checkbox",
    "select",
    "status",
    "multiselect",
    "multiSelect",
    "relation",
    "files",
  ].includes(propertyType)
}

/** Default width per property from the loaded rows; each row's JSON is parsed once. */
export function defaultPropertyWidths(
  properties: DatabasePropertySummary[],
  rows: DatabaseRow[],
): Map<string, number> {
  const longestWord = (text: string) =>
    text
      .trim()
      .split(/\s+/u)
      .reduce((max, word) => Math.max(max, word.length), 0)
  const longest = new Map<string, number>()
  for (const property of properties) {
    longest.set(
      property.propertyId,
      Math.max(
        longestWord(property.name),
        ...property.options.map((option) => longestWord(option.name)),
      ),
    )
  }
  for (const row of rows) {
    const values = parseDatabaseRowValues(row.valuesJson)
    for (const property of properties) {
      const text = databaseCellText(
        pickDatabaseCellValue(values, property.propertyId),
        property.propertyType,
      )
      if (text) {
        const current = longest.get(property.propertyId) ?? 0
        longest.set(property.propertyId, Math.max(current, longestWord(text)))
      }
    }
  }
  const widths = new Map<string, number>()
  for (const [propertyId, word] of longest) {
    widths.set(propertyId, Math.min(320, Math.max(160, Math.ceil(word * 7.5) + 48)))
  }
  return widths
}

export function defaultTitleWidth(rows: DatabaseRow[]) {
  const longestWord = rows
    .flatMap((row) => row.title.trim().split(/\s+/u))
    .reduce((max, word) => Math.max(max, word.length), "Название".length)
  return Math.min(360, Math.max(MIN_TITLE_WIDTH, Math.ceil(longestWord * 7.5) + 48))
}
