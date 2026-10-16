import { useTranslation } from "react-i18next"
import type { WorkshopSectionSummary, WorkshopSummary } from "@/lib/storage"
import { useDatabaseStore } from "../database/database-store"
import { useCreateInScope } from "./workshop/use-create-in-scope"
import type { ScopeData } from "./workshop/use-scope-data"
import { WorldCards, type WorldCard } from "./workshop/world-cards"
import type { PanelFilter } from "./workshop/workshop-model"

interface ScopedSectionProps {
  workshop: WorkshopSummary
  section: WorkshopSectionSummary
  /** The story, the universe or the standalone stories whose pages the list shows. */
  scope: PanelFilter
  data: ScopeData
  onOpenNote: (noteId: string) => void
  /** Opens the whole database of the section (every story's pages), on the workshop's page. */
  onOpenWhole: (sectionId: string) => void
}

/**
 * One section as a page of a story, a universe or the standalone stories shows it: only the pages
 * that belong here (the panel's rule), not the whole shared database. The whole database is one
 * button away, on the page of the workshop.
 */
export function ScopedSection({
  workshop,
  section,
  scope,
  data,
  onOpenNote,
  onOpenWhole,
}: ScopedSectionProps) {
  const { t } = useTranslation()
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const createFor = useCreateInScope(workshop, scope)
  const list = data.lists.find((candidate) => candidate.section.id === section.id)
  const cards: WorldCard[] = [
    { owner: workshop, section, rows: list?.shown ?? [] },
    ...(list && list.withoutStory.length > 0
      ? [
          {
            owner: workshop,
            section,
            rows: list.withoutStory,
            title: t("creative.workshop.noStory"),
          },
        ]
      : []),
  ]
  return (
    <div className="mb-8 flex w-full min-w-0 max-w-3xl flex-col gap-3">
      {data.failed && (
        <p role="alert" className="text-xs text-destructive">
          {t("creative.workshop.loadFailed")}
        </p>
      )}
      <WorldCards
        cards={cards}
        loading={data.loading}
        vaultGeneration={vaultGeneration}
        onOpenNote={onOpenNote}
        onOpenSection={(_ownerId, sectionId) => onOpenWhole(sectionId)}
        openLabel={t("creative.page.openWhole")}
        limit={Infinity}
        createFor={(card) => (card.title ? null : createFor(card.section))}
      />
    </div>
  )
}
