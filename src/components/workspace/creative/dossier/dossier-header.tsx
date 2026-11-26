import { LayoutTemplate } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import type { DossierLayout } from "@/lib/storage"
import { cardProperties } from "../../database/value-format"
import { resolveGalleryPreview } from "../../database/layouts/gallery-preview"
import { useCoverResolver } from "../../database/layouts/use-cover-resolver"
import { DanglingStoryLink } from "../workshop/dangling-story-link"
import { DossierFields } from "./dossier-fields"
import { fieldsOutsideSections } from "./dossier-layout-model"
import { characterFieldPriority, sectionFill } from "./dossier-model"
import { PortraitControl } from "./portrait-control"
import type { NoteDossier } from "./use-note-dossier"

/** A header holds the key fields only; the rest of the properties are in the database. */
const FIELD_LIMIT = 8

/**
 * The top of a dossier: the portrait or cover, the key fields and how much is written. Fields the
 * section's template puts in a tab are shown there instead. On a page that can be edited, the
 * fields change in place and the template can be opened. Values are the note's own frontmatter
 * through the database; nothing here is stored but what the author changes.
 */
export function DossierHeader({
  dossier,
  locked,
  content,
  layout = null,
  onOpenTemplate,
}: {
  dossier: NoteDossier
  locked?: boolean
  /** The page's Markdown, to say how many of its sections are written. */
  content: string
  /** The dossier layout of the section's template, when it has one. */
  layout?: DossierLayout | null
  onOpenTemplate?: () => void
}) {
  const { t, i18n } = useTranslation()
  const { context, world } = dossier
  const isCharacter = world.section.role === "characters"
  const resolver = useCoverResolver(context.databaseId, context.vaultGeneration)
  const preview = resolveGalleryPreview(context.row.valuesJson)
  // Pictures are the portrait and relations are in the side blocks, not fields; fields of a
  // template's section are in their tab.
  const outside = new Set(
    fieldsOutsideSections(
      layout,
      context.properties.map((property) => property.propertyId),
    ),
  )
  const properties = (
    isCharacter
      ? [...context.properties].sort(
          (a, b) => characterFieldPriority(a.name) - characterFieldPriority(b.name),
        )
      : context.properties
  ).filter(
    (property) =>
      property.propertyType !== "files" &&
      property.propertyType !== "relation" &&
      outside.has(property.propertyId),
  )
  const editable = !locked && !context.locked
  // Read only, a character's empty role and importance are still named, quietly.
  const filled = new Set(
    cardProperties(context.row.valuesJson, properties, { locale: i18n.language }).map(
      (property) => property.propertyId,
    ),
  )
  const notSet = isCharacter
    ? properties.filter(
        (property) => characterFieldPriority(property.name) < 2 && !filled.has(property.propertyId),
      )
    : []
  const fill = sectionFill(content)

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
        <DossierFields
          context={context}
          properties={editable ? properties.slice(0, FIELD_LIMIT) : properties}
          editable={editable}
          notSet={notSet}
        />
        {(fill.total > 1 || (editable && onOpenTemplate)) && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {fill.total > 1 && (
              <>
                <span
                  aria-hidden="true"
                  className="h-1 w-24 overflow-hidden rounded-full bg-accent"
                >
                  <span
                    className="block h-full bg-primary/60"
                    style={{ width: `${Math.round((fill.filled / fill.total) * 100)}%` }}
                  />
                </span>
                {t("creative.dossier.filled", { filled: fill.filled, count: fill.total })}
              </>
            )}
            {editable && onOpenTemplate && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-7 text-xs text-muted-foreground"
                onClick={onOpenTemplate}
              >
                <LayoutTemplate aria-hidden="true" className="size-3.5" />
                {t("creative.template.open")}
              </Button>
            )}
          </div>
        )}
      </div>
    </header>
  )
}
