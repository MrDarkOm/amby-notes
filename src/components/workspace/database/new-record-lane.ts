import { applyDatabaseValueBatch, getFileRevision, type CreatedDatabaseRow } from "@/lib/storage"
import { EMPTY_BOARD_LANE } from "./layouts/board-model"

/**
 * Puts a page that was just created from a board lane into that lane: writes the
 * lane's option into the group property. A "no value" lane needs no write. The write
 * is checked against the page as it was just created, so the revision is read first.
 */
export async function placeNewRecordInLane({
  vaultGeneration,
  databaseId,
  created,
  groupProperty,
  laneKey,
}: {
  vaultGeneration: number
  databaseId: string
  created: CreatedDatabaseRow
  groupProperty: { propertyId: string; propertyType: string }
  laneKey: string
}): Promise<void> {
  if (laneKey === EMPTY_BOARD_LANE) return
  if (groupProperty.propertyType !== "select" && groupProperty.propertyType !== "status") return
  const expectedRevision = await getFileRevision(created.notePath)
  await applyDatabaseValueBatch({
    expectedGeneration: vaultGeneration,
    databaseId,
    operationId: `board-new-${Date.now()}-${created.noteId}`,
    cells: [
      {
        noteId: created.noteId,
        propertyId: groupProperty.propertyId,
        valueJson: JSON.stringify({ type: groupProperty.propertyType, optionId: laneKey }),
        expectedRevision,
      },
    ],
  })
}
