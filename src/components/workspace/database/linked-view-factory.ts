import { getDatabaseView, type DatabaseSummary } from "@/lib/storage"
import { logger } from "@/lib/logger"
import { isEmbedLayout } from "./embedded-view-model"
import { newLinkedViewId, type LinkedView } from "./linked-block"
import type { DatabaseViewChoice } from "./database-view-picker-model"

/** The parts of a view document a shortcut copies; identity and revision stay behind. */
const COPIED_KEYS = ["fields", "filter", "sorts", "layoutConfig", "group"] as const

function copyConfig(configJson: string): Record<string, unknown> {
  try {
    const doc: unknown = JSON.parse(configJson)
    if (!doc || typeof doc !== "object") return {}
    const source = doc as Record<string, unknown>
    return Object.fromEntries(
      COPIED_KEYS.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
    )
  } catch {
    return {}
  }
}

/**
 * A new tab for a picker choice. Choosing a saved view starts from a private
 * copy of its settings (later changes to either side stay apart); choosing a
 * plain layout starts empty. A view that cannot be read starts empty too: the
 * data is still shown, only the old filter is not carried over.
 */
export async function viewFromChoice(
  choice: DatabaseViewChoice,
  database: DatabaseSummary,
  vaultGeneration: number | null,
): Promise<LinkedView> {
  const saved = database.views.find((view) => view.viewId === choice.viewId)
  const layout = choice.layout ?? saved?.layout
  let config: Record<string, unknown> = {}
  if (saved && vaultGeneration !== null) {
    try {
      const document = await getDatabaseView({
        expectedGeneration: vaultGeneration,
        databaseId: database.databaseId,
        viewId: saved.viewId,
        expectedViewRevision: saved.revision,
      })
      config = copyConfig(document.configJson)
    } catch (error) {
      logger.warn("database.copy_view_failed", {
        databaseId: database.databaseId,
        viewId: saved.viewId,
        error,
      })
    }
  }
  return {
    id: newLinkedViewId(),
    databaseId: database.databaseId,
    // A plain layout has no name of its own; the tab then shows the database's.
    title: choice.layout ? "" : (saved?.title ?? ""),
    layout: isEmbedLayout(layout) ? layout : "table",
    config: choice.layout ? {} : config,
    extra: {},
  }
}
