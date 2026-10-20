import type { DatabaseRow, ProjectCatalog, WorkshopSummary } from "@/lib/storage"
import { sectionName, standaloneTargetId, universeTargetId } from "./project-tree-model"
import { ancestorIds, buildTextTree, findNode } from "./workshop/text-tree-model"
import { relationTargetsOf } from "./workshop/workshop-model"
import { textStoryOf, worldSectionOf } from "./dossier/dossier-model"

/** Where a step of a note's trail leads: a workshop page (and section tab), or another note. */
export type TrailTarget =
  { kind: "page"; projectId: string; sectionId?: string } | { kind: "note"; noteId: string }

/** One crumb of the logical path of a note; the last is the note and leads nowhere. */
export interface TrailStep {
  key: string
  label: string
  to?: TrailTarget
}

export interface NoteTrailInput {
  catalog: ProjectCatalog | null
  /** The database the note is a row of. */
  databaseId: string
  /** The note's own row. */
  row: Pick<DatabaseRow, "noteId" | "title" | "categoryPath">
  /** Rows by database ID, for the databases `trailDatabaseIds` named; `undefined` is not read yet. */
  rows: Readonly<Record<string, readonly DatabaseRow[] | undefined>>
  labels: {
    /** "Workshop": the root of every trail. */
    workshop: string
    /** "Standalone stories". */
    standalone: string
    /** A universe whose name is not known. */
    universe: string
  }
}

const SECTION_BASES = new Set(["text", "notes", "stories", "universes"])

function stepOf(key: string, label: string, to?: TrailTarget): TrailStep {
  return { key, label, to }
}

function storiesBase(workshop: WorkshopSummary) {
  return workshop.sections.find((s) => s.role === "stories" && s.state !== "missing") ?? null
}

function universesBase(workshop: WorkshopSummary) {
  return workshop.sections.find((s) => s.role === "universes" && s.state !== "missing") ?? null
}

/**
 * The databases whose rows `noteTrail` reads for a note of `databaseId`: a page of a story's text
 * needs the text (for the pages above it) and the stories and universes bases (for the story's
 * universe); a story's card needs the same two bases; every other place needs none.
 */
export function trailDatabaseIds(catalog: ProjectCatalog | null, databaseId: string): string[] {
  const text = textStoryOf(catalog, databaseId)
  const place = text ?? storyCardPlace(catalog, databaseId)
  if (!place) return []
  const workshop = place.workshop
  const ids = text ? [databaseId] : []
  const stories = storiesBase(workshop)
  const universes = universesBase(workshop)
  if (stories?.universePropertyId) ids.push(stories.databaseId)
  if (stories?.universePropertyId && universes) ids.push(universes.databaseId)
  return ids
}

function storyCardPlace(catalog: ProjectCatalog | null, databaseId: string) {
  for (const workshop of catalog?.workshops ?? []) {
    const section = workshop.sections.find(
      (candidate) =>
        candidate.role === "stories" &&
        candidate.state !== "missing" &&
        candidate.databaseId === databaseId,
    )
    if (section) return { workshop }
  }
  return null
}

/** Workshop › (universe | standalone stories) › story: the start of a story's trails. */
function storyTrail(
  workshop: WorkshopSummary,
  storyId: string,
  cardNoteId: string | null,
  input: NoteTrailInput,
  storyIsCurrent: boolean,
): TrailStep[] | null {
  const steps: TrailStep[] = [
    stepOf("workshop", input.labels.workshop, { kind: "page", projectId: workshop.workshopId }),
  ]
  const stories = storiesBase(workshop)
  const propertyId = stories?.universePropertyId ?? null
  let universeId: string | null = null
  let universeTitle: string | undefined
  if (stories && propertyId && cardNoteId) {
    const cards = input.rows[stories.databaseId]
    if (!cards) return null
    const card = cards.find((candidate) => candidate.noteId === cardNoteId)
    universeId = card ? (relationTargetsOf(card.valuesJson, propertyId)[0] ?? null) : null
    const universes = universesBase(workshop)
    if (universeId && universes) {
      const universeRows = input.rows[universes.databaseId]
      if (!universeRows) return null
      universeTitle = universeRows.find((row) => row.noteId === universeId)?.title
    }
  }
  steps.push(
    universeId
      ? stepOf("parent", universeTitle?.trim() || input.labels.universe, {
          kind: "page",
          projectId: universeTargetId(universeId),
        })
      : stepOf("parent", input.labels.standalone, {
          kind: "page",
          projectId: standaloneTargetId(workshop.workshopId),
        }),
  )
  const story = workshop.stories.find((candidate) => candidate.storyId === storyId)
  steps.push(
    stepOf(
      "story",
      story?.name ?? "",
      storyIsCurrent ? undefined : { kind: "page", projectId: storyId },
    ),
  )
  return steps
}

/**
 * The logical path of a note that belongs to the active workshop, or `null` for any other note and
 * while something it needs has not been read yet (the header then keeps the folder path):
 *
 * - a page of a story's text: Workshop › universe | Standalone stories › story › the pages above it › page;
 * - a story's own card: Workshop › universe | Standalone stories › story;
 * - a universe's note: Workshop › universe;
 * - a page of a world or plot section: Workshop › section › page (these pages are shared, so no story);
 * - a note of the notes base: Workshop › Notes › its notebooks › note.
 *
 * Every step but the last leads to a workshop page (the section's tab where it is a section) or
 * to a page of the text.
 */
export function noteTrail(input: NoteTrailInput): TrailStep[] | null {
  const { catalog, databaseId, row, labels } = input
  const own = stepOf("note", row.title)

  const text = textStoryOf(catalog, databaseId)
  if (text) {
    const head = storyTrail(text.workshop, text.story.storyId, text.story.cardNoteId, input, false)
    const textRows = input.rows[databaseId]
    if (!head || !textRows || !text.story.text) return null
    const roots = buildTextTree(textRows as DatabaseRow[], text.story.text.properties)
    const above = ancestorIds(roots, row.noteId)
    if (!above) return null
    const parents = above.map((id) =>
      stepOf(`page:${id}`, findNode(roots, id)?.title ?? "", { kind: "note", noteId: id }),
    )
    return [...head, ...parents, own]
  }

  for (const workshop of catalog?.workshops ?? []) {
    const stories = storiesBase(workshop)
    if (stories?.databaseId === databaseId) {
      const story = workshop.stories.find((candidate) => candidate.cardNoteId === row.noteId)
      if (!story) return null
      return storyTrail(workshop, story.storyId, story.cardNoteId, input, true)
    }
    const universes = universesBase(workshop)
    if (universes?.databaseId === databaseId) {
      return [
        stepOf("workshop", labels.workshop, { kind: "page", projectId: workshop.workshopId }),
        stepOf("universe", row.title),
      ]
    }
    const notes = workshop.sections.find(
      (section) => section.role === "notes" && section.state !== "missing",
    )
    if (notes?.databaseId === databaseId) {
      const tab = { kind: "page" as const, projectId: workshop.workshopId, sectionId: notes.id }
      return [
        stepOf("workshop", labels.workshop, { kind: "page", projectId: workshop.workshopId }),
        stepOf("section", sectionName(notes), tab),
        ...row.categoryPath.map((segment, index) =>
          stepOf(`notebook:${row.categoryPath.slice(0, index + 1).join("/")}`, segment, tab),
        ),
        own,
      ]
    }
  }

  const world = worldSectionOf(catalog, databaseId)
  if (world && !SECTION_BASES.has(world.section.role ?? "")) {
    return [
      stepOf("workshop", labels.workshop, { kind: "page", projectId: world.workshop.workshopId }),
      stepOf("section", sectionName(world.section), {
        kind: "page",
        projectId: world.workshop.workshopId,
        sectionId: world.section.id,
      }),
      own,
    ]
  }
  return null
}
