import { queryDatabase, updateDatabaseRelationValue } from "@/lib/storage"
import { relationTargetsOf } from "./workshop/workshop-model"

const PAGE_SIZE = 200
const MAX_PAGES = 5

/**
 * Puts a story into a universe: writes the "Universe" relation of the story's card row in the
 * stories base. The row is read fresh (its revision is the one the write is checked against) and
 * the write carries the row's complete list of targets, so nothing already there is lost. Rejects
 * when the card is not found or the write is refused; the story itself is never touched.
 */
export async function writeStoryUniverseLink(input: {
  vaultGeneration: number
  /** The database of the stories section. */
  databaseId: string
  /** The note ID of the story's card, a row of that database. */
  cardNoteId: string
  /** The `universePropertyId` of the stories section. */
  propertyId: string
  universeId: string
}): Promise<void> {
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await queryDatabase({
      expectedGeneration: input.vaultGeneration,
      databaseId: input.databaseId,
      source: { kind: "inline", spec: { sorts: [] } },
      page: { limit: PAGE_SIZE, cursor },
    })
    const row = result.rows.find((candidate) => candidate.noteId === input.cardNoteId)
    if (row) {
      const current = relationTargetsOf(row.valuesJson, input.propertyId)
      await updateDatabaseRelationValue({
        expectedGeneration: input.vaultGeneration,
        operationId: `story-universe-${crypto.randomUUID()}`,
        expectedRevision: row.rowRevision,
        databaseId: input.databaseId,
        noteId: input.cardNoteId,
        propertyId: input.propertyId,
        targetNoteIds: current.includes(input.universeId)
          ? current
          : [...current, input.universeId],
      })
      return
    }
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }
  throw new Error("The story's card was not found in the stories base")
}
