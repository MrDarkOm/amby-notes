import * as React from "react"
import type {
  DatabaseFilterNode,
  DatabasePropertySummary,
  DatabaseRow,
  DatabaseSortSpec,
} from "@/lib/storage"
import { BoardView } from "./layouts"
import type { CardCellEdit } from "./database-value-cell"
import { useBoardLanes } from "./use-board-lanes"

interface BoardLanesViewProps {
  databaseId: string
  groupProperty: DatabasePropertySummary
  properties: DatabasePropertySummary[]
  relationTitles?: Record<string, string>
  cardFields?: string[] | null
  cardEdit?: CardCellEdit
  filter?: DatabaseFilterNode
  sorts?: DatabaseSortSpec[]
  search?: string
  contextPageId?: string
  enabled: boolean
  onRowSelect?: (row: DatabaseRow) => void
  /** Persists the new value; rejects when it could not be saved. */
  onMoveRow?: (row: DatabaseRow, laneKey: string) => Promise<void>
}

/** A board whose lanes come from the whole view: full counts, per-lane paging. */
export function BoardLanesView({
  databaseId,
  groupProperty,
  properties,
  relationTitles,
  cardFields,
  cardEdit,
  filter,
  sorts,
  search,
  contextPageId,
  enabled,
  onRowSelect,
  onMoveRow,
}: BoardLanesViewProps) {
  const board = useBoardLanes({
    databaseId,
    groupPropertyId: groupProperty.propertyId,
    options: groupProperty.options,
    filter,
    sorts,
    search,
    contextPageId,
    enabled,
  })
  const laneOf = React.useCallback(
    (noteId: string) =>
      board.lanes.find((lane) => lane.rows.some((row) => row.noteId === noteId))?.key,
    [board.lanes],
  )
  const moveRow = React.useCallback(
    async (row: DatabaseRow, laneKey: string) => {
      const from = laneOf(row.noteId)
      if (from) board.moveLocally(row, from, laneKey)
      try {
        await onMoveRow?.(row, laneKey)
        // The saved row has a new revision; reload so later edits do not conflict.
        board.reload()
      } catch (failure) {
        // Put the card back from the source of truth.
        board.reload()
        throw failure
      }
    },
    [board, laneOf, onMoveRow],
  )
  // A changed property can move a card to another lane or out of the filter.
  const laneEdit = React.useMemo<CardCellEdit | undefined>(
    () =>
      cardEdit && {
        ...cardEdit,
        onCommit: async (row, property, valueJson) => {
          await cardEdit.onCommit(row, property, valueJson)
          board.reload()
        },
        onRename: cardEdit.onRename
          ? async (row, name) => {
              await cardEdit.onRename?.(row, name)
              board.reload()
            }
          : undefined,
      },
    // `board.reload` is stable per render of the hook's state; the lanes reload on any change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cardEdit],
  )
  const groupField = React.useMemo(
    () => ({ kind: "property" as const, propertyId: groupProperty.propertyId }),
    [groupProperty.propertyId],
  )
  return (
    <BoardView
      rows={[]}
      lanes={board.lanes}
      onLoadMoreLane={board.loadMore}
      properties={properties}
      relationTitles={relationTitles}
      cardFields={cardFields}
      cardEdit={laneEdit}
      groupField={groupField}
      loading={board.status === "loading"}
      error={board.error}
      onRetry={board.reload}
      onRowSelect={onRowSelect}
      onMoveRow={moveRow}
    />
  )
}
