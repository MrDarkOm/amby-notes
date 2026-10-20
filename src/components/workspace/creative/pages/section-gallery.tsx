import * as React from "react"
import { Database, FolderOpen } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { DatabaseRow, WorkshopSectionSummary } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { resolveGalleryPreview } from "../../database/layouts/gallery-preview"
import { useDatabaseStore } from "../../database/database-store"
import { projectErrorText } from "../project-error"
import { sectionRoleIcon } from "../section-icons"
import { PortraitDot } from "../workshop/portrait-dot"
import { QuickCreate } from "../workshop/quick-create"
import { usePortraitResolvers } from "../workshop/use-portrait-resolvers"
import { initialsOf, type StoryLabels } from "../workshop/workshop-model"
import { galleryGroups } from "./section-gallery-model"

interface SectionGalleryProps {
  section: WorkshopSectionSummary
  /** The pages to show, already filtered by what the page holds. */
  rows: readonly DatabaseRow[]
  /** The name over the gallery when it is not the section's (the group "No story"). */
  title?: string
  loading?: boolean
  /** The stories a page is in (two names and "+N"); without it the cards carry no chips. */
  storyLabelsOf?: (noteId: string) => StoryLabels
  onOpenNote: (noteId: string) => void
  /** Opens the section as an ordinary database; without it the header has no such button. */
  onOpenAsBase?: () => void
  /** The words of that button, if not "Open as base". */
  openLabel?: string
  /** Makes a page under a typed name; `null` where this gallery cannot get one. */
  createFor?: ((title: string) => Promise<void>) | null
  /** A quiet line under the gallery (what is left out and why). */
  footnote?: string | null
  /**
   * A small list for a widget of the desk, which has its own header: no categories, no heading,
   * small avatars or titles, at most `COMPACT_LIMIT` pages and then "N more".
   */
  compact?: boolean
}

/** How many pages the compact list shows before "N more". */
export const COMPACT_LIMIT = 6

function sectionTitle(section: WorkshopSectionSummary): string {
  return section.databaseName?.trim() || section.pathHint.split("/").pop() || section.id
}

/**
 * A section as a gallery with categories, never as a table: the groups are the property its
 * database's first grouped view uses, each page a card with its picture (or the initials of a
 * character, or the section's icon), its name and the stories it is in. The whole database is one
 * button away.
 */
export function SectionGallery({
  section,
  rows,
  title,
  loading = false,
  storyLabelsOf,
  onOpenNote,
  onOpenAsBase,
  openLabel,
  createFor,
  footnote,
  compact = false,
}: SectionGalleryProps) {
  const { t } = useTranslation()
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const summary = useDatabaseStore((state) =>
    state.databases.find((database) => database.databaseId === section.databaseId),
  )
  const resolverFor = usePortraitResolvers(vaultGeneration)
  const groups = React.useMemo(
    () => galleryGroups(rows, summary, t("creative.gallery.noCategory")),
    [rows, summary, t],
  )
  const name = title ?? sectionTitle(section)
  const Icon = section.role ? sectionRoleIcon(section.role) : Database
  const people = section.role === "characters"
  if (compact) {
    const sorted = [...rows].sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
    )
    const create = createFor ? (
      <QuickCreate
        label={t("creative.workshop.world.addEntity", { name: sectionTitle(section) })}
        placeholder={t("creative.workshop.newEntityPlaceholder", { name: sectionTitle(section) })}
        failed={(message) => t("creative.workshop.createFailed", { message })}
        onCreate={createFor}
        describe={(caught) => projectErrorText(t, caught)}
      />
    ) : null
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {loading ? "" : t("creative.workshop.world.noItems")}
          </p>
        )}
        <ul className={cn("grid gap-1", people ? "grid-cols-2" : "grid-cols-1")}>
          {sorted.slice(0, COMPACT_LIMIT).map((row) => {
            const preview = resolveGalleryPreview(row.valuesJson)
            return (
              <li key={row.noteId} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onOpenNote(row.noteId)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {people ? (
                    <PortraitDot
                      relativePath={preview.kind === "asset" ? preview.relativePath : null}
                      resolver={resolverFor(section.databaseId)}
                      initials={initialsOf(row.title)}
                      className="size-7 text-[10px]"
                    />
                  ) : (
                    <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 break-words">{row.title}</span>
                </button>
              </li>
            )
          })}
        </ul>
        {rows.length > COMPACT_LIMIT && (
          <p className="px-1.5 text-xs text-muted-foreground">
            {t("creative.page.desk.more", { count: rows.length - COMPACT_LIMIT })}
          </p>
        )}
        {create}
        {footnote && <p className="text-xs text-muted-foreground">{footnote}</p>}
      </div>
    )
  }
  return (
    <section aria-label={name} className="flex w-full min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 break-words text-sm font-semibold">{name}</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{rows.length || null}</span>
        {createFor && (
          <QuickCreate
            label={t("creative.workshop.world.addEntity", { name: sectionTitle(section) })}
            placeholder={t("creative.workshop.newEntityPlaceholder", {
              name: sectionTitle(section),
            })}
            failed={(message) => t("creative.workshop.createFailed", { message })}
            onCreate={createFor}
            describe={(caught) => projectErrorText(t, caught)}
          />
        )}
        {onOpenAsBase && (
          <button
            type="button"
            onClick={onOpenAsBase}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="size-3.5" />
            {openLabel ?? t("creative.gallery.openAsBase")}
          </button>
        )}
      </div>
      {rows.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {loading ? "" : t("creative.workshop.world.noItems")}
        </p>
      )}
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-2">
          {group.label !== null && (
            <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              {group.color && (
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full"
                  style={{ backgroundColor: group.color }}
                />
              )}
              {group.label}
              <span className="tabular-nums">{group.rows.length}</span>
            </h3>
          )}
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] gap-2.5">
            {group.rows.map((row) => {
              const preview = resolveGalleryPreview(row.valuesJson)
              const labels = storyLabelsOf?.(row.noteId)
              const hasPicture = preview.kind === "asset"
              return (
                <li key={row.noteId} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => onOpenNote(row.noteId)}
                    className="flex h-full w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left outline-none hover:border-primary/40 hover:bg-accent/30 focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {people || hasPicture ? (
                      <PortraitDot
                        relativePath={preview.kind === "asset" ? preview.relativePath : null}
                        resolver={resolverFor(section.databaseId)}
                        initials={initialsOf(row.title)}
                        className={cn("size-10 text-xs", !people && "rounded-lg")}
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground"
                      >
                        <Icon className="size-4" />
                      </span>
                    )}
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="break-words text-sm font-medium leading-snug">
                        {row.title}
                      </span>
                      {labels && (labels.names.length > 0 || labels.more > 0) && (
                        <span className="flex flex-wrap gap-1">
                          {labels.names.map((storyName) => (
                            <span
                              key={storyName}
                              className="max-w-full truncate rounded-full bg-accent px-1.5 py-0.5 text-[11px] text-muted-foreground"
                            >
                              {storyName}
                            </span>
                          ))}
                          {labels.more > 0 && (
                            <span className="rounded-full bg-accent px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              {`+${labels.more}`}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
      {footnote && <p className="text-xs text-muted-foreground">{footnote}</p>}
    </section>
  )
}
