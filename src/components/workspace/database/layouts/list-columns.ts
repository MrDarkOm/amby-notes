import type { DatabasePropertySummary, DatabaseRow } from "@/lib/storage"
import { formatRowProperties } from "../value-format"

const AUTO_COLUMNS = 3

/**
 * The properties shown as columns at the right of every row. A list chosen in
 * the view wins; otherwise the first few properties that have a value in any
 * loaded row, so the columns line up instead of changing from row to row.
 */
export function listColumns(
  rows: DatabaseRow[],
  properties: DatabasePropertySummary[],
  cardFields: string[] | null,
): string[] {
  if (cardFields) return cardFields
  const used = new Set<string>()
  for (const row of rows) {
    for (const shown of formatRowProperties(row.valuesJson, properties)) used.add(shown.propertyId)
  }
  return properties
    .filter((property) => used.has(property.propertyId))
    .slice(0, AUTO_COLUMNS)
    .map((property) => property.propertyId)
}
