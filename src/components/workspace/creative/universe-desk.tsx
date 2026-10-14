import * as React from "react"
import { BookOpen } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { WorkshopSummary } from "@/lib/storage"
import { useDatabaseStore } from "../database/database-store"
import { useCreativeNavStore } from "./creative-nav-store"
import { useDatabaseRows } from "./workshop/use-database-rows"
import { WorldCards, type WorldCard } from "./workshop/world-cards"
import {
  buildMembership,
  entityItemsOf,
  entityTabs,
  scopeEntities,
} from "./workshop/workshop-model"

interface UniverseDeskProps {
  workshop: WorkshopSummary
  /** The note ID of the universe's card. */
  universeId: string
  onOpenNote: (noteId: string) => void
  onOpenStory: (storyId: string) => void
  /** Opens a section as a table. */
  onOpenSection?: (ownerId: string, sectionId: string) => void
}

/**
 * The page of a universe: the stories that belong to it and the world beside them. A page is in
 * the universe through any of its stories (named in the "Stories" relation or in the story's text),
 * the same rule the panel uses.
 */
export function UniverseDesk({
  workshop,
  universeId,
  onOpenNote,
  onOpenStory,
  onOpenSection,
}: UniverseDeskProps) {
  const { t } = useTranslation()
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)

  const worldTabs = React.useMemo(
    () => entityTabs(workshop).filter((tab) => tab.role !== "universes"),
    [workshop],
  )
  const storiesSection = workshop.sections.find(
    (section) => section.role === "stories" && section.state !== "missing",
  )
  const databaseIds = React.useMemo(
    () => [
      ...(storiesSection ? [storiesSection.databaseId] : []),
      ...workshop.stories.flatMap((story) => (story.databaseId ? [story.databaseId] : [])),
      ...worldTabs.map((tab) => tab.databaseId),
    ],
    [storiesSection, workshop.stories, worldTabs],
  )
  const data = useDatabaseRows(databaseIds, dataNonce)

  const { universeStories, cards } = React.useMemo(() => {
    const membership = buildMembership({
      stories: workshop.stories,
      sections: workshop.sections,
      rows: data.rows,
    })
    const filter = { kind: "universe", universeId } as const
    const inUniverse = workshop.stories.filter(
      (story) => membership.universeOf(story.storyId) === universeId,
    )
    const worldCards: WorldCard[] = []
    for (const tab of worldTabs) {
      const section = workshop.sections.find((candidate) => candidate.id === tab.sectionId)
      if (!section) continue
      const rows = data.rows[section.databaseId] ?? []
      const keep = new Set(
        scopeEntities(
          entityItemsOf(rows, section.databaseId, workshop.workshopId),
          filter,
          membership,
        ).shown.map((item) => item.noteId),
      )
      worldCards.push({ owner: workshop, section, rows: rows.filter((r) => keep.has(r.noteId)) })
    }
    return { universeStories: inUniverse, cards: worldCards }
  }, [data.rows, universeId, workshop, worldTabs])

  const loading = data.status === "loading"
  return (
    <div className="mb-8 flex w-full flex-col gap-5">
      <section
        aria-label={t("creative.page.stories")}
        className="rounded-2xl border border-border bg-card p-5"
      >
        <h2 className="mb-2 text-sm font-semibold">{t("creative.page.stories")}</h2>
        {universeStories.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {loading ? "" : t("creative.page.universe.noStories")}
          </p>
        ) : (
          <ul className="grid gap-0.5 sm:grid-cols-2 xl:grid-cols-3">
            {universeStories.map((story) => (
              <li key={story.storyId} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onOpenStory(story.storyId)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
                >
                  <BookOpen className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{story.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="grid items-start gap-5 md:grid-cols-2">
        <WorldCards
          cards={cards}
          loading={loading}
          vaultGeneration={vaultGeneration}
          onOpenNote={onOpenNote}
          onOpenSection={onOpenSection}
        />
      </div>
    </div>
  )
}
