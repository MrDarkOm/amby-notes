import * as React from "react"
import {
  createWorkshopEntity,
  type WorkshopSectionSummary,
  type WorkshopSummary,
} from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"
import { useCreativeNavStore } from "../creative-nav-store"
import type { PanelFilter } from "./workshop-model"

/**
 * Where a page can be made from the page of a story or of the standalone stories: the call that
 * makes it in a section under a typed name, or `null` where it cannot. In a story the page is born
 * linked to it (the section needs its "Stories" relation); among the standalone stories it is born
 * with no story, which is the group "No story". A universe has no story of its own, so none is
 * made from its page. The lists read again after the write, a failed one as well.
 */
export function useCreateInScope(
  workshop: WorkshopSummary | null,
  filter: PanelFilter | null,
): (section: WorkshopSectionSummary) => ((title: string) => Promise<void>) | null {
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const bumpData = useCreativeNavStore((state) => state.bumpData)
  return React.useCallback(
    (section) => {
      if (!workshop || workshop.readOnly || vaultGeneration === null || filter === null) return null
      if (filter.kind === "universe") return null
      if (filter.kind === "story" && !section.storiesPropertyId) return null
      const storyId = filter.kind === "story" ? filter.storyId : null
      return async (title: string) => {
        try {
          await createWorkshopEntity({
            expectedGeneration: vaultGeneration,
            workshopId: workshop.workshopId,
            sectionId: section.id,
            title,
            storyId,
          })
        } finally {
          bumpData()
        }
      }
    },
    [bumpData, filter, vaultGeneration, workshop],
  )
}
