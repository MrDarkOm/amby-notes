import * as React from "react"
import type { DatabasePropertySummary, DatabaseRow } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { DatabaseValueCell, type CardCellEdit } from "../database-value-cell"
import { PageIcon } from "../page-icon"
import { CardEditToggle } from "./card-edit-toggle"
import { useCardActive } from "./use-card-active"
import { CardSurface } from "./card-surface"
import { CardTitleInput } from "./card-title-input"

export interface BoardCardProps {
  row: DatabaseRow
  laneKey: string
  /** Position of the card's lane, for moving the card with the arrow keys. */
  laneIndex: number
  laneCount: number
  pending: boolean
  /** The card is being dragged: its place stays, dimmed. */
  dragging: boolean
  /** Place in its lane, for the entrance animation. */
  enterIndex?: number
  properties: DatabasePropertySummary[]
  relationTitles?: Record<string, string>
  cardFields: string[] | null
  cardEdit?: CardCellEdit
  groupPropertyId: string | null
  onPointerDown: (event: React.PointerEvent<HTMLElement>, row: DatabaseRow, laneKey: string) => void
  /** True once for the click that ends a drag. */
  consumeClick: () => boolean
  onMoveRow: (row: DatabaseRow, laneKey: string) => Promise<void>
  onRowSelect?: (row: DatabaseRow) => void
}

/** A board card: opens its record, can be dragged to another lane, edits only after the pencil. */
export function BoardCard({
  row,
  laneKey,
  laneIndex,
  laneCount,
  pending,
  dragging,
  enterIndex,
  properties,
  relationTitles,
  cardFields,
  cardEdit,
  groupPropertyId,
  onPointerDown,
  consumeClick,
  onMoveRow,
  onRowSelect,
}: BoardCardProps) {
  const [editing, setEditing] = React.useState(false)
  const { active, activeProps } = useCardActive()
  return (
    <CardSurface
      {...activeProps}
      aria-busy={pending}
      lift={!editing}
      enterIndex={enterIndex}
      className={cn(
        "relative w-full rounded-xl border bg-card px-3 py-2.5 text-left text-xs shadow-sm aria-disabled:opacity-60",
        // A card that can be dragged has no selectable text; its inputs (edit mode) keep theirs.
        editing
          ? "cursor-default border-primary/40 ring-2 ring-primary/20"
          : "cursor-grab select-none border-border/60 hover:border-border hover:shadow-md",
        dragging && "opacity-35",
      )}
      disabled={pending}
      onPointerDown={editing || pending ? undefined : (event) => onPointerDown(event, row, laneKey)}
      onClickCapture={(event) => {
        if (!consumeClick()) return
        event.preventDefault()
        event.stopPropagation()
      }}
      onOpen={editing ? undefined : () => onRowSelect?.(row)}
      onKeyDown={(event) => {
        // Keys typed in a property control must not move the card.
        if (event.target !== event.currentTarget) return
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
        const targetIndex = laneIndex + (event.key === "ArrowLeft" ? -1 : 1)
        if (targetIndex < 0 || targetIndex >= laneCount || pending) return
        event.preventDefault()
        const target = document.querySelector<HTMLElement>(
          `[data-board-lane-index="${targetIndex}"]`,
        )
        const targetKey = target?.dataset.boardLaneKey
        if (targetKey) void onMoveRow(row, targetKey)
      }}
    >
      {cardEdit && (
        <CardEditToggle
          editing={editing}
          active={active}
          onToggle={() => setEditing((on) => !on)}
        />
      )}
      <span className="flex min-w-0 items-center gap-1.5 pr-6">
        <PageIcon noteId={row.noteId} editable={editing && Boolean(cardEdit)} />
        {editing && cardEdit?.onRename ? (
          <CardTitleInput
            value={row.title}
            className="font-medium"
            onCommit={(name) => cardEdit.onRename!(row, name)}
          />
        ) : (
          <span className="truncate font-medium">{row.title}</span>
        )}
      </span>
      <DatabaseValueCell
        row={row}
        properties={properties}
        relationTitles={relationTitles}
        fields={cardFields}
        edit={editing ? cardEdit : undefined}
        exclude={groupPropertyId ? [groupPropertyId] : undefined}
      />
    </CardSurface>
  )
}
