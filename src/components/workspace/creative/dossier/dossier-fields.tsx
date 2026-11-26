import * as React from "react"
import { useTranslation } from "react-i18next"
import { NoticeLine } from "@/components/workspace/notices/notice-line"
import {
  applyDatabaseValueBatch,
  type DatabaseNoteContext,
  type DatabasePropertySummary,
} from "@/lib/storage"
import { projectErrorText } from "@/lib/operation-errors"
import { DatabaseCell } from "../../database/database-cell"
import { PropertyValue } from "../../database/property-value"
import { cardProperties } from "../../database/value-format"

/**
 * Fields of a dossier page as cards: in the header, and in a tab for the fields its template puts
 * there. On a page that can be edited each is the database's own cell editor and a change is
 * written with the row's revision; read only, the values the page has, and the `notSet` ones named
 * with a quiet "not set".
 */
export function DossierFields({
  context,
  properties,
  editable,
  notSet = [],
}: {
  context: DatabaseNoteContext
  /** The fields to show, in order. */
  properties: DatabasePropertySummary[]
  editable: boolean
  /** Read only: fields named even without a value. */
  notSet?: DatabasePropertySummary[]
}) {
  const { t, i18n } = useTranslation()
  const [pending, setPending] = React.useState<string | null>(null)
  const [error, setError] = React.useState<{ propertyId: string; text: string } | null>(null)

  const commit = async (propertyId: string, valueJson?: string) => {
    setPending(propertyId)
    setError(null)
    try {
      await applyDatabaseValueBatch({
        expectedGeneration: context.vaultGeneration,
        databaseId: context.databaseId,
        operationId: `dossier-${crypto.randomUUID()}`,
        cells: [
          {
            noteId: context.row.noteId,
            propertyId,
            expectedRevision: context.row.rowRevision,
            ...(valueJson === undefined ? {} : { valueJson }),
          },
        ],
      })
    } catch (caught) {
      setError({ propertyId, text: projectErrorText(t, caught) })
    } finally {
      setPending(null)
    }
  }

  const card = (key: string, name: string, value: React.ReactNode) => (
    <div
      key={key}
      role="group"
      aria-label={name}
      className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-muted/40 px-2.5 py-1.5"
    >
      <span className="truncate text-[11px] text-muted-foreground" title={name}>
        {name}
      </span>
      <div className="min-w-0 text-sm">{value}</div>
    </div>
  )

  const cards = editable
    ? properties.map((property) =>
        card(
          property.propertyId,
          property.name,
          <>
            <DatabaseCell
              property={property}
              valuesJson={context.row.valuesJson}
              compact
              pending={pending === property.propertyId}
              error={error?.propertyId === property.propertyId ? error.text : null}
              onCommit={(valueJson) => commit(property.propertyId, valueJson)}
            />
            {error?.propertyId === property.propertyId && (
              <NoticeLine text={error.text} role="status" />
            )}
          </>,
        ),
      )
    : [
        ...cardProperties(context.row.valuesJson, properties, { locale: i18n.language }).map(
          (property) =>
            card(property.propertyId, property.name, <PropertyValue property={property} />),
        ),
        ...notSet.map((property) =>
          card(
            property.propertyId,
            property.name,
            <span className="text-xs text-muted-foreground/70">
              {t("creative.dossier.notSet")}
            </span>,
          ),
        ),
      ]
  if (cards.length === 0) return null
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2">{cards}</div>
}
