// What the editor offers while `[[` or `#` is being typed. The workspace owns the list
// of notes and the tag index; it registers them here, and every editor of the window
// (the note, a database peek, a transclusion) reads the same sources.

export interface NoteSuggestionSource {
  /** The note's name as the tree shows it. */
  name: string
  /** The path inside the vault, without the extension. */
  path: string
}

interface SuggestionSources {
  notes: () => NoteSuggestionSource[]
  tags: () => Promise<string[]>
}

export interface SuggestItem {
  /** What is written into the note. */
  value: string
  label: string
  detail?: string
}

const NO_SOURCES: SuggestionSources = { notes: () => [], tags: async () => [] }
let sources = NO_SOURCES

/** Registers the sources; the returned function removes them again. */
export function setSuggestionSources(next: SuggestionSources): () => void {
  sources = next
  return () => {
    if (sources === next) sources = NO_SOURCES
  }
}

const fold = (text: string) => text.normalize("NFC").toLocaleLowerCase()

/** Lower is better; null when the text does not contain the query at all. */
function rank(text: string, query: string): number | null {
  if (!query) return 0
  const at = fold(text).indexOf(query)
  if (at === -1) return null
  if (at === 0) return 0
  return /[\s/_\-.]/u.test(text[at - 1] ?? "") ? 1 : 2
}

function best<T>(entries: Array<{ item: T; rank: number; key: string }>, limit: number): T[] {
  return entries
    .sort((a, b) => a.rank - b.rank || a.key.length - b.key.length || a.key.localeCompare(b.key))
    .slice(0, limit)
    .map((entry) => entry.item)
}

/** Notes whose name or path contains the query. */
export function suggestNotes(query: string, limit = 8): SuggestItem[] {
  const needle = fold(query.trim())
  const notes = sources.notes()
  const sameName = new Map<string, number>()
  for (const note of notes) sameName.set(fold(note.name), (sameName.get(fold(note.name)) ?? 0) + 1)
  const entries: Array<{ item: SuggestItem; rank: number; key: string }> = []
  for (const note of notes) {
    const byName = rank(note.name, needle)
    const byPath = byName === null ? rank(note.path, needle) : null
    if (byName === null && byPath === null) continue
    // A name several notes share would open the first of them: write the path instead.
    const unique = (sameName.get(fold(note.name)) ?? 0) < 2
    const folder = note.path.includes("/") ? note.path.slice(0, note.path.lastIndexOf("/")) : ""
    entries.push({
      item: {
        value: unique ? note.name : note.path,
        label: note.name,
        detail: folder || undefined,
      },
      rank: byName ?? 3 + (byPath ?? 0),
      key: note.path,
    })
  }
  return best(entries, limit)
}

/** Existing tags that contain the query: those of the vault and those of the open note. */
export async function suggestTags(
  query: string,
  inThisNote: string[],
  limit = 8,
): Promise<SuggestItem[]> {
  const needle = fold(query)
  let indexed: string[] = []
  try {
    indexed = await sources.tags()
  } catch {
    // Without the index the tags of the open note are still offered.
  }
  const seen = new Set<string>()
  const entries: Array<{ item: SuggestItem; rank: number; key: string }> = []
  for (const tag of [...inThisNote, ...indexed]) {
    const key = fold(tag)
    // The tag being typed is not a suggestion for itself.
    if (!key || key === needle || seen.has(key)) continue
    seen.add(key)
    const tagRank = rank(tag, needle)
    if (tagRank === null) continue
    entries.push({ item: { value: tag, label: `#${tag}` }, rank: tagRank, key })
  }
  return best(entries, limit)
}
