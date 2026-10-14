import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  ensurePlotLinks,
  type EnsuredPlotLinks,
  type PlotLinksTarget,
  type StorySummary,
  type WorkshopSummary,
} from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"
import { linkLabels } from "../project-labels"
import { useProjectStore } from "../project-store"
import { anchorLinksMissing } from "./plot-views"
import type { EnsurePlot } from "./use-plot-binding"

export interface PlotEnsurer {
  /** Makes the missing link properties of a story's text or of the anchors (`ensure_plot_links`). */
  ensure: EnsurePlot
  /**
   * Makes the anchors' own "Arcs" and "Universe" relations if the workshop (read fresh from the
   * catalog) lacks any it could have. A failure rejects: the caller shows it.
   */
  ensureAnchorLinks: (workshopId: string) => Promise<void>
}

/**
 * The operation that makes the properties anchors and arcs are bound with, shared by everything
 * that needs them (the panel, the pages of a universe and of a story). One operation ID per
 * request, so a retry of the same request is answered from the record; the catalog is read again
 * after a change, so the lists see the new properties.
 */
export function usePlotEnsurer(onChanged?: () => Promise<void>): PlotEnsurer {
  const { t } = useTranslation()
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const operations = React.useRef(new Map<string, string>())

  const ensure = React.useCallback(
    async (request: {
      target: PlotLinksTarget
      workshop: WorkshopSummary
      story?: StorySummary
    }): Promise<EnsuredPlotLinks> => {
      if (vaultGeneration === null) throw new Error(t("creative.errors.vaultChanged"))
      const { target, workshop: owner, story } = request
      const expectedRevision = target === "story" ? story?.fileRevision : owner.fileRevision
      if (!expectedRevision) throw new Error(t("creative.errors.projectNotFound"))
      const key = `${target}:${owner.workshopId}:${story?.storyId ?? ""}:${expectedRevision}`
      let operationId = operations.current.get(key)
      if (!operationId) {
        operationId = `plot-${crypto.randomUUID()}`
        operations.current.set(key, operationId)
      }
      const ensured = await ensurePlotLinks({
        expectedGeneration: vaultGeneration,
        operationId,
        workshopId: owner.workshopId,
        target,
        storyId: story?.storyId ?? null,
        expectedRevision,
        labels: linkLabels(t),
      })
      if (ensured.changed) {
        await onChanged?.()
        await useProjectStore.getState().refresh?.()
      }
      return ensured
    },
    [onChanged, t, vaultGeneration],
  )

  const ensureAnchorLinks = React.useCallback(
    async (workshopId: string) => {
      const workshop = useProjectStore
        .getState()
        .catalog?.workshops.find((candidate) => candidate.workshopId === workshopId)
      if (!workshop || workshop.readOnly || !anchorLinksMissing(workshop)) return
      await ensure({ target: "anchors", workshop })
    },
    [ensure],
  )

  return { ensure, ensureAnchorLinks }
}
