import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  updateDatabaseRelationValue,
  type DatabaseRow,
  type EnsuredPlotLinks,
  type PlotLinksTarget,
  type StorySummary,
  type WorkshopSummary,
} from "@/lib/storage"
import { logger } from "@/lib/logger"
import { projectErrorText } from "../project-error"
import type { PlotKind } from "./plot-model"
import { anchorLinksMissing } from "./plot-views"
import { relationTargetsOf } from "./workshop-model"

/** The operation that makes the missing link properties; it reads the catalog again after it. */
export type EnsurePlot = (request: {
  target: PlotLinksTarget
  workshop: WorkshopSummary
  story?: StorySummary
}) => Promise<EnsuredPlotLinks>

export interface PlotBinding {
  /** Binds an anchor or an arc to a page of the shown story; the other bindings stay. */
  bind: (pageId: string, kind: PlotKind, targetId: string) => Promise<void>
  /** Takes a binding away; the others stay. */
  unbind: (pageId: string, kind: PlotKind, targetId: string) => Promise<void>
  /** The failure of the last action and the row it belongs to (the page, or the anchor or arc). */
  error: { rowId: string; message: string } | null
  clearError: () => void
}

/**
 * Anchors and arcs are bound to the pages of a story's text: the page keeps their note IDs in a
 * relation of its own database (W9). The relation exists only once the anchors or arcs database
 * does, and a story made before that has none, so the first binding asks the backend to make what
 * is missing (`ensure_plot_links`, once per property) and then writes the value.
 *
 * Writing goes through the relation edit of the database layer with the page's complete list of
 * targets, read from the row on screen, so the other bindings are kept; a page that changed in
 * the meantime is refused by its revision, and the failure stays on the row it came from.
 */
export function usePlotBinding({
  workshop,
  story,
  rows,
  vaultGeneration,
  ensure,
  onChanged,
}: {
  workshop: WorkshopSummary | null
  story: StorySummary | null
  rows: Record<string, DatabaseRow[]>
  vaultGeneration: number | null
  ensure: EnsurePlot
  /** Something was written: the lists read the files again. */
  onChanged: () => void
}): PlotBinding {
  const { t } = useTranslation()
  const [error, setError] = React.useState<PlotBinding["error"]>(null)
  // One write at a time per page: a second drop waits for the first, and a page that changed in
  // the meantime is refused by its revision instead of being overwritten.
  const queues = React.useRef(new Map<string, Promise<unknown>>())

  const propertyFor = React.useCallback(
    async (kind: PlotKind): Promise<string> => {
      if (!workshop || !story) throw new Error(t("creative.plot.unavailable"))
      const properties = story.text?.properties
      const known = kind === "anchor" ? properties?.anchors : properties?.arcs
      if (known) return known
      const ensured = await ensure({ target: "story", workshop, story })
      const made = kind === "anchor" ? ensured.anchorsPropertyId : ensured.arcsPropertyId
      if (!made)
        throw new Error(t(kind === "anchor" ? "creative.plot.noAnchors" : "creative.plot.noArcs"))
      // The anchors' own relations are not needed by a binding: a failure there never stops it,
      // but it is not lost either. It is logged here; the places that need the relations (an
      // event of a universe) make them again and show the failure.
      if (anchorLinksMissing(workshop)) {
        await ensure({ target: "anchors", workshop }).catch((caught: unknown) => {
          logger.warn("creative.plot.anchor_links_failed", {
            workshopId: workshop.workshopId,
            error: caught,
          })
        })
      }
      return made
    },
    [ensure, story, t, workshop],
  )

  const write = React.useCallback(
    (pageId: string, kind: PlotKind, targetId: string, add: boolean, rowId: string) => {
      const run = async () => {
        if (!story?.text?.databaseId || vaultGeneration === null) {
          throw new Error(t("creative.plot.unavailable"))
        }
        const databaseId = story.text.databaseId
        const propertyId = await propertyFor(kind)
        const row = rows[databaseId]?.find((candidate) => candidate.noteId === pageId)
        if (!row) throw new Error(t("creative.errors.projectNotFound"))
        const current = relationTargetsOf(row.valuesJson, propertyId)
        const next = add
          ? current.includes(targetId)
            ? current
            : [...current, targetId]
          : current.filter((id) => id !== targetId)
        if (next.length === current.length && next.every((id, index) => id === current[index])) {
          return
        }
        await updateDatabaseRelationValue({
          expectedGeneration: vaultGeneration,
          operationId: `plot-${crypto.randomUUID()}`,
          expectedRevision: row.rowRevision,
          databaseId,
          noteId: pageId,
          propertyId,
          targetNoteIds: next,
        })
      }
      setError(null)
      const prior = queues.current.get(pageId) ?? Promise.resolve()
      const task = prior
        .catch(() => undefined)
        .then(run)
        .catch((caught: unknown) => {
          setError({ rowId, message: projectErrorText(t, caught) })
        })
        .finally(onChanged)
      queues.current.set(pageId, task)
      return task
    },
    [onChanged, propertyFor, rows, story, t, vaultGeneration],
  )

  return {
    bind: (pageId, kind, targetId) => write(pageId, kind, targetId, true, pageId),
    unbind: (pageId, kind, targetId) => write(pageId, kind, targetId, false, targetId),
    error,
    clearError: () => setError(null),
  }
}
