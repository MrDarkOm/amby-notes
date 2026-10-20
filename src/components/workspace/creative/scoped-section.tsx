import * as React from "react"
import { useTranslation } from "react-i18next"
import type { DatabaseRow, WorkshopSectionSummary, WorkshopSummary } from "@/lib/storage"
import { SectionGallery } from "./pages/section-gallery"
import { sharedInUniverse } from "./pages/scope-model"
import { useCreateInScope } from "./workshop/use-create-in-scope"
import type { ScopeData } from "./workshop/use-scope-data"
import { storyLabels, type PanelFilter } from "./workshop/workshop-model"

interface ScopedSectionProps {
  workshop: WorkshopSummary
  section: WorkshopSectionSummary
  /** The story, the universe or the standalone stories whose pages the list shows. */
  scope: PanelFilter
  data: ScopeData
  onOpenNote: (noteId: string) => void
  /** Opens the whole database of the section (every story's pages), on the workshop's page. */
  onOpenWhole: (sectionId: string) => void
  /** Read mode: no page is made from here. */
  locked?: boolean
}

const NO_ROWS: DatabaseRow[] = []

/**
 * One section as a page of a story, a universe or the standalone stories shows it: only the pages
 * that belong here (the panel's rule), as a gallery with categories, not the whole shared
 * database. The whole database is one button away, on the page of the workshop.
 */
export function ScopedSection({
  workshop,
  section,
  scope,
  data,
  onOpenNote,
  onOpenWhole,
  locked = false,
}: ScopedSectionProps) {
  const { t } = useTranslation()
  const createFor = useCreateInScope(workshop, scope)
  const list = data.lists.find((candidate) => candidate.section.id === section.id)
  const storyLabelsOf = React.useCallback(
    (noteId: string) =>
      storyLabels(
        data.membership.storiesOf(noteId),
        (storyId) => data.stories.find((story) => story.storyId === storyId)?.name,
      ),
    [data.membership, data.stories],
  )
  // A universe's page shows what belongs to the universe as a whole: a page held by two or more
  // of its stories. A page of one story is on that story's page. The universe's events are its own.
  const shownRows = list?.shown ?? NO_ROWS
  const sharedOnly = scope.kind === "universe" && section.role !== "anchors"
  const split = React.useMemo(
    () =>
      sharedOnly
        ? sharedInUniverse(
            shownRows,
            data.membership,
            data.stories.map((story) => story.storyId),
          )
        : null,
    [data.membership, data.stories, shownRows, sharedOnly],
  )
  // A page of a story names no other story: its card would only repeat the page's own place.
  const chips = scope.kind === "story" ? undefined : storyLabelsOf
  return (
    <div className="mb-8 flex w-full min-w-0 flex-col gap-6">
      {data.failed && (
        <p role="alert" className="text-xs text-destructive">
          {t("creative.workshop.loadFailed")}
        </p>
      )}
      <SectionGallery
        section={section}
        rows={split ? split.shared : shownRows}
        loading={data.loading}
        storyLabelsOf={chips}
        onOpenNote={onOpenNote}
        onOpenAsBase={() => onOpenWhole(section.id)}
        openLabel={t("creative.page.openWhole")}
        createFor={locked ? null : createFor(section)}
        footnote={
          split && split.hidden > 0 ? t("creative.scope.onlyOneStory", { n: split.hidden }) : null
        }
      />
      {list && list.withoutStory.length > 0 && (
        <SectionGallery
          section={section}
          rows={list.withoutStory}
          title={t("creative.workshop.noStory")}
          loading={data.loading}
          onOpenNote={onOpenNote}
        />
      )}
    </div>
  )
}
