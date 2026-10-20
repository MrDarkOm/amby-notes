import type { DatabaseRow, Notebook } from "@/lib/storage"

/** A tab of the notes board: every note, one top-level notebook, or the notes in no notebook. */
export interface NoteTab {
  /** `all`, `none`, or `notebook:<name>`. */
  key: string
  kind: "all" | "notebook" | "none"
  /** The notebook's name; `null` for the two that are not notebooks. */
  name: string | null
  count: number
}

export const ALL_NOTES = "all"

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" })

/**
 * The tabs: "All" with every note, then one per top-level notebook (those the disk lists, empty
 * ones too, and any a note names that the listing missed), then the notes in no notebook when
 * there are some. A notebook's count holds the notes in the notebooks inside it as well.
 */
export function buildNoteTabs(
  rows: readonly DatabaseRow[],
  notebooks: readonly Notebook[],
): NoteTab[] {
  const names = new Set<string>()
  for (const notebook of notebooks) if (notebook.segments[0]) names.add(notebook.segments[0])
  for (const row of rows) if (row.categoryPath[0]) names.add(row.categoryPath[0])
  const tabs: NoteTab[] = [{ key: ALL_NOTES, kind: "all", name: null, count: rows.length }]
  for (const name of [...names].sort(byName)) {
    tabs.push({
      key: `notebook:${name}`,
      kind: "notebook",
      name,
      count: rows.filter((row) => row.categoryPath[0] === name).length,
    })
  }
  const loose = rows.filter((row) => row.categoryPath.length === 0).length
  if (loose > 0) tabs.push({ key: "none", kind: "none", name: null, count: loose })
  return tabs
}

/** The notes a tab shows. */
export function notesInTab(rows: readonly DatabaseRow[], tab: NoteTab | undefined): DatabaseRow[] {
  if (!tab || tab.kind === "all") return [...rows]
  if (tab.kind === "none") return rows.filter((row) => row.categoryPath.length === 0)
  return rows.filter((row) => row.categoryPath[0] === tab.name)
}

/** The notebook a new note lands in while the tab is shown: `undefined` is the base's root. */
export function notebookForNewNote(tab: NoteTab | undefined): string[] | undefined {
  return tab?.kind === "notebook" && tab.name ? [tab.name] : undefined
}

/** The notebook of a note for its card: the folder names joined, none for the root. */
export function notebookLabel(row: DatabaseRow): string | null {
  return row.categoryPath.length > 0 ? row.categoryPath.join(" › ") : null
}

/** The notes with the latest change first; a note with no time last, then by title. */
export function newestNotesFirst(
  rows: readonly DatabaseRow[],
  modifiedOf: (noteId: string) => number | null | undefined,
): DatabaseRow[] {
  return [...rows].sort((a, b) => {
    const left = modifiedOf(a.noteId) ?? -1
    const right = modifiedOf(b.noteId) ?? -1
    return right - left || byName(a.title, b.title)
  })
}
