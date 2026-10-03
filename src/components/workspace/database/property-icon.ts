export function databasePropertyIconKey(databaseId: string, propertyId: string) {
  return `database-property:${databaseId}:${propertyId}`
}

/** Key of a view's chosen icon in the view-state store, next to the property icons. */
export function databaseViewIconKey(databaseId: string, viewId: string) {
  return `database-view:${databaseId}:${viewId}`
}
