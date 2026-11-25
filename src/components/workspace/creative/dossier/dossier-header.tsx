import { useTranslation } from "react-i18next"
import { PropertyValue } from "../../database/property-value"
import { cardProperties } from "../../database/value-format"
import { GalleryCover } from "../../database/layouts/gallery-cover"
import { resolveGalleryPreview } from "../../database/layouts/gallery-preview"
import { useCoverResolver } from "../../database/layouts/use-cover-resolver"
import { DanglingStoryLink } from "../workshop/dangling-story-link"
import { PortraitDot } from "../workshop/portrait-dot"
import { initialsOf } from "../workshop/workshop-model"
import { characterFieldPriority, dossierStories, sectionFill } from "./dossier-model"
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
  const stories = isCharacter ? dossierStories(dossier) : []
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

  return (
    <header className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-start">
      {isCharacter ? (
        <PortraitDot
          relativePath={preview.kind === "asset" ? preview.relativePath : null}
          resolver={resolver}
          initials={initialsOf(context.row.title)}
          className="size-16 text-xl"
        />
      ) : preview.kind === "asset" ? (
        <div className="w-full shrink-0 overflow-hidden rounded-xl border border-border/60 sm:w-44">
          <GalleryCover preview={preview} resolver={resolver} size="large" />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {stories.length > 0 && (
          <ul aria-label={t("creative.sections.stories")} className="flex flex-wrap gap-1.5">
            {stories.map((story) => (
              <li
                key={story.storyId}
                className="rounded-full bg-accent px-2 py-0.5 text-xs text-muted-foreground"
              >
                {story.name}
              </li>
            ))}
          </ul>
        )}
        <DanglingStoryLink
          workshop={world.workshop}
          databaseId={context.databaseId}
          row={context.row}
          locked={locked || context.locked}
        />
        <dl className="flex flex-col gap-1">
          {shown.map((property) => (
            <div
              key={property.propertyId}
              className="grid grid-cols-[minmax(5rem,30%)_minmax(0,1fr)] items-start gap-2"
            >
              <dt className="truncate pt-0.5 text-xs text-muted-foreground" title={property.name}>
                {property.name}
              </dt>
              <dd className="min-w-0">
                <PropertyValue property={property} />
              </dd>
            </div>
          ))}
          {missing.map((property) => (
            <div
              key={property.propertyId}
              className="grid grid-cols-[minmax(5rem,30%)_minmax(0,1fr)] items-start gap-2"
            >
              <dt className="truncate pt-0.5 text-xs text-muted-foreground" title={property.name}>
                {property.name}
              </dt>
              <dd className="pt-0.5 text-xs text-muted-foreground/70">
                {t("creative.dossier.notSet")}
              </dd>
            </div>
          ))}
        </dl>
        {fill.total > 1 && (
          <p className="text-xs text-muted-foreground">
            {t("creative.dossier.filled", { filled: fill.filled, count: fill.total })}
          </p>
        )}
      </div>
    </header>
  )
}
