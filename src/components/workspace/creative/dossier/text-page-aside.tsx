import * as React from "react"
import { useTranslation } from "react-i18next"
import type { DatabaseRow, StorySummary, WorkshopSummary } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { useCreativeNavStore } from "../creative-nav-store"
import { arcColor, boundTo, orderStoryAnchors, readBindings } from "../workshop/plot-model"
import { pageNeighbours } from "../workshop/plot-views"
import { buildTextTree, textOrder } from "../workshop/text-tree-model"
import { useAnchorOrder } from "../workshop/use-anchor-order"
import { useDatabaseRows } from "../workshop/use-database-rows"
import {
  buildMembership,
  entityItemsOf,
  scopeEntities,
  storySection,
} from "../workshop/workshop-model"
import { Block, QuietLine } from "./block"

interface TextPageAsideProps {
  workshop: WorkshopSummary
  story: StorySummary
  noteId: string
  onOpenNote?: (noteId: string) => void
  /** Beside the text (a fixed column) or under it (the full width). */
  sideBySide: boolean
}

function NoteButton({
  title,
  hint,
  color,
  onOpen,
}: {
  title: string
  hint?: string
  color?: string
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      className="flex min-w-0 flex-col rounded-md px-2 py-1 text-left hover:bg-accent/50"
      onClick={onOpen}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        {color && (
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
        )}
        <span className="truncate">{title}</span>
      </span>
      {hint && <span className="truncate text-[11px] text-muted-foreground">{hint}</span>}
    </button>
  )
}

/**
 * The plot beside a page of a story's text: the anchors bound to the page, the nearest bound
 * anchors before and after it in the order of the text, and its arcs. Everything is read from the
 * rows of the text, the anchors and the arcs (the same way the panel reads them); a workshop with
 * neither anchors nor arcs gets no aside at all.
 */
export function TextPageAside({
  workshop,
  story,
  noteId,
  onOpenNote,
  sideBySide,
}: TextPageAsideProps) {
  const { t } = useTranslation()
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const text = story.text
  const anchorsSection = storySection(workshop, "anchors")
  const arcsSection =
    workshop.sections.find((section) => section.role === "arcs" && section.state !== "missing") ??
    null
  const textDatabaseId = text?.databaseId ?? null

  const databaseIds = React.useMemo(
    () =>
      [textDatabaseId, anchorsSection?.databaseId, arcsSection?.databaseId].filter(
        (id): id is string => Boolean(id),
      ),
    [anchorsSection?.databaseId, arcsSection?.databaseId, textDatabaseId],
  )
  const data = useDatabaseRows(databaseIds, dataNonce)
  const { order: manualOrder, created: createdAt } = useAnchorOrder(
    anchorsSection?.databaseId,
    dataNonce,
  )

  const view = React.useMemo(() => {
    if (!text || !textDatabaseId || data.rows[textDatabaseId] === undefined) return null
    const textRows = data.rows[textDatabaseId]
    const anchorRows: DatabaseRow[] = anchorsSection
      ? (data.rows[anchorsSection.databaseId] ?? [])
      : []
    const arcRows: DatabaseRow[] = arcsSection ? (data.rows[arcsSection.databaseId] ?? []) : []
    const roots = buildTextTree(textRows, text.properties)
    const order = textOrder(roots)
    const bindings = readBindings(textRows, text.properties)
    const membership = buildMembership({
      stories: [story],
      sections: workshop.sections,
      rows: data.rows,
    })
    const mine = new Set(
      scopeEntities(
        entityItemsOf(anchorRows, anchorsSection?.databaseId ?? "", workshop.workshopId),
        { kind: "story", storyId: story.storyId },
        membership,
      ).shown.map((item) => item.noteId),
    )
    const ordered = orderStoryAnchors({
      anchors: anchorRows.filter((row) => mine.has(row.noteId)),
      textOrder: order,
      bindings,
      manualOrder,
      createdOf: (id) => createdAt[id],
    })
    const titles = new Map(textRows.map((row) => [row.noteId, row.title]))
    const arcTitles = new Map(arcRows.map((row) => [row.noteId, row.title]))
    return {
      neighbours: pageNeighbours(noteId, ordered, order, bindings),
      pageTitleOf: (pageId: string) => titles.get(pageId) ?? "",
      firstPageOf: (anchorId: string) =>
        ordered.placed.find((entry) => entry.row.noteId === anchorId)?.pageIds[0] ?? null,
      arcs: boundTo(bindings, noteId, "arc")
        .map((id) => ({ id, title: arcTitles.get(id) }))
        .filter((arc): arc is { id: string; title: string } => arc.title !== undefined),
      total: anchorRows.length + arcRows.length,
    }
  }, [
    anchorsSection,
    arcsSection,
    createdAt,
    manualOrder,
    data.rows,
    noteId,
    story,
    text,
    textDatabaseId,
    workshop,
  ])

  // Nothing to show until the rows are read, and nothing at all in a workshop with no anchor and no arc.
  if (!view || view.total === 0) return null
  const { neighbours } = view
  const where = (anchorId: string): string | undefined => {
    const pageId = view.firstPageOf(anchorId)
    return pageId ? t("creative.plot.side.onPage", { page: view.pageTitleOf(pageId) }) : undefined
  }

  return (
    <aside
      aria-label={t("creative.plot.side.aside")}
      className={cn("flex shrink-0 flex-col gap-5", sideBySide ? "sticky top-2 w-60" : "w-full")}
    >
      <Block title={t("creative.plot.side.anchors")}>
        {neighbours.own.length === 0 ? (
          <QuietLine>{t("creative.plot.side.anchorsEmpty")}</QuietLine>
        ) : (
          <div className="flex flex-col">
            {neighbours.own.map((row) => (
              <NoteButton
                key={row.noteId}
                title={row.title}
                onOpen={() => onOpenNote?.(row.noteId)}
              />
            ))}
          </div>
        )}
      </Block>

      <Block title={t("creative.plot.side.from")}>
        {neighbours.from ? (
          <NoteButton
            title={neighbours.from.title}
            hint={where(neighbours.from.noteId)}
            onOpen={() => onOpenNote?.(neighbours.from!.noteId)}
          />
        ) : (
          <QuietLine>{t("creative.plot.side.fromEmpty")}</QuietLine>
        )}
      </Block>

      <Block title={t("creative.plot.side.to")}>
        {neighbours.to ? (
          <NoteButton
            title={neighbours.to.title}
            hint={
              neighbours.toAhead ? t("creative.plot.side.toAhead") : where(neighbours.to.noteId)
            }
            onOpen={() => onOpenNote?.(neighbours.to!.noteId)}
          />
        ) : (
          <QuietLine>{t("creative.plot.side.toEmpty")}</QuietLine>
        )}
      </Block>

      <Block title={t("creative.plot.side.arcs")}>
        {view.arcs.length === 0 ? (
          <QuietLine>{t("creative.plot.side.arcsEmpty")}</QuietLine>
        ) : (
          <div className="flex flex-col">
            {view.arcs.map((arc) => (
              <NoteButton
                key={arc.id}
                title={arc.title}
                color={arcColor(arc.id)}
                onOpen={() => onOpenNote?.(arc.id)}
              />
            ))}
          </div>
        )}
      </Block>
    </aside>
  )
}
