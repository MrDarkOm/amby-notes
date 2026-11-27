import { localeResources } from "@/locales/resources"
import type {
  NoteReference,
  ProjectCatalog,
  StorySummary,
  WorkshopSectionSummary,
  WorkshopSummary,
} from "@/lib/storage"

/** The roles that are not part of the world: the manuscript and plain notes have no dossier. */
const NON_WORLD_ROLES = new Set(["text", "notes", "stories"])

export interface WorldSection {
  workshop: WorkshopSummary
  section: WorkshopSectionSummary
}

/**
 * The creative section a database is, when its pages are dossiers: any section of a workshop
 * but the text and the notes. A section whose database is missing cannot hold a page.
 */
export function worldSectionOf(
  catalog: ProjectCatalog | null,
  databaseId: string,
): WorldSection | null {
  for (const workshop of catalog?.workshops ?? []) {
    const section = workshop.sections.find(
      (candidate) => candidate.databaseId === databaseId && candidate.state !== "missing",
    )
    if (section && !NON_WORLD_ROLES.has(section.role ?? "")) return { workshop, section }
  }
  return null
}

export interface TextPlace {
  workshop: WorkshopSummary
  story: StorySummary
}

/** The story whose text is this database: a page of it is a page of the text. */
export function textStoryOf(catalog: ProjectCatalog | null, databaseId: string): TextPlace | null {
  for (const workshop of catalog?.workshops ?? []) {
    const story = workshop.stories.find(
      (candidate) => (candidate.text?.databaseId ?? candidate.databaseId) === databaseId,
    )
    if (story?.text) return { workshop, story }
  }
  return null
}

/** Whether a workshop has an anchors or an arcs base, so a page of its text has a plot to show. */
export function hasPlotSections(workshop: WorkshopSummary): boolean {
  return workshop.sections.some(
    (section) =>
      (section.role === "anchors" || section.role === "arcs") && section.state !== "missing",
  )
}

/** Recognize built-in field names from either language, independent of the current interface. */
export function characterFieldPriority(name: string): number {
  const normalized = name.trim().toLowerCase()
  const properties = Object.values(localeResources).map(
    ({ translation }) => translation.creative.preset.properties,
  )
  if (properties.some((names) => names.role.toLowerCase() === normalized)) return 0
  if (properties.some((names) => names.importance.toLowerCase() === normalized)) return 1
  return 2
}

export interface TocEntry {
  /** Position among the headings of the page, in reading order. */
  index: number
  /** 1 for `#`, 2 for `##`, and so on. */
  level: number
  title: string
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)

function withoutBom(text: string): string {
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text
}

/**
 * The headings of a Markdown page, which is what a dossier's sections are: ordinary headings
 * in the one file. Fenced code and the frontmatter are not searched.
 */
export function extractToc(markdown: string): TocEntry[] {
  const entries: TocEntry[] = []
  let fence: string | null = null
  const lines = withoutBom(markdown).split(/\r?\n/u)
  let start = 0
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
    if (end > 0) start = end + 1
  }
  for (const line of lines.slice(start)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1]
    if (marker) {
      if (fence === null) fence = marker[0]
      else if (marker[0] === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line)
    if (heading) {
      entries.push({ index: entries.length, level: heading[1].length, title: heading[2].trim() })
    }
  }
  return entries
}

/**
 * How much of a dossier is written: its sections are the headings of the highest level on the
 * page (as its tabs are), and a section is filled when text stands under it (under a deeper
 * heading too; the deeper heading alone does not count). Fenced code and the frontmatter are not
 * headings.
 */
export function sectionFill(markdown: string): { filled: number; total: number } {
  const lines = withoutBom(markdown).split(/\r?\n/u)
  let start = 0
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
    if (end > 0) start = end + 1
  }
  const blocks: { level: number | null; text: string }[] = []
  let fence: string | null = null
  for (const line of lines.slice(start)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1]
    if (marker) {
      if (fence === null) fence = marker[0]
      else if (marker[0] === fence) fence = null
      blocks.push({ level: null, text: line })
      continue
    }
    const heading = fence === null ? /^\s{0,3}(#{1,6})\s+\S/u.exec(line) : null
    blocks.push({ level: heading ? heading[1].length : null, text: line })
  }
  const levels = blocks.flatMap((block) => (block.level === null ? [] : [block.level]))
  if (levels.length === 0) return { filled: 0, total: 0 }
  const top = Math.min(...levels)
  let total = 0
  let filled = 0
  let current = false
  for (const block of blocks) {
    if (block.level === top) {
      total += 1
      current = false
      continue
    }
    // A deeper heading alone is not content: an empty template stays empty.
    if (total > 0 && !current && block.level === null && block.text.trim() !== "") {
      current = true
      filled += 1
    }
  }
  return { filled, total }
}

export interface ReferenceGroup {
  key: string
  /** The relation property's name, e.g. "Участники". */
  label: string
  direction: NoteReference["direction"]
  items: NoteReference[]
}

export interface SplitReferences {
  /** The pages of the story's text that point at this note. */
  appearsIn: NoteReference[]
  /** Every other relation, grouped by property and direction. */
  connections: ReferenceGroup[]
}

/**
 * "Appears in" is who in the text relates to this note; "Connections" is the rest, in both
 * directions. Both are computed, never stored in the note.
 */
export function splitReferences(
  references: NoteReference[],
  textDatabaseId: string | null | Set<string> = null,
  /** References another block of the aside already shows: left out of both lists. */
  hidden: (reference: NoteReference) => boolean = () => false,
): SplitReferences {
  const textDbSet =
    textDatabaseId instanceof Set
      ? textDatabaseId
      : textDatabaseId
        ? new Set([textDatabaseId])
        : null
  const appearsIn: NoteReference[] = []
  const groups = new Map<string, ReferenceGroup>()
  for (const reference of references) {
    if (hidden(reference)) continue
    if (
      textDbSet !== null &&
      reference.direction === "in" &&
      reference.databaseId !== null &&
      textDbSet.has(reference.databaseId)
    ) {
      appearsIn.push(reference)
      continue
    }
    const key = `${reference.direction}:${reference.propertyId}`
    const group = groups.get(key) ?? {
      key,
      label: reference.propertyName,
      direction: reference.direction,
      items: [],
    }
    group.items.push(reference)
    groups.set(key, group)
  }
  return { appearsIn, connections: [...groups.values()] }
}
