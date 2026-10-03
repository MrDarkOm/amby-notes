import { useTranslation } from "react-i18next"
import type { DatabaseRow, DatabasePropertySummary, DatabaseSummary } from "@/lib/storage"
import { DatabaseCell } from "../database-cell"
import { relationTargetDatabaseId } from "../rollup-model"

interface PeekPropertiesProps {
  row: DatabaseRow
  properties: DatabasePropertySummary[]
  databases: DatabaseSummary[]
  currentDatabaseId: string
  pendingCells: Set<string>
  cellErrors: Record<string, string>
  disabled: boolean
  onCommit: (
    row: DatabaseRow,
    property: DatabasePropertySummary,
    valueJson?: string,
  ) => Promise<void>
  onOpenNote?: (noteId: string) => void
  onCreateRelationRow?: (targetDatabaseId: string, title: string) => Promise<string | void>
}

/** All properties of the open record, editable in place above its note. */
export function PeekProperties({
  row,
  properties,
  databases,
  currentDatabaseId,
  pendingCells,
  cellErrors,
  disabled,
  onCommit,
  onOpenNote,
  onCreateRelationRow,
}: PeekPropertiesProps) {
  const { t } = useTranslation()
  if (properties.length === 0) return null
  return (
    <dl className="space-y-0.5">
      {properties.map((property) => {
        const cellKey = `${row.noteId}:${property.propertyId}`
        const targetId =
          property.propertyType === "relation"
            ? relationTargetDatabaseId(property, currentDatabaseId)
            : ""
        return (
          <div
            key={property.propertyId}
            className="grid grid-cols-[minmax(7rem,30%)_minmax(0,1fr)] items-start gap-2"
          >
            <dt className="truncate pt-1.5 text-xs text-muted-foreground" title={property.name}>
              {property.name}
            </dt>
            <dd className="min-w-0">
              <DatabaseCell
                property={property}
                valuesJson={row.valuesJson}
                wrap
                compact
                pending={disabled || pendingCells.has(cellKey)}
                error={cellErrors[cellKey]}
                targetDatabaseTitle={
                  targetId ? databases.find((db) => db.databaseId === targetId)?.title : undefined
                }
                onCommit={(valueJson) => onCommit(row, property, valueJson)}
                onOpenNote={onOpenNote}
                onCreateRelationRow={
                  onCreateRelationRow && targetId
                    ? (title) => onCreateRelationRow(targetId, title)
                    : undefined
                }
              />
            </dd>
          </div>
        )
      })}
      <span className="sr-only">{t("databasePeek.properties")}</span>
    </dl>
  )
}
