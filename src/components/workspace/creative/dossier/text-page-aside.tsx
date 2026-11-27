import * as React from "react"
import { ChevronUp } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { NoticeLine } from "@/components/workspace/notices/notice-line"
import {
  createWorkshopEntity,
  type DatabaseRow,
  type StorySummary,
  type WorkshopSummary,
} from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"
import { useStoryLinks } from "../use-story-links"
import { usePlotEnsurer } from "../workshop/use-ensure-plot"
import { usePlotBinding } from "../workshop/use-plot-binding"
import { AnchorBindingPicker } from "./anchor-binding-picker"
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
import { Block } from "./block"
import { SceneBlock } from "./scene-block"

interface TextPageAsideProps {
  workshop: WorkshopSummary
  story: StorySummary
  noteId: string
  onOpenNote?: (noteId: string) => void
  locked?: boolean
  onFold?: () => void
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
  locked,
  onFold,
}: TextPageAsideProps) {
  const { t } = useTranslation()
  const generation = useDatabaseStore((state) => state.vaultGeneration)
  const bumpData = useCreativeNavStore((state) => state.bumpData)
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
  const { ensure } = usePlotEnsurer()
  const { addLinks } = useStoryLinks()
  const binding = usePlotBinding({
    workshop,
    story,
    rows: data.rows,
    vaultGeneration: generation,
    ensure,
    onChanged: bumpData,
  })
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
    const neighbours = pageNeighbours(noteId, ordered, order, bindings)
    const alreadyBound = new Set(boundTo(bindings, noteId, "anchor"))
    return {
      neighbours,
      ahead: ordered.ahead,
      placed: ordered.placed
        .map((entry) => entry.row)
        .filter((row) => !alreadyBound.has(row.noteId)),
      pageLoaded: textRows.some((row) => row.noteId === noteId),
      pageTitleOf: (pageId: string) => titles.get(pageId) ?? "",
      firstPageOf: (anchorId: string) =>
        ordered.placed.find((entry) => entry.row.noteId === anchorId)?.pageIds[0] ?? null,
      arcs: boundTo(bindings, noteId, "arc")
        .map((id) => ({ id, title: arcTitles.get(id) }))
        .filter((arc): arc is { id: string; title: string } => arc.title !== undefined),
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

  if (!view) return null
  const { neighbours } = view
  const compact =
    neighbours.own.length === 0 &&
    !neighbours.from &&
    (!neighbours.to || neighbours.toAhead) &&
    view.arcs.length === 0
  const where = (anchorId: string): string | undefined => {
    const pageId = view.firstPageOf(anchorId)
    return pageId ? t("creative.plot.side.onPage", { page: view.pageTitleOf(pageId) }) : undefined
  }

  const canBind = !locked && !workshop.readOnly && view.pageLoaded && generation !== null
  const bindAnchor = (anchorId: string) => binding.bind(noteId, "anchor", anchorId)
  const createAnchor =
    canBind && anchorsSection && story.cardNoteId
      ? async (title: string) => {
          if (!anchorsSection.storiesPropertyId) {
            await addLinks(workshop, anchorsSection.id, generation)
          }
          const anchor = await createWorkshopEntity({
            expectedGeneration: generation,
            workshopId: workshop.workshopId,
            sectionId: anchorsSection.id,
            storyId: story.storyId,
            title,
          })
          await bindAnchor(anchor.noteId)
        }
      : null
  const picker =
    anchorsSection && canBind ? (
      <AnchorBindingPicker
        key={noteId}
        ahead={view.ahead}
        placed={view.placed}
        compact={compact}
        onBind={bindAnchor}
        onCreate={createAnchor}
      />
    ) : null
  const from = neighbours.from
  const to = neighbours.to
  const fold = onFold && (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      className="ml-auto shrink-0"
      aria-label={t("creative.plot.side.fold")}
      title={t("creative.plot.side.fold")}
      aria-expanded={true}
      onClick={onFold}
    >
      <ChevronUp aria-hidden="true" className="size-4" />
    </Button>
  )

  return (
    <aside
      aria-label={t("creative.plot.side.aside")}
      className={cn("flex shrink-0 flex-col gap-3", sideBySide ? "sticky top-2 w-60" : "w-full")}
    >
      {compact ? (
        <div className="flex flex-wrap items-center gap-x-1">
          <span className="text-xs text-muted-foreground">{t("creative.plot.side.empty")}</span>
          {picker}
          {fold}
        </div>
      ) : (
        <>
          <div className="flex items-start gap-1">
            {(neighbours.own.length > 0 || picker) && (
              <div className="min-w-0 flex-1">
                <Block title={t("creative.plot.side.anchors")}>
                  {neighbours.own.map((row) => (
                    <NoteButton
                      key={row.noteId}
                      title={row.title}
                      onOpen={() => onOpenNote?.(row.noteId)}
                    />
                  ))}
                  {picker}
                </Block>
              </div>
            )}
            {fold}
          </div>
          {from && (
            <Block title={t("creative.plot.side.from")}>
              <NoteButton
                title={from.title}
                hint={where(from.noteId)}
                onOpen={() => onOpenNote?.(from.noteId)}
              />
            </Block>
          )}
          {to && (
            <Block title={t("creative.plot.side.to")}>
              <NoteButton
                title={to.title}
                hint={neighbours.toAhead ? t("creative.plot.side.toAhead") : where(to.noteId)}
                onOpen={() => onOpenNote?.(to.noteId)}
              />
            </Block>
          )}
          {view.arcs.length > 0 && (
            <Block title={t("creative.plot.side.arcs")}>
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
            </Block>
          )}
        </>
      )}
      {binding.error?.rowId === noteId && <NoticeLine text={binding.error.text} role="status" />}
      <SceneBlock workshop={workshop} story={story} noteId={noteId} locked={locked} />
    </aside>
  )
}
