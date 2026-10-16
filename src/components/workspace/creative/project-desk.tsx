import * as React from "react"
import { FileText, NotebookPen, Play } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  createWorkshopEntity,
  exportTextFile,
  readNote,
  type DatabaseRow,
  type StorySummary,
  type TextPageStat,
  type WorkshopSummary,
} from "@/lib/storage"
import { compileManuscript, ManuscriptReadError } from "@/lib/storage/manuscript-compiler"
import { cn } from "@/lib/utils"
import { IconValue } from "../icon-value"
import { useDatabaseStore } from "../database/database-store"
import { formatModified } from "../workspace-tree-utils"
import { useCreativeNavStore } from "./creative-nav-store"
import { useProjectStore } from "./project-store"
import { useTextStats } from "./use-text-stats"
import { AnchorRibbon } from "./workshop/anchor-ribbon"
import { orderStoryAnchors, readBindings } from "./workshop/plot-model"
import { anchorRibbon } from "./workshop/plot-views"
import { useAnchorOrder } from "./workshop/use-anchor-order"
import { useDatabaseRows } from "./workshop/use-database-rows"
import { WorldCards, type WorldCard } from "./workshop/world-cards"
import {
  buildTextTree,
  countNodes,
  pageStatusDotClass,
  resolvePageStatus,
  textOrder,
  type TextNode,
} from "./workshop/text-tree-model"
import { useCreateInScope } from "./workshop/use-create-in-scope"
import {
  buildMembership,
  entityItemsOf,
  scopeEntities,
  scopeSections,
} from "./workshop/workshop-model"

const CONTINUE_COUNT = 3

interface ProjectDeskProps {
  story?: StorySummary | null
  workshop?: WorkshopSummary | null
  /** Backward-compatibility alias */
  project?: StorySummary | null
  /** Needed to read the pages for the manuscript; without it the button is not offered. */
  vaultPath: string | null
  onOpenNote: (noteId: string) => void
  /** Opens a section's list for this story. */
  onOpenSection?: (sectionId: string) => void
  /**
   * The words and times of the story's pages, when the page above the desk already read them (its
   * header counts them); without it the desk reads them itself.
   */
  stats?: Record<string, TextPageStat>
}

interface PartProgress {
  node: TextNode
  pages: number
  words: number
}

function wordsOf(node: TextNode, stats: Record<string, TextPageStat>): number {
  return (
    (stats[node.noteId]?.wordCount ?? 0) +
    node.children.reduce((total, child) => total + wordsOf(child, stats), 0)
  )
}

function flatten(nodes: TextNode[]): TextNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)])
}

/** A file name the platforms accept: what a folder name may not hold is left out. */
function fileNameOf(name: string): string {
  const forbidden = '\\/:*?"<>|'
  const cleaned = Array.from(name, (char) =>
    char.charCodeAt(0) < 32 || forbidden.includes(char) ? " " : char,
  )
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
  return `${cleaned || "manuscript"}.md`
}

type Compile =
  | { status: "idle" }
  | { status: "working" }
  | { status: "done"; pages: number; path: string }
  | { status: "failed"; message: string }

/**
 * A story's desk: where to continue, the numbers of the work, the outline of the text and the
 * world beside it, and the manuscript. All of it is read from the databases and the note index;
 * nothing is kept apart, and compiling the manuscript only reads the pages.
 */
export function ProjectDesk({
  story,
  workshop,
  project,
  vaultPath,
  onOpenNote,
  onOpenSection,
  stats: givenStats,
}: ProjectDeskProps) {
  const { t } = useTranslation()
  const catalog = useProjectStore((state) => state.catalog)
  const resolvedStory = story ?? project ?? null
  const resolvedWorkshop =
    workshop ??
    catalog?.workshops.find((w) =>
      resolvedStory ? w.stories.some((s) => s.storyId === resolvedStory.storyId) : true,
    ) ??
    null

  const text = resolvedStory?.text ?? null
  const databaseId = text?.databaseId ?? null
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const bumpData = useCreativeNavStore((state) => state.bumpData)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  // The cards beside the text: the lists of the workshop that can hold a page of this story.
  const cards = React.useMemo<WorldCard[]>(
    () =>
      resolvedWorkshop
        ? scopeSections(resolvedWorkshop).map((section) => ({
            owner: resolvedWorkshop,
            section,
            rows: [],
          }))
        : [],
    [resolvedWorkshop],
  )
  const databaseIds = React.useMemo(
    () => [...(databaseId ? [databaseId] : []), ...cards.map((card) => card.section.databaseId)],
    [cards, databaseId],
  )
  const data = useDatabaseRows(databaseIds, dataNonce)
  const ownStats = useTextStats(givenStats ? null : databaseId, dataNonce)
  const stats = givenStats ?? ownStats

  // The pages beside the text are those that belong to this story: its "Stories" relation names
  // its card, or its text names them.
  const worldCards = React.useMemo<WorldCard[]>(() => {
    const membership = buildMembership({
      stories: resolvedStory ? [resolvedStory] : [],
      sections: resolvedWorkshop?.sections ?? [],
      rows: data.rows,
    })
    return cards.map(({ owner, section }) => {
      const rows = data.rows[section.databaseId] ?? []
      if (!resolvedStory) return { owner, section, rows }
      const keep = new Set(
        scopeEntities(
          entityItemsOf(rows, section.databaseId, owner.workshopId),
          { kind: "story", storyId: resolvedStory.storyId },
          membership,
        ).shown.map((item) => item.noteId),
      )
      return { owner, section, rows: rows.filter((row) => keep.has(row.noteId)) }
    })
  }, [cards, data.rows, resolvedStory, resolvedWorkshop?.sections])
  const createFor = useCreateInScope(
    resolvedWorkshop,
    resolvedStory ? { kind: "story", storyId: resolvedStory.storyId } : null,
  )
  const [compile, setCompile] = React.useState<Compile>({ status: "idle" })

  const rows: DatabaseRow[] | undefined = databaseId ? data.rows[databaseId] : undefined
  const roots = React.useMemo(
    () => (text && rows ? buildTextTree(rows, text.properties) : []),
    [text, rows],
  )
  const all = React.useMemo(() => flatten(roots), [roots])
  const parts = React.useMemo<PartProgress[]>(
    () =>
      roots.map((node) => ({
        node,
        pages: countNodes([node]),
        words: wordsOf(node, stats),
      })),
    [roots, stats],
  )
  const widest = Math.max(1, ...parts.map((part) => part.words))
  const recent = React.useMemo(
    () =>
      all
        .filter((node) => (stats[node.noteId]?.modified ?? 0) > 0)
        .sort((a, b) => (stats[b.noteId]?.modified ?? 0) - (stats[a.noteId]?.modified ?? 0))
        .slice(0, CONTINUE_COUNT),
    [all, stats],
  )
  // The anchors of the story along its text, as the panel orders them.
  const anchorsEntry = worldCards.find((entry) => entry.section.role === "anchors") ?? null
  const anchorOrder = useAnchorOrder(anchorsEntry?.section.databaseId, dataNonce)
  const ribbon = React.useMemo(() => {
    if (!anchorsEntry || !text) return null
    const ordered = orderStoryAnchors({
      anchors: anchorsEntry.rows,
      textOrder: textOrder(roots),
      bindings: readBindings(rows ?? [], text.properties),
      manualOrder: anchorOrder.order,
      createdOf: (id) => anchorOrder.created[id],
    })
    const nodes = new Map(all.map((node) => [node.noteId, node]))
    const options = text.properties.status ? (text.statusOptions ?? []) : []
    return anchorRibbon(
      ordered,
      (pageId) =>
        resolvePageStatus(options, nodes.get(pageId)?.statusOptionId ?? null)?.group === "done",
    )
  }, [all, anchorOrder.created, anchorOrder.order, anchorsEntry, roots, rows, text])
  const canCreateAnchor = Boolean(
    anchorsEntry?.section.storiesPropertyId &&
    resolvedStory &&
    resolvedWorkshop &&
    !resolvedWorkshop.readOnly &&
    vaultGeneration !== null,
  )
  const createAnchor = async (title: string) => {
    if (!anchorsEntry || !resolvedStory || !resolvedWorkshop || vaultGeneration === null) return
    try {
      await createWorkshopEntity({
        expectedGeneration: vaultGeneration,
        workshopId: resolvedWorkshop.workshopId,
        sectionId: anchorsEntry.section.id,
        title,
        storyId: resolvedStory.storyId,
      })
    } finally {
      bumpData()
    }
  }

  const levelOf = (node: TextNode) => text?.levels.find((level) => level.id === node.levelId)

  const assemble = async () => {
    if (!vaultPath || compile.status === "working") return
    setCompile({ status: "working" })
    try {
      const result = await compileManuscript({
        roots,
        title: resolvedStory?.name ?? "",
        readNoteContent: async (noteId) => (await readNote(vaultPath, noteId)).content,
      })
      if (result.pages === 0) {
        setCompile({ status: "failed", message: t("creative.page.desk.noPages") })
        return
      }
      const path = await exportTextFile(result.markdown, fileNameOf(resolvedStory?.name ?? ""))
      // No path: the author closed the save dialog, which is not a failure.
      setCompile(path ? { status: "done", pages: result.pages, path } : { status: "idle" })
    } catch (error) {
      const message =
        error instanceof ManuscriptReadError
          ? t("creative.page.desk.readFailed", { title: error.pageTitle })
          : error instanceof Error
            ? error.message
            : String(error)
      setCompile({ status: "failed", message })
    }
  }

  if (!databaseId) return null

  const loading = data.status === "loading" && rows === undefined
  const card = "rounded-2xl border border-border bg-card p-5"
  const heading = "text-sm font-semibold"
  const [latest, ...earlier] = recent
  const latestLevel = latest ? levelOf(latest) : undefined
  const latestWords = latest ? (stats[latest.noteId]?.wordCount ?? 0) : 0
  const countOf = (role: string) =>
    worldCards
      .filter((entry) => entry.section.role === role)
      .reduce((total, entry) => total + entry.rows.length, 0)
  const statusOptions = text?.properties.status ? (text.statusOptions ?? []) : []
  const donePages =
    statusOptions.length > 0
      ? all.filter(
          (node) => resolvePageStatus(statusOptions, node.statusOptionId)?.group === "done",
        ).length
      : null
  const tiles: { label: string; value: number | string }[] = [
    ...(donePages !== null
      ? [
          {
            label: t("creative.schema.properties.status"),
            value: t("creative.page.desk.doneOf", { done: donePages, total: all.length }),
          },
        ]
      : []),
    ...(["characters", "locations"] as const)
      .filter((role) => cards.some((entry) => entry.section.role === role))
      .map((role) => ({ label: t(`creative.sections.${role}`), value: countOf(role) })),
  ]

  return (
    <div className="mb-8 flex w-full flex-col gap-5">
      <section
        aria-label={t("creative.page.desk.continue")}
        className={cn(card, "flex flex-col gap-4")}
      >
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">{t("creative.page.desk.continue")}</p>
            {latest ? (
              <>
                <h2 className="break-words text-xl font-semibold tracking-tight">{latest.title}</h2>
                <p className="break-words text-xs text-muted-foreground">
                  {[
                    latestLevel?.name,
                    formatModified(stats[latest.noteId]?.modified ?? undefined),
                    latestWords > 0 ? t("docEditor.wordCount", { count: latestWords }) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </>
            ) : (
              <p className="pt-1 text-sm text-muted-foreground">
                {loading ? "" : t("creative.page.desk.continueEmpty")}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {vaultPath && (
              <Button
                variant="outline"
                size="sm"
                title={t("creative.page.desk.manuscriptHint")}
                disabled={compile.status === "working" || all.length === 0}
                onClick={() => void assemble()}
              >
                <NotebookPen className="size-3.5" />
                {compile.status === "working"
                  ? t("creative.page.desk.compiling")
                  : t("creative.page.desk.compile")}
              </Button>
            )}
            {latest && (
              <Button size="sm" onClick={() => onOpenNote(latest.noteId)}>
                <Play className="size-3.5" />
                {t("creative.page.desk.open", { name: latest.title })}
              </Button>
            )}
          </div>
        </div>
        {earlier.length > 0 && (
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            {earlier.map((node) => (
              <button
                key={node.noteId}
                type="button"
                onClick={() => onOpenNote(node.noteId)}
                className="flex max-w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs hover:bg-accent"
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                  <IconValue
                    value={levelOf(node)?.icon ?? undefined}
                    fallback={<FileText className="size-4" />}
                    className="size-4"
                  />
                </span>
                <span className="min-w-0 break-words font-medium">{node.title}</span>
                <span className="shrink-0 text-muted-foreground">
                  {formatModified(stats[node.noteId]?.modified ?? undefined)}
                </span>
              </button>
            ))}
          </div>
        )}
        {compile.status === "done" && (
          <p role="status" className="break-words text-xs text-muted-foreground">
            {t("creative.page.desk.compiled", { pages: compile.pages, path: compile.path })}
          </p>
        )}
        {compile.status === "failed" && (
          <p role="alert" className="break-words text-xs text-destructive">
            {t("creative.page.desk.compileFailed", { message: compile.message })}
          </p>
        )}
      </section>

      {tiles.length > 0 && (
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {tiles.map((tile) => (
            <div key={tile.label} className="min-w-0 rounded-2xl bg-accent/50 px-4 py-3">
              <dt className="text-xs text-muted-foreground">{tile.label}</dt>
              <dd className="text-2xl font-semibold tabular-nums tracking-tight">
                {typeof tile.value === "number" ? tile.value.toLocaleString() : tile.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {ribbon && (
        <section aria-label={t("creative.plot.ribbon.title")} className={card}>
          <h2 className={cn(heading, "mb-3")}>{t("creative.plot.ribbon.title")}</h2>
          <AnchorRibbon
            items={ribbon}
            pageTitleOf={(pageId) => rows?.find((row) => row.noteId === pageId)?.title ?? ""}
            onOpen={onOpenNote}
            loading={data.status === "loading" || data.status === "idle"}
            onCreate={canCreateAnchor ? createAnchor : null}
          />
        </section>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-5">
        <section
          aria-label={t("creative.page.desk.progress")}
          className={cn(card, "lg:col-span-3")}
        >
          <h2 className={cn(heading, "mb-3")}>{t("creative.page.desk.progress")}</h2>
          {parts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {loading ? "" : t("creative.workshop.noPages")}
            </p>
          ) : (
            <ul className="grid gap-1">
              {parts.map((part) => (
                <li key={part.node.noteId}>
                  <button
                    type="button"
                    onClick={() => onOpenNote(part.node.noteId)}
                    className="flex w-full flex-col gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
                  >
                    <span className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="min-w-0 break-words font-medium">{part.node.title}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {t("creative.page.desk.partTotals", {
                          pages: part.pages,
                          words: part.words,
                        })}
                      </span>
                    </span>
                    {/* A bar compares the parts, so one part alone has none. */}
                    {parts.length > 1 && (
                      <span className="h-1.5 w-full overflow-hidden rounded-full bg-accent">
                        <span
                          className="block h-full rounded-full bg-primary/60"
                          style={{ width: `${Math.round((part.words / widest) * 100)}%` }}
                        />
                      </span>
                    )}
                  </button>
                  {part.node.children.length > 0 && (
                    <ul className="mb-1 ml-2 grid border-l border-border pl-2">
                      {part.node.children.map((child) => {
                        const words = wordsOf(child, stats)
                        const statusOption = resolvePageStatus(statusOptions, child.statusOptionId)
                        return (
                          <li key={child.noteId}>
                            <button
                              type="button"
                              onClick={() => onOpenNote(child.noteId)}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-accent"
                            >
                              <span
                                aria-hidden="true"
                                title={statusOption?.name}
                                className={cn(
                                  "size-2 shrink-0 rounded-full",
                                  pageStatusDotClass(statusOptions, child.statusOptionId, words),
                                )}
                              />
                              <span className="min-w-0 flex-1 break-words">{child.title}</span>
                              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                {words.toLocaleString()}
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="grid gap-5 lg:col-span-2">
          <WorldCards
            // The ribbon shows the story's anchors in full, so their card would only repeat it.
            cards={
              ribbon ? worldCards.filter((entry) => entry.section.role !== "anchors") : worldCards
            }
            loading={data.status === "loading"}
            vaultGeneration={vaultGeneration}
            onOpenNote={onOpenNote}
            onOpenSection={
              onOpenSection ? (_ownerId, sectionId) => onOpenSection(sectionId) : undefined
            }
            createFor={(card) => createFor(card.section)}
          />
        </div>
      </div>
    </div>
  )
}
