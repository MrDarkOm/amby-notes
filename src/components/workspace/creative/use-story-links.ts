import * as React from "react"
import { useTranslation } from "react-i18next"
import { addStoryLinks, type WorkshopSummary } from "@/lib/storage"
import { useDatabaseStore } from "../database/database-store"
import type { CreatedItemResult } from "./create-project-dialog"
import { linkLabels } from "./project-labels"
import { useProjectStore } from "./project-store"
import { writeStoryUniverseLink } from "./story-universe-link"

export interface StoryLinks {
  /** Adds the "Stories" / "Universe" relation to a section and reads the catalog again. */
  addLinks: (
    target: WorkshopSummary,
    sectionId: string,
    generation: number,
  ) => Promise<{ propertyId: string }>
  /**
   * Puts a story just made into a universe: the "Universe" relation of the stories section is made
   * when the workshop lacks it, then written into the story's card. Rejects on any failure; the
   * story itself is never touched, so the caller says why it stays among the standalone ones.
   */
  putStoryInUniverse: (
    created: CreatedItemResult,
    universeId: string,
    workshopId: string,
  ) => Promise<void>
}

/**
 * The writes that belong a story to a universe, shared by the panel and the pages of a universe.
 * One operation ID per link intent, so a retry of the same request is answered from the record.
 */
export function useStoryLinks(onChanged?: () => Promise<void>): StoryLinks {
  const { t } = useTranslation()
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const operations = React.useRef(new Map<string, string>())

  const addLinks = React.useCallback(
    async (target: WorkshopSummary, sectionId: string, generation: number) => {
      const key = `${target.workshopId}:${target.fileRevision}:${sectionId}`
      let operationId = operations.current.get(key)
      if (!operationId) {
        operationId = `links-${crypto.randomUUID()}`
        operations.current.set(key, operationId)
      }
      const added = await addStoryLinks({
        expectedGeneration: generation,
        operationId,
        workshopId: target.workshopId,
        expectedWorkshopRevision: target.fileRevision,
        sectionId,
        labels: linkLabels(t),
      })
      await onChanged?.()
      await useProjectStore.getState().refresh?.()
      return added
    },
    [onChanged, t],
  )

  const putStoryInUniverse = React.useCallback(
    async (created: CreatedItemResult, universeId: string, workshopId: string) => {
      if (vaultGeneration === null) throw new Error(t("creative.errors.projectNotFound"))
      const workshopNow = () =>
        useProjectStore.getState().catalog?.workshops.find((w) => w.workshopId === workshopId)
      const current = workshopNow()
      const stories = current?.sections.find((s) => s.role === "stories" && s.state !== "missing")
      if (!current || !stories) throw new Error(t("creative.errors.projectNotFound"))
      const propertyId =
        stories.universePropertyId ??
        (await addLinks(current, stories.id, vaultGeneration)).propertyId
      const cardNoteId =
        created.cardNoteId ??
        workshopNow()?.stories.find((story) => story.storyId === created.id)?.cardNoteId
      if (!cardNoteId) throw new Error(t("creative.errors.projectNotFound"))
      await writeStoryUniverseLink({
        vaultGeneration,
        databaseId: stories.databaseId,
        cardNoteId,
        propertyId,
        universeId,
      })
    },
    [addLinks, t, vaultGeneration],
  )

  return { addLinks, putStoryInUniverse }
}
