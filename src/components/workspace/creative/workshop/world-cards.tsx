import { Database } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { DatabaseRow, WorkshopSectionSummary, WorkshopSummary } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { resolveGalleryPreview } from "../../database/layouts/gallery-preview"
import { sectionRoleIcon } from "../section-icons"
import { PortraitDot } from "./portrait-dot"
import { usePortraitResolvers } from "./use-portrait-resolvers"
import { initialsOf } from "./workshop-model"

/** How many pages of a section its card lists before "all". */
const CARD_ITEMS = 6

/** A section shown as a card, with the workshop whose folder holds it. */
export interface WorldCard {
  owner: WorkshopSummary
  section: WorkshopSectionSummary
  /** The pages of the section that belong to what the page shows, already filtered. */
  rows: readonly DatabaseRow[]
}

function sectionTitle(section: WorkshopSectionSummary): string {
  return section.databaseName?.trim() || section.pathHint.split("/").pop() || section.id
}

/**
 * The world beside the text of a story or the stories of a universe: one card per section with
 * the first pages that belong here. The pages come in already filtered by story or universe.
 */
export function WorldCards({
  cards,
  loading,
  vaultGeneration,
  onOpenNote,
  onOpenSection,
}: {
  cards: readonly WorldCard[]
  loading: boolean
  vaultGeneration: number | null
  onOpenNote: (noteId: string) => void
  /** Opens a section as a table. */
  onOpenSection?: (ownerId: string, sectionId: string) => void
}) {
  const { t } = useTranslation()
  const resolverFor = usePortraitResolvers(vaultGeneration)
  const card = "rounded-2xl border border-border bg-card p-5"
  const heading = "text-sm font-semibold"
  return (
    <>
      {cards.map(({ owner, section, rows: items }) => {
        const Icon = section.role ? sectionRoleIcon(section.role) : Database
        const people = section.role === "characters"
        return (
          <section key={section.databaseId} aria-label={sectionTitle(section)} className={card}>
            <div className="mb-2 flex items-center gap-2">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <h2 className={cn(heading, "min-w-0 truncate")}>{sectionTitle(section)}</h2>
              <span className="text-xs text-muted-foreground">{items.length || null}</span>
              {onOpenSection && (
                <button
                  type="button"
                  onClick={() => onOpenSection(owner.workshopId, section.id)}
                  className="ml-auto shrink-0 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {t("creative.page.desk.openSection")}
                </button>
              )}
            </div>
            {items.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {loading ? "" : t("creative.workshop.world.noItems")}
              </p>
            ) : (
              <ul className={cn("grid gap-0.5", people && "grid-cols-2")}>
                {items.slice(0, CARD_ITEMS).map((row) => {
                  const preview = people ? resolveGalleryPreview(row.valuesJson) : null
                  return (
                    <li key={row.noteId} className="min-w-0">
                      <button
                        type="button"
                        onClick={() => onOpenNote(row.noteId)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-accent"
                      >
                        {people && (
                          <PortraitDot
                            relativePath={preview?.kind === "asset" ? preview.relativePath : null}
                            resolver={resolverFor(section.databaseId)}
                            initials={initialsOf(row.title)}
                            className="size-7 text-[10px]"
                          />
                        )}
                        <span className="min-w-0 truncate">{row.title}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            {items.length > CARD_ITEMS && (
              <p className="px-2 pt-1 text-xs text-muted-foreground">
                {t("creative.page.desk.more", { count: items.length - CARD_ITEMS })}
              </p>
            )}
          </section>
        )
      })}
    </>
  )
}
