import * as React from "react"
import { useTranslation } from "react-i18next"
import type { DatabaseRow, NoteReference, WorkshopSummary } from "@/lib/storage"
import { useCreativeNavStore } from "../creative-nav-store"
import { arcColor, readBindings } from "../workshop/plot-model"
import { arcAnchors, arcChapters, type StoryPlotText } from "../workshop/plot-views"
import { buildTextTree, textOrder } from "../workshop/text-tree-model"
import { useAnchorOrder } from "../workshop/use-anchor-order"
import { useDatabaseRows } from "../workshop/use-database-rows"
import { relationTargetsOf, storySection } from "../workshop/workshop-model"
import { Block, QuietLine } from "./block"

function Link({ title, color, onOpen }: { title: string; color?: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs hover:bg-accent/50"
      onClick={onOpen}
    >
      {color && (
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
      )}
      <span className="truncate">{title}</span>
    </button>
  )
}

/** The arcs of a character, with their colors. Not shown for a character with no arc. */
export function CharacterArcsBlock({
  arcs,
  onOpenNote,
}: {
  arcs: readonly NoteReference[]
  onOpenNote?: (noteId: string) => void
}) {
  const { t } = useTranslation()
  if (arcs.length === 0) return null
  return (
    <Block title={t("creative.plot.arc.characterArcs")}>
      <div className="flex flex-col">
        {arcs.map((arc) => (
          <Link
            key={arc.noteId}
            title={arc.title ?? ""}
            color={arcColor(arc.noteId)}
            onOpen={() => onOpenNote?.(arc.noteId)}
          />
        ))}
      </div>
    </Block>
  )
}

/**
 * The plot of an arc beside its page: the anchors that name it (story by story, in the order of
 * each text, the ones bound to no text last) and the chapters it is bound to with the span from
 * the first to the last. Read from the rows of the anchors and of every story's text.
 */
export function ArcBlocks({
  workshop,
  arcId,
  onOpenNote,
}: {
  workshop: WorkshopSummary
  arcId: string
  onOpenNote?: (noteId: string) => void
}) {
  const { t } = useTranslation()
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const anchorsSection = storySection(workshop, "anchors")
  const texts = React.useMemo(
    () => workshop.stories.filter((story) => story.text?.databaseId),
    [workshop.stories],
  )
  const databaseIds = React.useMemo(
    () => [
      ...texts.map((story) => story.text!.databaseId!),
      ...(anchorsSection ? [anchorsSection.databaseId] : []),
    ],
    [anchorsSection, texts],
  )
  const data = useDatabaseRows(databaseIds, dataNonce)
  const { order: manualOrder, created: createdAt } = useAnchorOrder(
    anchorsSection?.databaseId,
    dataNonce,
  )

  const view = React.useMemo(() => {
    const stories: StoryPlotText[] = []
    const titles = new Map<string, string>()
    for (const story of texts) {
      const text = story.text!
      const rows = data.rows[text.databaseId!]
      if (!rows) continue
      for (const row of rows) titles.set(row.noteId, row.title)
      stories.push({
        storyId: story.storyId,
        storyName: story.name,
        textOrder: textOrder(buildTextTree(rows, text.properties)),
        bindings: readBindings(rows, text.properties),
      })
    }
    const anchorRows: DatabaseRow[] = anchorsSection
      ? (data.rows[anchorsSection.databaseId] ?? [])
      : []
    const arcsProperty = anchorsSection?.arcsPropertyId ?? null
    return {
      titles,
      chapters: arcChapters(arcId, stories),
      anchors: arcAnchors({
        arcId,
        anchors: anchorRows,
        arcsOf: (noteId) => {
          const row = anchorRows.find((candidate) => candidate.noteId === noteId)
          return row && arcsProperty ? relationTargetsOf(row.valuesJson, arcsProperty) : []
        },
        stories,
        manualOrder,
        createdOf: (id) => createdAt[id],
      }),
      loaded: texts.every((story) => data.rows[story.text!.databaseId!] !== undefined),
    }
  }, [anchorsSection, arcId, createdAt, data.rows, manualOrder, texts])

  if (!view.loaded) return null
  const named = (storyId: string, name: string, many: boolean) =>
    many ? (
      <span key={`h:${storyId}`} className="px-2 pt-1 text-[11px] text-muted-foreground">
        {name}
      </span>
    ) : null

  return (
    <>
      {anchorsSection && (
        <Block title={t("creative.plot.arc.anchors")}>
          {view.anchors.byStory.length === 0 && view.anchors.unbound.length === 0 ? (
            <QuietLine>{t("creative.plot.arc.anchorsEmpty")}</QuietLine>
          ) : (
            <div className="flex flex-col">
              {view.anchors.byStory.map((group) => (
                <React.Fragment key={group.storyId}>
                  {named(group.storyId, group.storyName, view.anchors.byStory.length > 1)}
                  {group.anchors.map((row) => (
                    <Link
                      key={`${group.storyId}:${row.noteId}`}
                      title={row.title}
                      onOpen={() => onOpenNote?.(row.noteId)}
                    />
                  ))}
                </React.Fragment>
              ))}
              {view.anchors.unbound.length > 0 && view.anchors.byStory.length > 0 && (
                <span className="px-2 pt-1 text-[11px] text-muted-foreground">
                  {t("creative.plot.arc.unbound")}
                </span>
              )}
              {view.anchors.unbound.map((row) => (
                <Link
                  key={`u:${row.noteId}`}
                  title={row.title}
                  onOpen={() => onOpenNote?.(row.noteId)}
                />
              ))}
            </div>
          )}
        </Block>
      )}
      {texts.length > 0 && (
        <Block title={t("creative.plot.arc.chapters")}>
          {view.chapters.length === 0 ? (
            <QuietLine>{t("creative.plot.arc.chaptersEmpty")}</QuietLine>
          ) : (
            <div className="flex flex-col">
              {view.chapters.map((story) => (
                <React.Fragment key={story.storyId}>
                  {named(story.storyId, story.storyName, view.chapters.length > 1)}
                  {story.span && (
                    <span className="px-2 pb-0.5 text-[11px] text-muted-foreground">
                      {t("creative.plot.arc.span", {
                        from: view.titles.get(story.span.from) ?? "",
                        to: view.titles.get(story.span.to) ?? "",
                      })}
                    </span>
                  )}
                  {story.pageIds.map((pageId) => (
                    <Link
                      key={pageId}
                      title={view.titles.get(pageId) ?? ""}
                      onOpen={() => onOpenNote?.(pageId)}
                    />
                  ))}
                </React.Fragment>
              ))}
            </div>
          )}
        </Block>
      )}
    </>
  )
}
