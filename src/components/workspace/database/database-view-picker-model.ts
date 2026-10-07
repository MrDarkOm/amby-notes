import type { DatabaseSummary, DatabaseViewSummary } from "@/lib/storage"
import { EMBED_LAYOUTS, type EmbedLayout } from "./embedded-view-model"

/** A database view a note block can be bound to, optionally shown in another layout. */
export interface DatabaseViewChoice {
  databaseId: string
  viewId: string
  layout?: string
}

/** What a database offers a block: its saved views, then plain layouts. */
export type DatabaseViewOption =
  { kind: "view"; view: DatabaseViewSummary } | { kind: "layout"; layout: EmbedLayout }

export function viewOptions(database: DatabaseSummary): DatabaseViewOption[] {
  return [
    ...database.views.map((view) => ({ kind: "view" as const, view })),
    ...EMBED_LAYOUTS.map((layout) => ({ kind: "layout" as const, layout })),
  ]
}

/**
 * The choice for an option. A saved view is taken with its settings; a plain
 * layout carries `layout` (and so starts with no settings) on the first view,
 * which only anchors the choice to the database.
 */
export function choiceForOption(
  database: DatabaseSummary,
  option: DatabaseViewOption,
): DatabaseViewChoice | null {
  if (option.kind === "view") {
    return { databaseId: database.databaseId, viewId: option.view.viewId }
  }
  const base = defaultView(database)
  if (!base) return null
  return {
    databaseId: database.databaseId,
    viewId: base.viewId,
    layout: option.layout,
  }
}

/** Databases whose title contains the query, in catalog order. Blank query keeps all. */
export function filterDatabases(databases: DatabaseSummary[], query: string): DatabaseSummary[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return databases
  return databases.filter((database) => database.title.toLocaleLowerCase().includes(needle))
}

/** The view a freshly bound block starts on: the database's first saved view. */
export function defaultView(database: DatabaseSummary): DatabaseViewSummary | null {
  return database.views[0] ?? null
}

/** A database can be bound only while it has a view to point at. */
export function isBindable(database: DatabaseSummary): boolean {
  return database.views.length > 0
}
