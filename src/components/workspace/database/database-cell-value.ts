export type StoredDatabaseCellValue = Record<string, unknown> | null

export function readDatabaseCellValue(
  valuesJson: string,
  propertyId: string,
): StoredDatabaseCellValue {
  try {
    const values = JSON.parse(valuesJson) as Record<string, unknown>
    const value = values[propertyId]
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A row's values with one cell replaced (or cleared), as the editors would see it. */
export function applyCellValue(valuesJson: string, propertyId: string, valueJson?: string): string {
  let values: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(valuesJson)
    values = parsed && typeof parsed === "object" ? { ...(parsed as Record<string, unknown>) } : {}
  } catch {
    values = {}
  }
  if (valueJson) {
    try {
      values[propertyId] = JSON.parse(valueJson)
    } catch {
      return valuesJson
    }
  } else {
    delete values[propertyId]
  }
  return JSON.stringify(values)
}

export function databaseCellText(value: StoredDatabaseCellValue, propertyType: string): string {
  if (!value) return ""
  if (propertyType === "number") return typeof value.decimal === "string" ? value.decimal : ""
  if (propertyType === "date") return typeof value.start === "string" ? value.start : ""
  return typeof value.value === "string" ? value.value : ""
}

export function encodeDatabaseCellDraft(propertyType: string, draft: string): string | undefined {
  if (!draft) return undefined
  if (propertyType === "number") return JSON.stringify({ type: "number", decimal: draft })
  if (propertyType === "date") {
    return JSON.stringify({ type: "date", start: draft, end: null, timeZone: null })
  }
  return JSON.stringify({ type: propertyType, value: draft })
}
