import * as React from "react"
import { searchNotes, type DatabaseRow, type SearchResult, type StorySummary } from "@/lib/storage"
import { useCreativeNavStore } from "../creative-nav-store"
import { buildTextTree, textOrder } from "../workshop/text-tree-model"
import { useDatabaseRows } from "../workshop/use-database-rows"
import {
  collectMentions,
  mentionNames,
  searchQueries,
  type TextMention,
  type TextPageInfo,
} from "./mention-model"
import type { NoteDossier } from "./use-note-dossier"

/**
 * The pages of the stories' text that name this world page but are not linked to it, in reading
 * order (story by story). Read from the search index and the rows of the texts; nothing is
 * written. A search that fails leaves the list as it is: it is a help, not a record.
 */
export function useTextMentions(
  dossier: NoteDossier,
  content: string,
  /** Pages already listed as linked, so they are not repeated. */
  linked: ReadonlySet<string>,
): {
  mentions: TextMention[]
  /** The row and story of a page of the text, for binding it. */
  pageOf: (noteId: string) => { story: StorySummary; row: DatabaseRow } | null
} {
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const texts = React.useMemo(
    () => dossier.world.workshop.stories.filter((story) => story.text?.databaseId),
    [dossier.world.workshop.stories],
  )
  const databaseIds = React.useMemo(() => texts.map((story) => story.text!.databaseId!), [texts])
  const data = useDatabaseRows(databaseIds, dataNonce)

  const { pages, rank, places } = React.useMemo(() => {
    const pages = new Map<string, TextPageInfo>()
    const rank = new Map<string, number>()
    const places = new Map<string, { story: StorySummary; row: DatabaseRow }>()
    for (const story of texts) {
      const rows = data.rows[story.text!.databaseId!]
      if (!rows) continue
      for (const row of rows) {
        pages.set(row.noteId, { title: row.title, storyName: story.name })
        places.set(row.noteId, { story, row })
      }
      for (const noteId of textOrder(buildTextTree(rows, story.text!.properties))) {
        if (!rank.has(noteId)) rank.set(noteId, rank.size)
      }
    }
    return { pages, rank, places }
  }, [data.rows, texts])

  // The text changes on every keystroke; the names only when the title or the aliases do.
  const namesKey = mentionNames(dossier.context.row.title, content).join("\n")
  const [searches, setSearches] = React.useState<{ name: string; results: SearchResult[] }[]>([])

  React.useEffect(() => {
    const names = namesKey ? namesKey.split("\n") : []
    if (names.length === 0 || pages.size === 0) {
      setSearches([])
      return undefined
    }
    let cancelled = false
    void (async () => {
      try {
        const found = await Promise.all(
          searchQueries(names).map(async ({ name, query }) => ({
            name,
            results: await searchNotes(query),
          })),
        )
        if (!cancelled) setSearches(found)
      } catch {
        // Keep what was shown: the search index may be rebuilding.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [namesKey, pages])

  const mentions = React.useMemo(() => {
    const exclude = new Set([...linked, dossier.context.row.noteId])
    const mentions = collectMentions({ searches, textPages: pages, exclude })
    const at = (noteId: string) => rank.get(noteId) ?? Number.MAX_SAFE_INTEGER
    return mentions.sort((left, right) => at(left.noteId) - at(right.noteId))
  }, [dossier.context.row.noteId, linked, pages, rank, searches])
  const pageOf = React.useCallback((noteId: string) => places.get(noteId) ?? null, [places])
  return { mentions, pageOf }
}
