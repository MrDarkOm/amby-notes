import * as React from "react"
import { Anchor } from "lucide-react"
import { useTranslation } from "react-i18next"
import { createWorkshopEntity, type StorySummary, type WorkshopSummary } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { useDatabaseStore } from "../database/database-store"
import { useViewStateStore } from "../use-view-state-store"
import { useCreativeNavStore } from "./creative-nav-store"
import { readScopePrefs, writeScopePrefs, type ScopePrefsKind } from "./creative-scope-storage"
import { StoryList } from "./pages/story-list"
import {
  PLAIN_STORY_SORTS,
  STORY_SORTS,
  orderStoryEntries,
  parseStoriesView,
  parseStoryFilter,
  parseStorySort,
  type StoriesView,
  type StoryFilter,
  type StoryOrderInput,
  type StorySort,
} from "./pages/story-list-model"
import { mergeStoryOrder, orderAfterMove } from "./pages/story-order-model"
import { StoryTimeline } from "./pages/story-timeline"
import { StoriesViewSwitch } from "./pages/stories-view-switch"
import { useStoryEntries } from "./pages/use-story-entries"
import type { StoriesStats } from "./pages/use-stories-stats"
import { projectErrorText } from "./project-error"
import { ScopedSection } from "./scoped-section"
import { useTextStats } from "./use-text-stats"
import { QuickCreate } from "./workshop/quick-create"
import type { ScopeData } from "./workshop/use-scope-data"
import { useViewManualOrder } from "./workshop/use-view-order"
import type { PanelFilter } from "./workshop/workshop-model"

/** The scopes with a desk of their own: a universe, or the stories that no universe holds. */
export type DeskScope = Extract<PanelFilter, { kind: "universe" | "standalone" }>

interface ScopeDeskProps {
  workshop: WorkshopSummary
  scope: DeskScope
  /** What the page lists; read once by the page and shared with its section tabs. */
  data: ScopeData
  /** Words, pages and last change of the scope's stories: read once by the page, whose header counts them. */
  storiesStats: StoriesStats
  /** The vault the choices of filter, sort, view and tab are remembered in. */
  vaultPath: string | null
  /** The universe's name, for the world line of its stories' cards. */
  universeTitle?: string
  onOpenNote: (noteId: string) => void
  onOpenStory: (storyId: string) => void
  /** Opens a section's whole shared database (every story's pages), on the workshop's page. */
  onOpenWhole: (sectionId: string) => void
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
 * The overview of a universe or of the standalone stories: the stories that belong here (cards,
 * and on a universe also a timeline in the order the author placed them), the universe's events
 * and the world beside them, one section at a time. What belongs to the place is the panel's own
 * rule (`useScopeData`), so the page and the panel never disagree.
 */
export function ScopeDesk({
  workshop,
  scope,
  data,
  storiesStats,
  vaultPath,
  universeTitle,
  onOpenNote,
  onOpenStory,
  onOpenWhole,
  onNewStory,
  onEnsureAnchorLinks,
}: ScopeDeskProps) {
  const { t } = useTranslation()
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const bumpData = useCreativeNavStore((state) => state.bumpData)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const toggleFavorite = useViewStateStore((state) => state.toggleFavorite)
  const anchorsSection = data.lists.find((list) => list.section.role === "anchors")?.section
  const isUniverse = scope.kind === "universe"
  const universeId = scope.kind === "universe" ? scope.universeId : null
  const prefsKind: ScopePrefsKind = scope.kind

  // The stories as cards.
  const storiesSection = workshop.sections.find(
    (section) => section.role === "stories" && section.state !== "missing",
  )
  const storiesSummary = useDatabaseStore((state) =>
    state.databases.find((database) => database.databaseId === storiesSection?.databaseId),
  )
  const universeOf = React.useCallback((_story: StorySummary) => universeId, [universeId])
  const universeName = React.useCallback(() => universeTitle ?? null, [universeTitle])
  const entries = useStoryEntries({
    stories: data.stories,
    stats: storiesStats.stats,
    cardRows: storiesSection ? data.rows[storiesSection.databaseId] : undefined,
    storiesDatabaseId: storiesSection?.databaseId,
    universeOf,
    universeName,
  })

  // The author's order of the stories: the hand-placed order of the stories base's first view and
  // when each card was made. Only a universe has one to show.
  const viewOrder = useViewManualOrder(isUniverse ? storiesSummary : undefined, dataNonce)
  const cardStats = useTextStats(isUniverse ? storiesSection?.databaseId : null, dataNonce)
  const order = React.useMemo<StoryOrderInput>(
    () => ({ manualOrder: viewOrder.order, createdOf: (id) => cardStats[id]?.created }),
    [cardStats, viewOrder.order],
  )
  const ordered = React.useMemo(() => orderStoryEntries(entries, order), [entries, order])
  const [moveError, setMoveError] = React.useState<string | null>(null)
  const canReorder = isUniverse && !workshop.readOnly && Boolean(storiesSummary?.views.length)
  const moveStory = (storyId: string, to: number) => {
    const next = orderAfterMove(ordered, storyId, to)
    if (!next) return
    setMoveError(null)
    viewOrder.save(mergeStoryOrder(viewOrder.order, next)).catch((caught: unknown) => {
      setMoveError(t("creative.timeline.saveFailed", { message: projectErrorText(t, caught) }))
    })
  }

  // What was chosen on this kind of page stays chosen in this vault.
  const sorts: readonly StorySort[] = isUniverse ? STORY_SORTS : PLAIN_STORY_SORTS
  const remembered = vaultPath ? readScopePrefs(vaultPath, prefsKind) : {}
  const [filter, setFilterState] = React.useState<StoryFilter>(() =>
    parseStoryFilter(remembered.filter),
  )
  const [sort, setSortState] = React.useState<StorySort>(() =>
    parseStorySort(remembered.sort, sorts, isUniverse ? "order" : "recent"),
  )
  const [view, setViewState] = React.useState<StoriesView>(() =>
    isUniverse ? parseStoriesView(remembered.view) : "cards",
  )
  const [tab, setTabState] = React.useState<string | null>(remembered.tab ?? null)
  const remember = (patch: Parameters<typeof writeScopePrefs>[2]) => {
    if (vaultPath) writeScopePrefs(vaultPath, prefsKind, patch)
  }

  // The events of a universe.
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

  // The world: one section at a time. A universe's events have a block of their own, so the
  // anchors would only repeat them.
  const worldLists = data.lists.filter((list) => !(isUniverse && list.section.role === "anchors"))
  const activeList =
    worldLists.find((list) => list.section.id === tab) ?? worldLists[0] ?? undefined

  const loading = data.loading
  const emptyText = loading
    ? ""
    : isUniverse
      ? t("creative.page.universe.noStories")
      : t("creative.page.standalone.noStories")
  const timeline = isUniverse && view === "timeline"
  const switcher = isUniverse ? (
    <StoriesViewSwitch
      view={view}
      onChange={(next) => {
        setViewState(next)
        remember({ view: next })
      }}
    />
  ) : undefined

  return (
    <div className="mb-8 flex w-full min-w-0 flex-col gap-9">
      {timeline ? (
        <section aria-label={t("creative.page.stories")} className="flex flex-col gap-3.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 className="text-lg font-semibold">{t("creative.page.stories")}</h2>
            {switcher}
          </div>
          {ordered.length === 0 && <p className="text-sm text-muted-foreground">{emptyText}</p>}
          <StoryTimeline
            entries={ordered}
            onOpen={onOpenStory}
            onMove={canReorder ? moveStory : null}
            onNewStory={onNewStory}
            error={moveError}
          />
        </section>
      ) : (
        <StoryList
          entries={entries}
          filter={filter}
          sort={sort}
          sorts={sorts}
          order={order}
          onFilterChange={(next) => {
            setFilterState(next)
            remember({ filter: next })
          }}
          onSortChange={(next) => {
            setSortState(next)
            remember({ sort: next })
          }}
          leading={switcher}
          emptyText={emptyText}
          onOpen={onOpenStory}
          onToggleFavorite={toggleFavorite}
          onNewStory={onNewStory}
        />
      )}
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
      {activeList && (
        <section aria-label={t("creative.scope.world")} className="flex min-w-0 flex-col gap-3">
          <div
            role="tablist"
            aria-label={t("creative.scope.worldTabs")}
            className="flex flex-wrap gap-0.5 border-b border-border"
          >
            {worldLists.map((list) => {
              const active = list.section.id === activeList.section.id
              return (
                <button
                  key={list.section.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setTabState(list.section.id)
                    remember({ tab: list.section.id })
                  }}
                  className={cn(
                    "-mb-px inline-flex h-9 items-center border-b-2 px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    active
                      ? "border-primary font-semibold text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {list.section.name}
                </button>
              )
            })}
          </div>
          <ScopedSection
            key={activeList.section.id}
            workshop={workshop}
            section={activeList.section}
            scope={scope}
            data={data}
            onOpenNote={onOpenNote}
            onOpenWhole={onOpenWhole}
          />
        </section>
      )}
    </div>
  )
}
