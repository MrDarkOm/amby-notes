import type { DatabaseRow, StorySummary, TextPageStat } from "@/lib/storage"
import { optionIdOf } from "../workshop/workshop-model"
import { resolvePageStatus } from "../workshop/text-tree-model"

/** What a story's card and the "continue" band know about the story's text. */
export interface StoryStat {
  storyId: string
  words: number
  pages: number
  /** Pages whose status is in the "done" group; `null` when the story has no page status. */
  donePages: number | null
  /** Seconds since the epoch of the page changed last; `null` before any page has a time. */
  lastModified: number | null
  lastPageId: string | null
  lastPageTitle: string | null
  lastPageWords: number
  /** The earliest creation time among the pages: when work on the story began. */
  created: number | null
}

/**
 * The numbers of one story from the note index (`listTextStats`) and the rows of its text
 * database (page titles and status). The rows may still be unread: then the counts of pages and
 * done pages fall back to what the index holds and to `null`.
 */
export function computeStoryStat(
  story: StorySummary,
  stats: readonly TextPageStat[],
  rows: readonly DatabaseRow[] | undefined,
): StoryStat {
  const titles = rows ? new Map(rows.map((row) => [row.noteId, row.title])) : null
  // A page the index still holds but the database no longer lists is not a page of the text.
  const known = titles ? stats.filter((entry) => titles.has(entry.noteId)) : stats
  let words = 0
  let created: number | null = null
  let latest: TextPageStat | null = null
  for (const entry of known) {
    words += entry.wordCount
    if (entry.created != null && (created === null || entry.created < created)) {
      created = entry.created
    }
    if (entry.modified != null && (latest === null || entry.modified > (latest.modified ?? 0))) {
      latest = entry
    }
  }
  const statusId = story.text?.properties.status ?? null
  const options = statusId ? (story.text?.statusOptions ?? []) : []
  const donePages =
    rows && statusId && options.length > 0
      ? rows.filter(
          (row) =>
            resolvePageStatus(options, optionIdOf(row.valuesJson, statusId))?.group === "done",
        ).length
      : null
  return {
    storyId: story.storyId,
    words,
    pages: rows ? rows.length : known.length,
    donePages,
    lastModified: latest?.modified ?? null,
    lastPageId: latest?.noteId ?? null,
    lastPageTitle: latest && titles ? (titles.get(latest.noteId) ?? null) : null,
    lastPageWords: latest?.wordCount ?? 0,
    created,
  }
}

/** The story whose text was changed last, with its page: what the "continue" band offers. */
export function latestWork(
  stories: readonly StorySummary[],
  stats: Readonly<Record<string, StoryStat | undefined>>,
): { story: StorySummary; stat: StoryStat; pageId: string; pageTitle: string } | null {
  let best: { story: StorySummary; stat: StoryStat; pageId: string; pageTitle: string } | null =
    null
  for (const story of stories) {
    const stat = stats[story.storyId]
    if (!stat || stat.lastModified === null || !stat.lastPageId || !stat.lastPageTitle) continue
    if (best === null || stat.lastModified > (best.stat.lastModified ?? 0)) {
      best = { story, stat, pageId: stat.lastPageId, pageTitle: stat.lastPageTitle }
    }
  }
  return best
}
