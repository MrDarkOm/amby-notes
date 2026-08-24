import type { NoteReadOutcome, SearchResult, TreeItem } from "./types"
import { flattenWebNotes } from "./web-tree"

/** Bounded browser fallback search; the desktop index remains authoritative. */
export async function searchWebNotes(
  query: string,
  tree: TreeItem[],
  readNote: (noteId: string) => Promise<NoteReadOutcome>,
): Promise<SearchResult[]> {
  const normalized = query.trim().toLowerCase()
  if (!normalized || normalized === "#") return []
  const tagQuery = normalized.startsWith("#") ? normalized.slice(1) : null
  const results: SearchResult[] = []
  for (const item of flattenWebNotes(tree)) {
    const note = await readNote(item.id)
    const title = item.name.toLowerCase()
    if (tagQuery !== null) {
      const tags = [...note.content.matchAll(/(?<=^|\s)#([\p{L}][\p{L}\p{N}_-]*)/gu)]
        .map((match) => match[1].toLowerCase())
        .filter((tag) => tag.includes(tagQuery))
      if (!tags.length) continue
      results.push({
        note: {
          id: item.id,
          path: item.path ?? item.id,
          title: item.name,
          wordCount: note.content.split(/\s+/u).filter(Boolean).length,
        },
        matchType: "tag",
        snippet: [...new Set(tags)].map((tag) => `#${tag}`).join("  "),
        score: tags.some((tag) => tag === tagQuery) ? 2 : 1,
      })
    } else if (title.includes(normalized) || note.content.toLowerCase().includes(normalized)) {
      const nameMatch = title.includes(normalized)
      results.push({
        note: {
          id: item.id,
          path: item.path ?? item.id,
          title: item.name,
          wordCount: note.content.split(/\s+/u).filter(Boolean).length,
        },
        matchType: nameMatch ? "name" : "content",
        score: nameMatch ? (title.startsWith(normalized) ? 3 : 2) : 1,
      })
    }
  }
  return results
    .sort(
      (left, right) => right.score - left.score || left.note.title.localeCompare(right.note.title),
    )
    .slice(0, 50)
}
