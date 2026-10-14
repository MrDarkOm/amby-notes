import * as React from "react"
import { Anchor, BookOpen } from "lucide-react"
import { useTranslation } from "react-i18next"
import { createWorkshopEntity, type WorkshopSummary } from "@/lib/storage"
import { useDatabaseStore } from "../database/database-store"
import { useCreativeNavStore } from "./creative-nav-store"
import { projectErrorText } from "./project-error"
import { universeEvents } from "./workshop/plot-views"
import { QuickCreate } from "./workshop/quick-create"
import { useAnchorOrder } from "./workshop/use-anchor-order"
import { useDatabaseRows } from "./workshop/use-database-rows"
import { WorldCards, type WorldCard } from "./workshop/world-cards"
import {
  buildMembership,
  entityItemsOf,
  entityTabs,
  relationTargetsOf,
  scopeEntities,
  storySection,
} from "./workshop/workshop-model"

interface UniverseDeskProps {
  workshop: WorkshopSummary
  /** The note ID of the universe's card. */
  universeId: string
  onOpenNote: (noteId: string) => void
  onOpenStory: (storyId: string) => void
  /** Opens a section as a table. */
  onOpenSection?: (ownerId: string, sectionId: string) => void
  /**
   * Makes the anchors' "Universe" relation when the anchors lack it (`ensure_plot_links`); an event
   * cannot name its universe without it. Rejects on failure, and the failure is shown.
   */
  onEnsureAnchorLinks?: (workshopId: string) => Promise<void>
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
  onEnsureAnchorLinks,
}: UniverseDeskProps) {
  const { t } = useTranslation()
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const bumpData = useCreativeNavStore((state) => state.bumpData)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const anchorsSection = storySection(workshop, "anchors")

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
      ...(anchorsSection ? [anchorsSection.databaseId] : []),
      ...workshop.stories.flatMap((story) => (story.databaseId ? [story.databaseId] : [])),
      ...worldTabs.map((tab) => tab.databaseId),
    ],
    [anchorsSection, storiesSection, workshop.stories, worldTabs],
  )
  const data = useDatabaseRows(databaseIds, dataNonce)

  // The events of the universe: anchors that name it in their own "Universe" relation.
  const anchorOrder = useAnchorOrder(anchorsSection?.databaseId, dataNonce)
  const events = React.useMemo(() => {
    const property = anchorsSection?.universePropertyId
    const rows = anchorsSection ? (data.rows[anchorsSection.databaseId] ?? []) : []
    if (!property) return []
    const named = new Map(
      rows.map((row) => [row.noteId, relationTargetsOf(row.valuesJson, property)[0] ?? null]),
    )
    return universeEvents({
      anchors: rows,
      universeId,
      universeOf: (noteId) => named.get(noteId) ?? null,
      manualOrder: anchorOrder.order,
      createdOf: (noteId) => anchorOrder.created[noteId],
    })
  }, [anchorOrder.created, anchorOrder.order, anchorsSection, data.rows, universeId])
  const canCreateEvent =
    Boolean(anchorsSection) &&
    !workshop.readOnly &&
    vaultGeneration !== null &&
    workshop.sections.some((section) => section.role === "universes" && section.state !== "missing")
  const createEvent = async (title: string) => {
    if (!anchorsSection || vaultGeneration === null) return
    try {
      // The relation first (a failure stops here and is shown), then the anchor with its universe
      // in one write.
      await onEnsureAnchorLinks?.(workshop.workshopId)
      await createWorkshopEntity({
        expectedGeneration: vaultGeneration,
        workshopId: workshop.workshopId,
        sectionId: anchorsSection.id,
        title,
        universeId,
      })
    } finally {
      bumpData()
    }
  }

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
      {anchorsSection && (
        <section
          aria-label={t("creative.plot.events.group")}
          className="rounded-2xl border border-border bg-card p-5"
        >
          <h2 className="mb-2 text-sm font-semibold">{t("creative.plot.events.group")}</h2>
          {events.length === 0 ? (
            <p className="mb-1 text-xs text-muted-foreground">
              {loading ? "" : t("creative.plot.events.empty")}
            </p>
          ) : (
            <ul className="mb-1 grid gap-0.5 sm:grid-cols-2 xl:grid-cols-3">
              {events.map((event) => (
                <li key={event.noteId} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => onOpenNote(event.noteId)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
                  >
                    <Anchor className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{event.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {canCreateEvent && (
            <QuickCreate
              label={t("creative.plot.events.create")}
              placeholder={t("creative.plot.events.placeholder")}
              failed={(message) => t("creative.plot.events.failed", { message })}
              onCreate={createEvent}
              describe={(caught) => projectErrorText(t, caught)}
            />
          )}
        </section>
      )}
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
