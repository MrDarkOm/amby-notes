import * as React from "react"
import { useTranslation } from "react-i18next"
import type { WorkshopSectionSummary, WorkshopSummary } from "@/lib/storage"
import { useCreateInScope } from "../workshop/use-create-in-scope"
import { storyLabels } from "../workshop/workshop-model"
import { SectionGallery } from "./section-gallery"
import { useWorkshopSectionData } from "./use-workshop-section-data"
import { NoticeLine } from "@/components/workspace/notices/notice-line"

interface WorkshopSectionProps {
  workshop: WorkshopSummary
  section: WorkshopSectionSummary
  onOpenStory: (storyId: string) => void
  onOpenNote: (noteId: string) => void
}

/**
 * A section on the workshop's page: every page of the shared database as a gallery with
 * categories, each card naming the stories the page is in. The database itself opens from the
 * button in the tabs row. A page made here belongs to no story yet.
 */
export function WorkshopSection({
  workshop,
  section,
  onOpenNote,
  onOpenStory,
}: WorkshopSectionProps) {
  const { t } = useTranslation()
  const data = useWorkshopSectionData(workshop, section)
  const createFor = useCreateInScope(workshop, { kind: "standalone" })
  const storyLabelsOf = React.useCallback(
    (noteId: string) =>
      storyLabels(
        data.membership.storiesOf(noteId),
        (storyId) => workshop.stories.find((story) => story.storyId === storyId)?.name,
      ),
    [data.membership, workshop.stories],
  )
  return (
    <div className="mb-8 flex w-full min-w-0 flex-col gap-3">
      {data.failed && <NoticeLine role="alert" text={t("creative.workshop.loadFailed")} />}
      <SectionGallery
        section={section}
        workshop={workshop}
        rows={data.rows}
        loading={data.loading}
        storyLabelsOf={storyLabelsOf}
        onOpenNote={onOpenNote}
        storyIdOf={
          section.role === "stories"
            ? (noteId) => workshop.stories.find((story) => story.cardNoteId === noteId)?.storyId
            : undefined
        }
        onOpenStory={onOpenStory}
        createFor={createFor(section)}
      />
    </div>
  )
}
