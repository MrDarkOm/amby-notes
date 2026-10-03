import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import type { DatabaseRow, DatabasePropertySummary } from "@/lib/storage"
import { DatabaseCell } from "./database-cell"
import { PropertyValue } from "./property-value"
import { cardProperties } from "./value-format"

/** What a card needs to let its properties be changed in place. */
export interface CardCellEdit {
  onCommit: (
    row: DatabaseRow,
    property: DatabasePropertySummary,
    valueJson?: string,
  ) => Promise<void>
  pendingCells: Set<string>
  cellErrors: Record<string, string>
  onOpenNote?: (noteId: string) => void
  /** Renames the record; without it the title of a card in edit mode stays text. */
  onRename?: (row: DatabaseRow, name: string) => Promise<void>
}

interface DatabaseValueCellProps {
  row: DatabaseRow
  properties: DatabasePropertySummary[]
  relationTitles?: Record<string, string>
  /** Property IDs shown elsewhere on the card (for example the Board group). */
  exclude?: string[]
  limit?: number
  /** Properties chosen for the view's cards; `null` shows the first few non-empty ones. */
  fields?: string[] | null
  /** When given, properties are controls instead of read-only labels. */
  edit?: CardCellEdit
  /** One compact line of values at the end of a row (List) instead of a stack under the title. */
  inline?: boolean
}

/** Compact, schema-aware values for Gallery, List and Board cards. */
export function DatabaseValueCell({
  row,
  properties,
  relationTitles,
  exclude,
  limit,
  fields,
  edit,
  inline = false,
}: DatabaseValueCellProps) {
  const { i18n } = useTranslation()
  const shown = cardProperties(row.valuesJson, properties, {
    relationTitles,
    exclude,
    limit,
    fields,
    locale: i18n.language,
  })
  // The properties of a list row or a card in edit mode, in the order the view chose.
  const chosen = () => {
    const candidates = properties.filter((property) => !exclude?.includes(property.propertyId))
    if (!fields) return candidates
    const order = new Map(fields.map((id, index) => [id, index]))
    return candidates
      .filter((property) => order.has(property.propertyId))
      .sort((a, b) => (order.get(a.propertyId) ?? 0) - (order.get(b.propertyId) ?? 0))
  }

  if (inline) {
    // List: one cell per property, each in the grid column the list gives it, so values of
    // different rows line up and sit close together.
    const columns = chosen()
    if (columns.length === 0) return null
    return (
      <>
        {columns.map((property, position) => {
          const cellKey = `${row.noteId}:${property.propertyId}`
          const display = shown.find((candidate) => candidate.propertyId === property.propertyId)
          return (
            <span
              key={property.propertyId}
              // The last column hugs the right edge, so a short value leaves no gap before it.
              className={cn(
                "min-w-0 overflow-hidden",
                position === columns.length - 1 && "justify-self-end",
              )}
              title={property.name}
              onClick={edit ? (event) => event.stopPropagation() : undefined}
              onKeyDown={edit ? (event) => event.stopPropagation() : undefined}
            >
              {edit ? (
                <DatabaseCell
                  property={property}
                  valuesJson={row.valuesJson}
                  compact
                  pending={edit.pendingCells.has(cellKey)}
                  error={edit.cellErrors[cellKey]}
                  onCommit={(valueJson) => edit.onCommit(row, property, valueJson)}
                  onOpenNote={edit.onOpenNote}
                />
              ) : display ? (
                <PropertyValue property={display} />
              ) : null}
            </span>
          )
        })}
      </>
    )
  }
  if (edit) {
    // Editing a card shows every chosen property (all of them when none were
    // chosen), empty ones included, so an empty value can be filled in on the card.
    const editable = chosen()
    if (editable.length === 0) return null
    return (
      <span
        className="mt-2 flex min-w-0 flex-col gap-0.5"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {editable.map((property) => {
          const cellKey = `${row.noteId}:${property.propertyId}`
          return (
            <span
              key={property.propertyId}
              className="grid grid-cols-[minmax(3.5rem,34%)_minmax(0,1fr)] items-start gap-1"
            >
              <span
                className="truncate pt-1.5 text-[10px] text-muted-foreground/80"
                title={property.name}
              >
                {property.name}
              </span>
              <DatabaseCell
                property={property}
                valuesJson={row.valuesJson}
                compact
                wrap
                pending={edit.pendingCells.has(cellKey)}
                error={edit.cellErrors[cellKey]}
                onCommit={(valueJson) => edit.onCommit(row, property, valueJson)}
                onOpenNote={edit.onOpenNote}
              />
            </span>
          )
        })}
      </span>
    )
  }
  if (shown.length === 0) return null
  return (
    <span className="mt-2 flex min-w-0 flex-col gap-1">
      {shown.map((property) => (
        // Only the value: the property's name is the tooltip, as on Notion cards.
        <PropertyValue key={property.propertyId} property={property} />
      ))}
    </span>
  )
}
