import type { DatabaseRow, Notebook } from "@/lib/storage"
import type { EntityItem } from "./workshop-model"

/**
 * Notebooks are plain folders of the notes base (`docs/creative-format.md` §6): a note's place
 * in one is its `categoryPath`, which has nothing to do with the stories it is linked to. This
 * file is the pure part: grouping notes by notebook, checking a notebook's name, and planning the
 * deletion of a notebook so that no note is ever lost.
 */

/** A note as the notebooks need it: the list item and where its file lies in the base. */
export interface NoteItem extends EntityItem {
  /** Folder names from the base's root down to the note; empty in the root. */
  categoryPath: string[]
  /** The file's path as the database row holds it. */
  relativePath: string
}

export function noteItemsOf(
  rows: readonly DatabaseRow[],
  databaseId: string,
  workshopId: string,
): NoteItem[] {
  return rows.map((row) => ({
    noteId: row.noteId,
    title: row.title,
    databaseId,
    workshopId,
    valuesJson: row.valuesJson,
    categoryPath: row.categoryPath,
    relativePath: row.relativePath,
  }))
}

/** Notebook names can hold no `/`, so the joined names are a unique key. */
export function notebookKey(segments: readonly string[]): string {
  return segments.join("/")
}

export function sameSegments(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index])
}

function startsWithSegments(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => segment === path[index])
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" })
const byTitle = (a: NoteItem, b: NoteItem) => byName(a.title, b.title)

export interface NotebookNode {
  /** `notebookKey(segments)`. */
  key: string
  name: string
  segments: string[]
  /** The folder on disk, when the listing of the base knows it. */
  path: string | null
  /** The notes lying directly in this notebook, by title. */
  notes: NoteItem[]
  children: NotebookNode[]
  /** The notes in it and in the notebooks below it. */
  count: number
}

export interface NotebookTree {
  nodes: NotebookNode[]
  /** The notes in the root of the base: "no notebook". */
  rootNotes: NoteItem[]
  /** All the notes of the tree. */
  count: number
}

/**
 * Notes grouped by notebook. With `showEmpty` every notebook of the listing is a node, empty
 * ones included (they are drop targets and places to write in); without it only the notebooks
 * that hold a note, or lie above one, are. A note whose notebook the listing does not know still
 * gets its node, so nothing is hidden because a listing is late or was cut short.
 */
export function buildNotebookTree(
  notebooks: readonly Notebook[],
  items: readonly NoteItem[],
  options: { showEmpty: boolean },
): NotebookTree {
  const nodes = new Map<string, NotebookNode>()
  const roots: NotebookNode[] = []
  const ensure = (segments: readonly string[], path: string | null): NotebookNode => {
    const key = notebookKey(segments)
    const existing = nodes.get(key)
    if (existing) {
      if (path !== null && existing.path === null) existing.path = path
      return existing
    }
    const node: NotebookNode = {
      key,
      name: segments[segments.length - 1] ?? "",
      segments: [...segments],
      path,
      notes: [],
      children: [],
      count: 0,
    }
    nodes.set(key, node)
    if (segments.length <= 1) roots.push(node)
    else ensure(segments.slice(0, -1), null).children.push(node)
    return node
  }

  if (options.showEmpty) {
    for (const notebook of notebooks) ensure(notebook.segments, notebook.path)
  } else {
    for (const notebook of notebooks) {
      if (items.some((item) => startsWithSegments(item.categoryPath, notebook.segments))) {
        ensure(notebook.segments, notebook.path)
      }
    }
  }
  const rootNotes: NoteItem[] = []
  for (const item of items) {
    if (item.categoryPath.length === 0) rootNotes.push(item)
    else ensure(item.categoryPath, null).notes.push(item)
  }

  const finish = (node: NotebookNode): number => {
    node.notes.sort(byTitle)
    node.children.sort((a, b) => byName(a.name, b.name) || (a.name < b.name ? -1 : 1))
    node.count = node.notes.length + node.children.reduce((sum, child) => sum + finish(child), 0)
    return node.count
  }
  roots.sort((a, b) => byName(a.name, b.name) || (a.name < b.name ? -1 : 1))
  const total = roots.reduce((sum, root) => sum + finish(root), rootNotes.length)
  rootNotes.sort(byTitle)
  return { nodes: roots, rootNotes, count: total }
}

export interface NotebookTarget {
  /** `null` is the root of the base: "no notebook". */
  segments: string[] | null
  path: string | null
  /** The names from the root down, for the menu. */
  label: string
  depth: number
}

/** Every notebook of a tree, parents first, as a flat list of places a note can be moved to. */
export function notebookTargets(tree: NotebookTree): NotebookTarget[] {
  const targets: NotebookTarget[] = []
  const visit = (nodes: readonly NotebookNode[]) => {
    for (const node of nodes) {
      targets.push({
        segments: node.segments,
        path: node.path,
        label: node.segments.join(" / "),
        depth: node.segments.length - 1,
      })
      visit(node.children)
    }
  }
  visit(tree.nodes)
  return targets
}

// ── Names ────────────────────────────────────────────────────────────────────────────────────────

export type NameProblem =
  | "empty"
  | "tooLong"
  | "hidden"
  | "trailingDot"
  | "forbiddenCharacter"
  | "reservedName"
  | "duplicate"

const MAX_NAME_CHARS = 100
const RESERVED_FILES = new Set(["amby-workshop.json", "amby-story.json", "amby-project.json"])

function isDeviceName(name: string): boolean {
  const stem = name.split(".")[0].toUpperCase()
  return (
    ["CON", "PRN", "AUX", "NUL"].includes(stem) ||
    (stem.length === 4 && /^(COM|LPT)[1-9]$/u.test(stem))
  )
}

/**
 * Why a notebook name cannot be used, or `null`. The rules are the ones the backend applies to
 * the names that become folders (a notebook is one), plus: no sibling of the same name, whatever
 * the case. `renaming` is the notebook's own current name, which it may keep or re-case.
 */
export function notebookNameProblem(
  raw: string,
  siblings: readonly string[],
  renaming?: string,
): NameProblem | null {
  const name = raw.trim()
  if (!name) return "empty"
  if (Array.from(name).length > MAX_NAME_CHARS) return "tooLong"
  if (name.startsWith(".")) return "hidden"
  if (name.endsWith(".")) return "trailingDot"
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/u.test(name)) return "forbiddenCharacter"
  if (isDeviceName(name) || RESERVED_FILES.has(name.toLowerCase())) return "reservedName"
  const own = renaming?.toLowerCase()
  const taken = siblings.some(
    (sibling) => sibling.toLowerCase() === name.toLowerCase() && sibling.toLowerCase() !== own,
  )
  return taken ? "duplicate" : null
}

/** The names of the notebooks that lie directly inside `parent` (the root for `[]`). */
export function siblingNames(notebooks: readonly Notebook[], parent: readonly string[]): string[] {
  return notebooks
    .filter(
      (notebook) =>
        notebook.segments.length === parent.length + 1 &&
        startsWithSegments(notebook.segments, parent),
    )
    .map((notebook) => notebook.segments[notebook.segments.length - 1])
}

// ── Deleting a notebook without losing a note ───────────────────────────────────────────────────

/**
 * What moving a note takes along: a plain file moves alone, a note with a same-named folder (its
 * attachments) moves with that folder. The kind keeps a file `X.md` and a folder `X` apart.
 */
function movedEntry(relativePath: string): string {
  const parts = relativePath.split("/")
  const file = parts[parts.length - 1] ?? ""
  const stem = file.replace(/\.[^.]+$/u, "")
  const folder = parts[parts.length - 2]
  return folder !== undefined && folder === stem
    ? `d:${folder.toLowerCase()}`
    : `f:${file.toLowerCase()}`
}

export interface NotebookMove {
  noteId: string
  title: string
}

export type NotebookDeletePlan =
  | {
      kind: "ready"
      /** The notes of the notebook and of the notebooks below it, in no particular order. */
      moves: NotebookMove[]
      /** Where they go: the folder the notebook lies in. */
      parent: string[]
      /** Every notebook of the deleted subtree, the notebook itself first. */
      subtree: string[][]
    }
  /** Notes that would overwrite each other or something in the parent: nothing is moved. */
  | { kind: "collisions"; titles: string[] }
  /** The notebook holds something that is not a note, or the lists are not complete. */
  | { kind: "unsafe"; reason: "foreign" | "incomplete" | "unknown" }

/**
 * Plans the deletion of a notebook before anything is written. The notes of the notebook and of
 * those below it go up into its parent, and only then the empty folder goes to the trash, so a
 * note is never in the trash with it. Refused up front when two of the moved notes (or one of
 * them and something already in the parent) would have the same name, when the notebook holds
 * anything but notes, or when the rows are not all known.
 */
export function planNotebookDelete(
  segments: readonly string[],
  notebooks: readonly Notebook[],
  rows: readonly NoteItem[],
  rowsComplete: boolean,
  listingComplete: boolean,
): NotebookDeletePlan {
  if (!rowsComplete || !listingComplete) return { kind: "unsafe", reason: "incomplete" }
  const self = notebooks.find((notebook) => sameSegments(notebook.segments, segments))
  if (!self) return { kind: "unsafe", reason: "unknown" }
  const subtree = notebooks.filter((notebook) => startsWithSegments(notebook.segments, segments))

  // Everything in the folders must be a note this base knows: one row per item.
  for (const notebook of subtree) {
    const known = rows.filter((row) => sameSegments(row.categoryPath, notebook.segments)).length
    if (known !== notebook.itemCount) return { kind: "unsafe", reason: "foreign" }
  }

  const parent = segments.slice(0, -1)
  const moving = rows.filter((row) => startsWithSegments(row.categoryPath, segments))
  const occupied = new Set<string>()
  for (const row of rows) {
    if (sameSegments(row.categoryPath, parent)) occupied.add(movedEntry(row.relativePath))
  }
  for (const name of siblingNames(notebooks, parent)) occupied.add(`d:${name.toLowerCase()}`)

  const clashing = new Set<string>()
  const seen = new Set<string>()
  for (const row of moving) {
    const entry = movedEntry(row.relativePath)
    if (occupied.has(entry) || seen.has(entry)) clashing.add(row.title)
    seen.add(entry)
  }
  if (clashing.size > 0) return { kind: "collisions", titles: [...clashing].sort(byName) }
  return {
    kind: "ready",
    moves: moving.map((row) => ({ noteId: row.noteId, title: row.title })),
    parent,
    subtree: subtree.map((notebook) => notebook.segments),
  }
}

/**
 * What already stands in `target` under the name this note would keep: the title of the note, or
 * the name of the notebook, that it would run into; `null` when the move is free. Nothing is ever
 * overwritten, so a collision is a refusal.
 */
export function moveCollision(
  note: NoteItem,
  target: readonly string[],
  notebooks: readonly Notebook[],
  rows: readonly NoteItem[],
): string | null {
  const entry = movedEntry(note.relativePath)
  const sameName = rows.find(
    (row) =>
      row.noteId !== note.noteId &&
      sameSegments(row.categoryPath, target) &&
      movedEntry(row.relativePath) === entry,
  )
  if (sameName) return sameName.title
  return siblingNames(notebooks, target).find((name) => `d:${name.toLowerCase()}` === entry) ?? null
}

/** Whether a listing shows the notebooks `segments` and everything below it without a thing in them. */
export function subtreeIsEmpty(
  notebooks: readonly Notebook[],
  segments: readonly string[],
): boolean {
  const subtree = notebooks.filter((notebook) => startsWithSegments(notebook.segments, segments))
  return subtree.length > 0 && subtree.every((notebook) => notebook.itemCount === 0)
}

/** Where a note lies after moving into a notebook (`null`: the root), as the model reads it. */
export function absolutePathOf(
  catalog: { containerPath: string; notebooks: readonly Notebook[] },
  segments: readonly string[] | null,
): string | null {
  if (segments === null || segments.length === 0) return catalog.containerPath || null
  return (
    catalog.notebooks.find((notebook) => sameSegments(notebook.segments, segments))?.path ?? null
  )
}
