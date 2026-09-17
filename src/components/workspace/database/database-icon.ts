const SYSTEM_ITEM_ICONS = new Set([
  "folder",
  "file",
  "supernote",
  "supercanvas",
  "supersketch",
  "superdatabase",
  "page",
  "workspace",
  "canvas",
  "sketch",
  "database",
  "draft",
  "brain",
])

/**
 * Tree items use a few plain strings as internal icon markers. They are useful
 * in the sidebar, but a database heading must fall back to its database icon
 * rather than rendering a marker such as "file" as text.
 */
export function normalizeDatabaseIcon(value?: string | null) {
  if (!value || SYSTEM_ITEM_ICONS.has(value)) return undefined
  return value
}
