/** Property types that have something to set. */
const WITH_SETTINGS = new Set([
  "number",
  "date",
  "select",
  "multiSelect",
  "status",
  "formula",
  "relation",
  "rollup",
])

export function hasPropertySettings(propertyType: string): boolean {
  return WITH_SETTINGS.has(propertyType)
}

/** The settings of a Relation that are chosen together and applied as one change. */
export interface RelationConfigState {
  targetDatabaseId: string
  /** `1` for a single page, `null` for no limit. */
  maxItems: number | null
  /** Whether the other database also gets a property pointing back. */
  twoWay: boolean
  inversePropertyName: string
}
