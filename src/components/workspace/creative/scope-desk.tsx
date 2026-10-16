import { Anchor, BookOpen, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { createWorkshopEntity, type WorkshopSummary } from "@/lib/storage"
import { useDatabaseStore } from "../database/database-store"
import { useCreativeNavStore } from "./creative-nav-store"
import { projectErrorText } from "./project-error"
import { QuickCreate } from "./workshop/quick-create"
import type { ScopeData } from "./workshop/use-scope-data"
import { useCreateInScope } from "./workshop/use-create-in-scope"
import { WorldCards, type WorldCard } from "./workshop/world-cards"
import type { PanelFilter } from "./workshop/workshop-model"

/** The scopes with a desk of their own: a universe, or the stories that no universe holds. */
export type DeskScope = Extract<PanelFilter, { kind: "universe" | "standalone" }>

interface ScopeDeskProps {
  workshop: WorkshopSummary
  scope: DeskScope
  /** What the page lists; read once by the page and shared with its section tabs. */
  data: ScopeData
  onOpenNote: (noteId: string) => void
  onOpenStory: (storyId: string) => void
  /** Opens a section's list in this scope. */
  onOpenSection: (sectionId: string) => void
  /** Starts a new story in this scope; `null` where the workshop cannot be written to. */
  onNewStory: (() => void) | null
  /**
   * Makes the anchors' "Universe" relation when the anchors lack it (`ensure_plot_links`); an event
   * cannot name its universe without it. Rejects on failure, and the failure is shown.
   */
  onEnsureAnchorLinks?: (workshopId: string) => Promise<void>
}

const ROW =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"

/**
 * The overview of a universe or of the standalone stories: the stories that belong here, the
 * universe's events and the world beside them. What belongs to the place is the panel's own rule
 * (`useScopeData`), so the page and the panel never disagree.
 */
export function ScopeDesk({
  workshop,
  scope,
  data,
  onOpenNote,
  onOpenStory,
  onOpenSection,
  onNewStory,
  onEnsureAnchorLinks,
}: ScopeDeskProps) {
  const { t } = useTranslation()
  const bumpData = useCreativeNavStore((state) => state.bumpData)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const createFor = useCreateInScope(workshop, scope)
  const anchorsSection = data.lists.find((list) => list.section.role === "anchors")?.section
  const isUniverse = scope.kind === "universe"

  const canCreateEvent =
    isUniverse &&
    Boolean(anchorsSection) &&
    !workshop.readOnly &&
    vaultGeneration !== null &&
    workshop.sections.some((section) => section.role === "universes" && section.state !== "missing")
  const createEvent = async (title: string) => {
    if (!anchorsSection || scope.kind !== "universe" || vaultGeneration === null) return
    try {
      // The relation first (a failure stops here and is shown), then the anchor with its universe
      // in one write.
      await onEnsureAnchorLinks?.(workshop.workshopId)
      await createWorkshopEntity({
        expectedGeneration: vaultGeneration,
        workshopId: workshop.workshopId,
        sectionId: anchorsSection.id,
        title,
        universeId: scope.universeId,
      })
    } finally {
      bumpData()
    }
  }

  // A universe's events have a block of their own, so the anchors card would only repeat them.
  const cards: WorldCard[] = data.lists
    .filter((list) => !(isUniverse && list.section.role === "anchors"))
    .flatMap((list) => {
      const name = list.section.databaseName?.trim() || list.section.name
      return [
        { owner: workshop, section: list.section, rows: list.shown },
        ...(list.withoutStory.length > 0
          ? [
              {
                owner: workshop,
                section: list.section,
                rows: list.withoutStory,
                title: t("creative.page.noStoryOf", { name }),
              },
            ]
          : []),
      ]
    })

  const loading = data.loading
  return (
    <div className="mb-8 flex w-full min-w-0 flex-col gap-5">
      <section
        aria-label={t("creative.page.stories")}
        className="rounded-2xl border border-border bg-card p-5"
      >
        <h2 className="mb-2 text-sm font-semibold">{t("creative.page.stories")}</h2>
        {data.stories.length === 0 ? (
          <p className="mb-1 text-xs text-muted-foreground">
            {loading
              ? ""
              : isUniverse
                ? t("creative.page.universe.noStories")
                : t("creative.page.standalone.noStories")}
          </p>
        ) : (
          <ul className="mb-1 grid gap-0.5 sm:grid-cols-2 xl:grid-cols-3">
            {data.stories.map((story) => (
              <li key={story.storyId} className="min-w-0">
                <button type="button" onClick={() => onOpenStory(story.storyId)} className={ROW}>
                  <BookOpen className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 break-words">{story.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {onNewStory && (
          <button
            type="button"
            onClick={onNewStory}
            className="flex w-fit items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-3.5" />
            {t("creative.panel.newStory")}
          </button>
        )}
      </section>
      {isUniverse && anchorsSection && (
        <section
          aria-label={t("creative.plot.events.group")}
          className="rounded-2xl border border-border bg-card p-5"
        >
          <h2 className="mb-2 text-sm font-semibold">{t("creative.plot.events.group")}</h2>
          {data.events.length === 0 ? (
            <p className="mb-1 text-xs text-muted-foreground">
              {loading ? "" : t("creative.plot.events.empty")}
            </p>
          ) : (
            <ul className="mb-1 grid gap-0.5 sm:grid-cols-2 xl:grid-cols-3">
              {data.events.map((event) => (
                <li key={event.noteId} className="min-w-0">
                  <button type="button" onClick={() => onOpenNote(event.noteId)} className={ROW}>
                    <Anchor className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 break-words">{event.title}</span>
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
      {data.failed && (
        <p role="alert" className="text-xs text-destructive">
          {t("creative.workshop.loadFailed")}
        </p>
      )}
      <div className="grid items-start gap-5 md:grid-cols-2">
        <WorldCards
          cards={cards}
          loading={loading}
          vaultGeneration={vaultGeneration}
          onOpenNote={onOpenNote}
          onOpenSection={(_ownerId, sectionId) => onOpenSection(sectionId)}
          createFor={(card) => (card.title ? null : createFor(card.section))}
        />
      </div>
    </div>
  )
}
