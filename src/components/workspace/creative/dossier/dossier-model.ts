import type {
  NoteReference,
  ProjectCatalog,
  ProjectSectionSummary,
  ProjectSummary,
} from "@/lib/storage"

/** The roles that are not part of the world: the manuscript and plain notes have no dossier. */
const NON_WORLD_ROLES = new Set(["text", "notes"])

export interface WorldSection {
  project: ProjectSummary
  section: ProjectSectionSummary
}

/**
 * The creative section a database is, when its pages are dossiers: any section of a project
 * but the text and the notes. A section whose database is missing cannot hold a page.
 */
export function worldSectionOf(
  catalog: ProjectCatalog | null,
  databaseId: string,
): WorldSection | null {
  for (const project of catalog?.projects ?? []) {
    const section = project.sections.find(
      (candidate) => candidate.databaseId === databaseId && candidate.state !== "missing",
    )
    if (section && !NON_WORLD_ROLES.has(section.role ?? "")) return { project, section }
  }
  return null
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
  textDatabaseId: string | null,
): SplitReferences {
  const appearsIn: NoteReference[] = []
  const groups = new Map<string, ReferenceGroup>()
  for (const reference of references) {
    if (
      textDatabaseId !== null &&
      reference.direction === "in" &&
      reference.databaseId === textDatabaseId
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
