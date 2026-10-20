import * as React from "react"
import type { DatabaseRow, StorySummary } from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"
import { useViewStateStore } from "../../use-view-state-store"
import {
  buildStoryEntries,
  isStoryFinished,
  statusPropertyOf,
  type StoryEntry,
} from "./story-list-model"
import type { StoryStat } from "./story-stats-model"

interface StoryEntriesInput {
  stories: readonly StorySummary[]
  stats: Readonly<Record<string, StoryStat | undefined>>
  /** The rows of the stories base (the cards), once read. */
  cardRows: readonly DatabaseRow[] | undefined
  /** The stories base: where the status that marks a finished story lives. */
  storiesDatabaseId: string | undefined
  /** The universe a story is in; keep the function steady (`useCallback`) or entries are remade. */
  universeOf: (story: StorySummary) => string | null
  universeName: (universeId: string) => string | null
}

/**
 * The stories as cards need them: their numbers, whether the card's status is "done", their world
 * and whether Amby's favorites hold the story's card. The favorites are the shared ones, so a star
 * here and the Favorites panel never disagree.
 */
export function useStoryEntries({
  stories,
  stats,
  cardRows,
  storiesDatabaseId,
  universeOf,
  universeName,
}: StoryEntriesInput): StoryEntry[] {
  const favorites = useViewStateStore((state) => state.favorites)
  const summary = useDatabaseStore((state) =>
    state.databases.find((database) => database.databaseId === storiesDatabaseId),
  )
  const statusProperty = React.useMemo(() => statusPropertyOf(summary?.properties), [summary])
  return React.useMemo(() => {
    const cards = new Map((cardRows ?? []).map((row) => [row.noteId, row]))
    return buildStoryEntries({
      stories,
      stats,
      finished: (story) =>
        isStoryFinished(story.cardNoteId ? cards.get(story.cardNoteId) : undefined, statusProperty),
      universeOf,
      universeName,
      favorites,
    })
  }, [cardRows, favorites, stats, statusProperty, stories, universeName, universeOf])
}
