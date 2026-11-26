import * as React from "react"
import { useTranslation } from "react-i18next"
import { NoticeLine } from "@/components/workspace/notices/notice-line"
import { applyDatabaseValueBatch } from "@/lib/storage"
import { projectErrorText } from "@/lib/operation-errors"
import { DatabaseCell } from "../../database/database-cell"
import { PropertyValue } from "../../database/property-value"
import { cardProperties } from "../../database/value-format"
import { resolveGalleryPreview } from "../../database/layouts/gallery-preview"
import { useCoverResolver } from "../../database/layouts/use-cover-resolver"
import { DanglingStoryLink } from "../workshop/dangling-story-link"
import { characterFieldPriority, sectionFill } from "./dossier-model"
import { PortraitControl } from "./portrait-control"
import type { NoteDossier } from "./use-note-dossier"

/**
 * The top of a dossier: the portrait or cover, the key properties and where the page lives.
 * The name is the page's own title above it. Values are read from the note's frontmatter
 * through the database; nothing here is stored.
 */
export function DossierHeader({
  dossier,
  locked,
  content,
}: {
  dossier: NoteDossier
  locked?: boolean
  /** The page's Markdown, to say how many of its sections are written. */
  content: string
}) {
  const { t, i18n } = useTranslation()
  const { context, world } = dossier
  const isCharacter = world.section.role === "characters"
  const properties = isCharacter
    ? [...context.properties].sort(
        (a, b) => characterFieldPriority(a.name) - characterFieldPriority(b.name),
      )
    : context.properties
  const resolver = useCoverResolver(context.databaseId, context.vaultGeneration)
  const preview = resolveGalleryPreview(context.row.valuesJson)
  // Pictures are shown as the portrait and relations in the side blocks, not as values.
  const hidden = context.properties
    .filter((property) => property.propertyType === "files" || property.propertyType === "relation")
    .map((property) => property.propertyId)
  const shown = cardProperties(context.row.valuesJson, properties, {
    exclude: hidden,
    limit: 8,
    locale: i18n.language,
  })
  // A character's role and importance are what a reader looks for first: when empty they are
  // still named, quietly, so the author sees what is missing.
  const shownIds = new Set(shown.map((property) => property.propertyId))
  const missing = isCharacter
    ? properties.filter(
        (property) =>
          characterFieldPriority(property.name) < 2 &&
          !shownIds.has(property.propertyId) &&
          !hidden.includes(property.propertyId),
      )
    : []
  const fill = sectionFill(content)
  const editable = !locked && !context.locked
  // Editable, every field of the page is there to be filled in; read only, the values it has and
  // a character's empty key fields.
  const editableFields = properties
    .filter((property) => !hidden.includes(property.propertyId))
    .slice(0, FIELD_LIMIT)
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

  const fieldCard = (key: string, name: string, value: React.ReactNode) => (
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

  return (
    <header className="mb-5 flex flex-col gap-5 sm:flex-row sm:items-start">
      <PortraitControl
        context={context}
        preview={preview}
        resolver={resolver}
        round={isCharacter}
        locked={locked}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <DanglingStoryLink
          workshop={world.workshop}
          databaseId={context.databaseId}
          row={context.row}
          locked={locked || context.locked}
        />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2">
          {editable
            ? editableFields.map((property) =>
                fieldCard(
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
                ...shown.map((property) =>
                  fieldCard(
                    property.propertyId,
                    property.name,
                    <PropertyValue property={property} />,
                  ),
                ),
                ...missing.map((property) =>
                  fieldCard(
                    property.propertyId,
                    property.name,
                    <span className="text-xs text-muted-foreground/70">
                      {t("creative.dossier.notSet")}
                    </span>,
                  ),
                ),
              ]}
        </div>
        {fill.total > 1 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span aria-hidden="true" className="h-1 w-24 overflow-hidden rounded-full bg-accent">
              <span
                className="block h-full bg-primary/60"
                style={{ width: `${Math.round((fill.filled / fill.total) * 100)}%` }}
              />
            </span>
            {t("creative.dossier.filled", { filled: fill.filled, count: fill.total })}
          </div>
        )}
      </div>
    </header>
  )
}

/** A header holds the key fields only; the rest of the properties are in the database. */
const FIELD_LIMIT = 8
