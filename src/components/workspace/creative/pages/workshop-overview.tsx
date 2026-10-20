import * as React from "react"
import { Play } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { createWorkshopEntity, type StorySummary, type WorkshopSummary } from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"
import { useTextStats } from "../use-text-stats"
import { useViewStateStore } from "../../use-view-state-store"
import { formatModified } from "../../workspace-tree-utils"
import { readWorkshopPrefs, writeWorkshopPrefs } from "../creative-scope-storage"
import { useCreativeNavStore } from "../creative-nav-store"
import { useDatabaseRows } from "../workshop/use-database-rows"
import { useNotebooks } from "../workshop/use-notebooks"
import { buildMembership, storyLabels, type UniverseItem } from "../workshop/workshop-model"
import { NotesBoard } from "./notes-board"
import {
  parseStoryFilter,
  parseStorySort,
  type StoryFilter,
  type StorySort,
  type WorldFilter,
} from "./story-list-model"
import { StoryList } from "./story-list"
import { latestWork } from "./story-stats-model"
import { useStoryEntries } from "./use-story-entries"
import type { StoriesStats } from "./use-stories-stats"

interface WorkshopOverviewProps {
  workshop: WorkshopSummary
  vaultPath: string | null
  /** Words, pages and last change of every story: read once by the page, whose header counts them. */
  storiesStats: StoriesStats
  universes: readonly UniverseItem[]
  onOpenStory: (storyId: string) => void
  onOpenNote: (noteId: string) => void
  /** Starts a new story; `null` where the workshop cannot be written to. */
  onNewStory: (() => void) | null
}

/**
 * The body of the workshop's page: where to continue, the stories as cards with their filter, and
 * the notes under their notebooks. Everything is read from the databases and the note index; the
 * choices of filter and sort are the interface's own and live in the vault's prefs.
 */
export function WorkshopOverview({
  workshop,
  vaultPath,
  storiesStats,
  universes,
  onOpenStory,
  onOpenNote,
  onNewStory,
}: WorkshopOverviewProps) {
  const { t } = useTranslation()
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const bumpData = useCreativeNavStore((state) => state.bumpData)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const toggleFavorite = useViewStateStore((state) => state.toggleFavorite)

  const storiesSection = workshop.sections.find(
    (section) => section.role === "stories" && section.state !== "missing",
  )
  const notesSection = workshop.sections.find(
    (section) => section.role === "notes" && section.state !== "missing",
  )
  const ids = React.useMemo(
    () => [
      ...(storiesSection ? [storiesSection.databaseId] : []),
      ...(notesSection ? [notesSection.databaseId] : []),
    ],
    [notesSection, storiesSection],
  )
  const data = useDatabaseRows(ids, dataNonce)
  const storyRows = storiesSection ? data.rows[storiesSection.databaseId] : undefined
  const noteRows = notesSection ? data.rows[notesSection.databaseId] : undefined
  const notesStats = useTextStats(notesSection?.databaseId, dataNonce)
  const { catalog: notebookCatalog } = useNotebooks(notesSection?.databaseId, dataNonce)

  const membership = React.useMemo(
    () =>
      buildMembership({
        stories: workshop.stories,
        sections: workshop.sections,
        rows: { ...storiesStats.textRows, ...data.rows },
      }),
    [data.rows, storiesStats.textRows, workshop.sections, workshop.stories],
  )

  const universeNames = React.useMemo(
    () => new Map(universes.map((universe) => [universe.noteId, universe.title])),
    [universes],
  )
  const universeOf = React.useCallback(
    (story: StorySummary) => membership.universeOf(story.storyId),
    [membership],
  )
  const universeName = React.useCallback(
    (universeId: string) => universeNames.get(universeId) ?? null,
    [universeNames],
  )
  const entries = useStoryEntries({
    stories: workshop.stories,
    stats: storiesStats.stats,
    cardRows: storyRows,
    storiesDatabaseId: storiesSection?.databaseId,
    universeOf,
    universeName,
  })

  // What was chosen in this vault stays chosen; the world is a look at the moment.
  const [filter, setFilterState] = React.useState<StoryFilter>(() =>
    parseStoryFilter(vaultPath ? readWorkshopPrefs(vaultPath).storyFilter : null),
  )
  const [sort, setSortState] = React.useState<StorySort>(() =>
    parseStorySort(vaultPath ? readWorkshopPrefs(vaultPath).storySort : null),
  )
  const [world, setWorld] = React.useState<WorldFilter>("all")
  const setFilter = (next: StoryFilter) => {
    setFilterState(next)
    if (vaultPath) writeWorkshopPrefs(vaultPath, { storyFilter: next })
  }
  const setSort = (next: StorySort) => {
    setSortState(next)
    if (vaultPath) writeWorkshopPrefs(vaultPath, { storySort: next })
  }
  // A world that is gone from the list is "all" again.
  const activeWorld: WorldFilter =
    world === "all" ||
    world === "standalone" ||
    universes.some((universe) => universe.noteId === world)
      ? world
      : "all"

  const latest = React.useMemo(
    () => latestWork(workshop.stories, storiesStats.stats),
    [storiesStats.stats, workshop.stories],
  )

  const storyNameOf = React.useCallback(
    (storyId: string) => workshop.stories.find((story) => story.storyId === storyId)?.name,
    [workshop.stories],
  )
  const storyLabelsOf = React.useCallback(
    (noteId: string) => storyLabels(membership.storiesOf(noteId), storyNameOf),
    [membership, storyNameOf],
  )
  const modifiedOf = React.useCallback(
    (noteId: string) => notesStats[noteId]?.modified ?? null,
    [notesStats],
  )

  const createNote =
    !workshop.readOnly && notesSection && vaultGeneration !== null
      ? async (title: string, notebook: string[] | undefined) => {
          try {
            await createWorkshopEntity({
              expectedGeneration: vaultGeneration,
              workshopId: workshop.workshopId,
              sectionId: notesSection.id,
              title,
              notebook: notebook ?? null,
            })
          } finally {
            bumpData()
          }
        }
      : null

  return (
    <div className="mb-8 flex w-full min-w-0 flex-col gap-9">
      {latest && (
        <section
          aria-label={t("creative.workshopPage.continue")}
          className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl bg-primary/10 px-5 py-4"
        >
          <div className="min-w-0 flex-1 basis-56">
            <p className="text-xs font-semibold text-primary">
              {t("creative.workshopPage.continue")}
            </p>
            <p className="mt-1 break-words text-xl font-semibold leading-snug">
              {latest.story.name}
              <span className="font-normal text-muted-foreground"> › </span>
              {latest.pageTitle}
            </p>
            <p className="mt-0.5 break-words text-xs text-muted-foreground">
              {[
                t("creative.storyCard.edited", {
                  when: formatModified(latest.stat.lastModified ?? 0),
                }),
                t("docEditor.wordCount", { count: latest.stat.lastPageWords }),
              ].join(" · ")}
            </p>
          </div>
          <Button onClick={() => onOpenNote(latest.pageId)}>
            <Play className="size-3.5 fill-current" />
            {t("creative.workshopPage.write")}
          </Button>
        </section>
      )}
      <StoryList
        entries={entries}
        filter={filter}
        sort={sort}
        onFilterChange={setFilter}
        onSortChange={setSort}
        worlds={universes.map((universe) => ({ id: universe.noteId, name: universe.title }))}
        world={activeWorld}
        onWorldChange={setWorld}
        onOpen={onOpenStory}
        onToggleFavorite={toggleFavorite}
        onNewStory={onNewStory}
      />
      {notesSection && (
        <NotesBoard
          notes={noteRows}
          notebooks={notebookCatalog?.notebooks ?? []}
          modifiedOf={modifiedOf}
          storyLabelsOf={storyLabelsOf}
          onOpenNote={onOpenNote}
          onCreate={createNote}
        />
      )}
    </div>
  )
}
