import * as React from "react"
import { Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import {
  createTextPage,
  createWorkshopEntity,
  exportTextFile,
  moveTextPage,
  readNote,
  type DatabaseRow,
  type StorySummary,
  type TextPageStat,
  type WorkshopSectionSummary,
  type WorkshopSummary,
} from "@/lib/storage"
import { compileManuscript, ManuscriptReadError } from "@/lib/storage/manuscript-compiler"
import { cn } from "@/lib/utils"
import { useDatabaseStore } from "../database/database-store"
import { useCreativeNavStore } from "./creative-nav-store"
import { ChaptersWidget } from "./desk/chapters-widget"
import { DeskControls } from "./desk/desk-controls"
import { ContinueWidget } from "./desk/continue-widget"
import { DeskWidget } from "./desk/desk-widget"
import {
  availableWidgets,
  deskColumns,
  effectiveSpan,
  moveWidget,
  nextSpan,
  reconcileDeskLayout,
  setWidgetHidden,
  setWidgetSpan,
  worldWidgetId,
  type DeskItem,
} from "./desk/desk-layout-model"
import { ProgressWidget, type CompileState } from "./desk/progress-widget"
import { useElementWidth } from "./desk/use-element-width"
import { NotesBoard } from "./pages/notes-board"
import { SectionGallery } from "./pages/section-gallery"
import { projectErrorText } from "./project-error"
import { useProjectStore } from "./project-store"
import { useTextStats } from "./use-text-stats"
import { orderStoryAnchors, readBindings, type PageBinding } from "./workshop/plot-model"
import { useAnchorOrder } from "./workshop/use-anchor-order"
import { useDatabaseRows } from "./workshop/use-database-rows"
import { useNotebooks } from "./workshop/use-notebooks"
import { usePlotEnsurer } from "./workshop/use-ensure-plot"
import { usePlotBinding } from "./workshop/use-plot-binding"
import {
  buildTextTree,
  findNode,
  lastOrderKey,
  resolvePageStatus,
  startLevelId,
  textOrder,
  type MovePlan,
  type TextNode,
} from "./workshop/text-tree-model"
import { useCreateInScope } from "./workshop/use-create-in-scope"
import {
  buildMembership,
  entityItemsOf,
  scopeEntities,
  scopeSections,
} from "./workshop/workshop-model"

interface ProjectDeskProps {
  story?: StorySummary | null
  workshop?: WorkshopSummary | null
  /** Backward-compatibility alias */
  project?: StorySummary | null
  /** Needed to read the pages for the manuscript; without it the button is not offered. */
  vaultPath: string | null
  onOpenNote: (noteId: string) => void
  /** Opens a section's list for this story (the section's tab of the page). */
  onOpenSection?: (sectionId: string) => void
  /**
   * The words and times of the story's pages, when the page above the desk already read them (its
   * header counts them); without it the desk reads them itself.
   */
  stats?: Record<string, TextPageStat>
  /** Refreshes the file tree and the catalog after the desk made what a binding needs. */
  onChanged?: () => Promise<void>
  /**
   * The desk's layout: the widgets, their order, widths and which are hidden. It is one layout for
   * every story; it is reconciled with the widgets this story can show. Without it, the defaults.
   */
  layout?: readonly DeskItem[]
  /** The layout mode: each widget shows its controls and the hidden ones wait in a tray. */
  editing?: boolean
  /** Asks the page to keep a changed layout. */
  onLayoutChange?: (next: DeskItem[]) => void
  /** Read mode: nothing is made, moved or bound from the desk. */
  locked?: boolean
  /**
   * Handed the desk's "compile the manuscript" (or `null` where there is nothing to compile), so
   * the page's menu can run it too.
   */
  compileRef?: React.MutableRefObject<(() => void) | null>
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

const NO_ROWS: DatabaseRow[] = []

const COLUMN_CLASS = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3" } as const

/**
 * A story's desk: a grid of widgets, three columns wide, two and then one as the desk narrows.
 * Where to continue, how far the work is (with the manuscript), the text as an outline with its
 * anchors "ahead", the notes of the story and the pages of the world that belong to it. All of it
 * is read from the databases and the note index; nothing is kept apart, and compiling the
 * manuscript only reads the pages.
 */
export function ProjectDesk({
  story,
  workshop,
  project,
  vaultPath,
  onOpenNote,
  onOpenSection,
  stats: givenStats,
  onChanged,
  layout,
  editing = false,
  onLayoutChange,
  locked = false,
  compileRef,
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
  // The sections beside the text: the lists of the workshop that can hold a page of this story.
  const sections = React.useMemo<WorkshopSectionSummary[]>(
    () => scopeSections(resolvedWorkshop),
    [resolvedWorkshop],
  )
  const databaseIds = React.useMemo(
    () => [...(databaseId ? [databaseId] : []), ...sections.map((section) => section.databaseId)],
    [sections, databaseId],
  )
  const data = useDatabaseRows(databaseIds, dataNonce)
  const ownStats = useTextStats(givenStats ? null : databaseId, dataNonce)
  const stats = givenStats ?? ownStats

  // The pages beside the text are those that belong to this story: its "Stories" relation names
  // its card, or its text names them.
  const rowsOfSection = React.useMemo(() => {
    const membership = buildMembership({
      stories: resolvedStory ? [resolvedStory] : [],
      sections: resolvedWorkshop?.sections ?? [],
      rows: data.rows,
    })
    const result = new Map<string, DatabaseRow[]>()
    for (const section of sections) {
      const rows = data.rows[section.databaseId] ?? []
      if (!resolvedStory || !resolvedWorkshop) {
        result.set(section.id, rows)
        continue
      }
      const keep = new Set(
        scopeEntities(
          entityItemsOf(rows, section.databaseId, resolvedWorkshop.workshopId),
          { kind: "story", storyId: resolvedStory.storyId },
          membership,
        ).shown.map((item) => item.noteId),
      )
      result.set(
        section.id,
        rows.filter((row) => keep.has(row.noteId)),
      )
    }
    return result
  }, [data.rows, resolvedStory, resolvedWorkshop, sections])
  const createInScope = useCreateInScope(
    resolvedWorkshop,
    resolvedStory ? { kind: "story", storyId: resolvedStory.storyId } : null,
  )
  const createFor = React.useCallback(
    (section: WorkshopSectionSummary) => (locked ? null : createInScope(section)),
    [createInScope, locked],
  )
  const [compile, setCompile] = React.useState<CompileState>({ status: "idle" })

  const rows: DatabaseRow[] | undefined = databaseId ? data.rows[databaseId] : undefined
  const roots = React.useMemo(
    () => (text && rows ? buildTextTree(rows, text.properties) : []),
    [text, rows],
  )
  const all = React.useMemo(() => flatten(roots), [roots])
  const levels = React.useMemo(() => text?.levels ?? [], [text])
  const statusOptions = React.useMemo(
    () => (text?.properties.status ? (text.statusOptions ?? []) : []),
    [text],
  )
  const totalWords = React.useMemo(
    () => all.reduce((sum, node) => sum + (stats[node.noteId]?.wordCount ?? 0), 0),
    [all, stats],
  )
  const groups = React.useMemo(() => {
    if (statusOptions.length === 0) return null
    const of = (group: string) =>
      all.filter((node) => resolvePageStatus(statusOptions, node.statusOptionId)?.group === group)
        .length
    return { done: of("done"), inProgress: of("inProgress") }
  }, [all, statusOptions])
  const latest = React.useMemo(
    () =>
      all
        .filter((node) => (stats[node.noteId]?.modified ?? 0) > 0)
        .sort((a, b) => (stats[b.noteId]?.modified ?? 0) - (stats[a.noteId]?.modified ?? 0))[0] ??
      null,
    [all, stats],
  )

  // Anchors and arcs: which belong to the story, how its pages hold them, and the way to bind.
  const sectionOf = (role: string) => sections.find((section) => section.role === role)
  const anchorsSection = sectionOf("anchors")
  const arcsSection = sectionOf("arcs")
  const anchorRows = anchorsSection ? (rowsOfSection.get(anchorsSection.id) ?? NO_ROWS) : NO_ROWS
  const arcRows = arcsSection ? (rowsOfSection.get(arcsSection.id) ?? NO_ROWS) : NO_ROWS
  const anchorOrder = useAnchorOrder(anchorsSection?.databaseId, dataNonce)
  const bindings = React.useMemo<ReadonlyMap<string, PageBinding>>(
    () => (text ? readBindings(rows ?? [], text.properties) : new Map()),
    [rows, text],
  )
  const pageOrder = React.useMemo(() => textOrder(roots), [roots])
  const ahead = React.useMemo(
    () =>
      orderStoryAnchors({
        anchors: anchorRows,
        textOrder: pageOrder,
        bindings,
        manualOrder: anchorOrder.order,
        createdOf: (id) => anchorOrder.created[id],
      }).ahead,
    [anchorOrder.created, anchorOrder.order, anchorRows, bindings, pageOrder],
  )
  const plotTitleOf = React.useCallback(
    (kind: "anchor" | "arc", id: string) =>
      (kind === "anchor" ? anchorRows : arcRows).find((row) => row.noteId === id)?.title,
    [anchorRows, arcRows],
  )
  const { ensure } = usePlotEnsurer(onChanged)
  const plotBinding = usePlotBinding({
    workshop: resolvedWorkshop,
    story: resolvedStory,
    rows: data.rows,
    vaultGeneration,
    ensure,
    onChanged: bumpData,
  })
  const canWrite = Boolean(
    resolvedWorkshop && !resolvedWorkshop.readOnly && vaultGeneration !== null && !locked,
  )
  const binding = canWrite && databaseId ? plotBinding : null
  const canCreateAnchor = Boolean(anchorsSection?.storiesPropertyId && resolvedStory && canWrite)
  const createAnchor = async (title: string) => {
    if (!anchorsSection || !resolvedStory || !resolvedWorkshop || vaultGeneration === null) return
    try {
      await createWorkshopEntity({
        expectedGeneration: vaultGeneration,
        workshopId: resolvedWorkshop.workshopId,
        sectionId: anchorsSection.id,
        title,
        storyId: resolvedStory.storyId,
      })
    } finally {
      bumpData()
    }
  }

  // Pages: a new one under a parent, and the moves of the page's menu.
  const [moveError, setMoveError] = React.useState<string | null>(null)
  const createPage = async (parent: TextNode | null, title: string) => {
    if (!resolvedStory || !text?.databaseId || vaultGeneration === null) {
      throw new Error(t("creative.workshop.noText"))
    }
    const parentNode = parent ? findNode(roots, parent.noteId) : null
    const levelId = startLevelId(text.levels, parentNode)
    if (!levelId) throw new Error(t("creative.workshop.noLevels"))
    const formats = text.formats.filter((format) => format.state === "ok")
    const format = formats.find((entry) => entry.kind === "manuscript") ?? formats[0]
    const created = await createTextPage({
      expectedGeneration: vaultGeneration,
      storyId: resolvedStory.storyId,
      title,
      parentNoteId: parentNode?.noteId ?? null,
      levelId,
      formatId: format?.id ?? null,
      orderKey: lastOrderKey(parentNode ? parentNode.children : roots),
    })
    bumpData()
    onOpenNote(created.noteId)
  }
  const movePage = (pageId: string, plan: MovePlan) => {
    const moved = rows?.find((row) => row.noteId === pageId)
    if (!moved || !resolvedStory || vaultGeneration === null) return
    setMoveError(null)
    void moveTextPage({
      expectedGeneration: vaultGeneration,
      operationId: `move-${crypto.randomUUID()}`,
      storyId: resolvedStory.storyId,
      noteId: pageId,
      newParentNoteId: plan.newParentId,
      orderKey: plan.orderKey,
      expectedRevision: moved.rowRevision,
    })
      .catch((error: unknown) => setMoveError(projectErrorText(t, error)))
      .finally(bumpData)
  }

  // Notes of this story, under their notebooks.
  const notesSection = sectionOf("notes")
  const noteRows = notesSection ? rowsOfSection.get(notesSection.id) : undefined
  const noteStats = useTextStats(notesSection?.databaseId, dataNonce)
  const { catalog: notebookCatalog } = useNotebooks(notesSection?.databaseId, dataNonce)
  const noteModifiedOf = React.useCallback(
    (noteId: string) => noteStats[noteId]?.modified ?? null,
    [noteStats],
  )
  const createNote =
    canWrite && notesSection && resolvedWorkshop && vaultGeneration !== null
      ? async (title: string, notebook: string[] | undefined) => {
          try {
            await createWorkshopEntity({
              expectedGeneration: vaultGeneration,
              workshopId: resolvedWorkshop.workshopId,
              sectionId: notesSection.id,
              title,
              // A note is linked to the story from the first write when the base has the link.
              storyId: notesSection.storiesPropertyId ? (resolvedStory?.storyId ?? null) : null,
              notebook: notebook ?? null,
            })
          } finally {
            bumpData()
          }
        }
      : null

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

  // The page's menu runs the same compile as the Progress widget's button.
  const assembleRef = React.useRef(assemble)
  assembleRef.current = assemble
  React.useEffect(() => {
    if (!compileRef) return undefined
    compileRef.current = vaultPath ? () => void assembleRef.current() : null
    return () => {
      compileRef.current = null
    }
  }, [compileRef, vaultPath])

  // The widgets this story can show, and how the layout puts them.
  const worldSections = React.useMemo(
    () => sections.filter((section) => section.role !== "anchors" && section.role !== "notes"),
    [sections],
  )
  const available = React.useMemo(
    () =>
      availableWidgets({
        hasNotes: Boolean(notesSection),
        worldSections: worldSections.map((section) => ({ id: section.id, role: section.role })),
      }),
    [notesSection, worldSections],
  )
  const items = React.useMemo(() => reconcileDeskLayout(layout, available), [available, layout])
  const [deskRef, width] = useElementWidth<HTMLDivElement>()
  const columns = deskColumns(width)
  const sectionOfWidget = (id: string) => worldSections.find((s) => worldWidgetId(s) === id)

  if (!databaseId) return null

  const loading = data.status === "loading" && rows === undefined
  const levelNameOf = (node: TextNode) => levels.find((level) => level.id === node.levelId)?.name
  const worldTitle = (section: WorkshopSectionSummary) =>
    section.role && t(`creative.sections.${section.role}`, { defaultValue: "" })
      ? t(`creative.sections.${section.role}`)
      : section.databaseName?.trim() || section.name

  const widgetTitle = (id: string): string => {
    switch (id) {
      case "continue":
        return t("creative.workshopPage.continue")
      case "progress":
        return t("creative.desk.progress")
      case "chapters":
        return t("creative.desk.chapters")
      case "notes":
        return t("creative.notesBoard.title")
      default: {
        const section = sectionOfWidget(id)
        return section ? worldTitle(section) : id
      }
    }
  }
  const shown = items.filter((item) => !item.hidden)
  const change = (next: DeskItem[]) => onLayoutChange?.(next)
  const controlsOf = (item: DeskItem, index: number) =>
    editing ? (
      <DeskControls
        name={widgetTitle(item.id)}
        span={item.span}
        first={index === 0}
        last={index === shown.length - 1}
        onUp={() => change(moveWidget(items, item.id, -1))}
        onDown={() => change(moveWidget(items, item.id, 1))}
        onWidth={() => change(setWidgetSpan(items, item.id, nextSpan(item.span)))}
        onHide={() => change(setWidgetHidden(items, item.id, true))}
      />
    ) : undefined

  const renderWidget = (item: DeskItem, index: number): React.ReactElement | null => {
    const controls = controlsOf(item, index)
    const style = {
      gridColumn: `span ${effectiveSpan(item.span, columns)} / span ${effectiveSpan(item.span, columns)}`,
    }
    switch (item.id) {
      case "continue":
        return (
          <DeskWidget
            key={item.id}
            style={style}
            controls={controls}
            title={t("creative.workshopPage.continue")}
          >
            <ContinueWidget
              page={
                latest
                  ? {
                      noteId: latest.noteId,
                      title: latest.title,
                      modified: stats[latest.noteId]?.modified ?? null,
                      words: stats[latest.noteId]?.wordCount ?? 0,
                    }
                  : null
              }
              levelName={latest ? levelNameOf(latest) : null}
              loading={loading}
              onOpen={onOpenNote}
            />
          </DeskWidget>
        )
      case "progress":
        return (
          <DeskWidget
            key={item.id}
            style={style}
            controls={controls}
            title={t("creative.desk.progress")}
          >
            <ProgressWidget
              pages={all.length}
              words={totalWords}
              groups={groups}
              onCompile={vaultPath ? () => void assemble() : null}
              compile={compile}
            />
          </DeskWidget>
        )
      case "chapters":
        return (
          <DeskWidget
            key={item.id}
            style={style}
            controls={controls}
            title={t("creative.desk.chapters")}
            count={all.length}
          >
            <ChaptersWidget
              roots={roots}
              levels={levels}
              statusOptions={statusOptions}
              stats={stats}
              pageOrder={pageOrder}
              pageTitleOf={(noteId) => rows?.find((row) => row.noteId === noteId)?.title ?? ""}
              bindings={bindings}
              plotTitleOf={plotTitleOf}
              ahead={ahead}
              hasAnchors={Boolean(anchorsSection)}
              binding={binding}
              canWrite={canWrite}
              onOpenNote={onOpenNote}
              onCreatePage={createPage}
              onMovePage={movePage}
              onCreateAnchor={canCreateAnchor ? createAnchor : null}
              moveError={moveError}
              loading={data.status === "loading" || data.status === "idle"}
            />
          </DeskWidget>
        )
      case "notes":
        return notesSection ? (
          <DeskWidget
            key={item.id}
            style={style}
            controls={controls}
            title={t("creative.notesBoard.title")}
            count={noteRows?.length ?? null}
          >
            <NotesBoard
              embedded
              notes={noteRows}
              notebooks={notebookCatalog?.notebooks ?? []}
              modifiedOf={noteModifiedOf}
              onOpenNote={onOpenNote}
              onCreate={createNote}
            />
          </DeskWidget>
        ) : null
      default: {
        const section = sectionOfWidget(item.id)
        if (!section) return null
        const sectionRows = rowsOfSection.get(section.id) ?? []
        return (
          <DeskWidget
            key={item.id}
            style={style}
            controls={controls}
            title={worldTitle(section)}
            count={sectionRows.length}
            onOpen={onOpenSection ? () => onOpenSection(section.id) : null}
          >
            <SectionGallery
              compact
              section={section}
              rows={sectionRows}
              loading={data.status === "loading"}
              onOpenNote={onOpenNote}
              createFor={createFor(section)}
            />
          </DeskWidget>
        )
      }
    }
  }

  const hidden = items.filter((item) => item.hidden)
  return (
    <div ref={deskRef} className="mb-8 flex w-full min-w-0 flex-col gap-4">
      {editing && (
        <p className="rounded-xl bg-primary/10 px-3.5 py-2.5 text-[13px] text-foreground">
          {t("creative.desk.editHint")}
        </p>
      )}
      <div className={cn("grid items-start gap-4", COLUMN_CLASS[columns])}>
        {shown.map(renderWidget)}
      </div>
      {editing && (
        <section
          aria-label={t("creative.desk.hiddenTitle")}
          className="flex flex-col gap-2.5 rounded-2xl border border-dashed border-border px-[18px] py-4"
        >
          <h2 className="text-sm font-semibold">{t("creative.desk.hiddenTitle")}</h2>
          <div className="flex flex-wrap gap-2">
            {hidden.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-label={t("creative.desk.show", { name: widgetTitle(item.id) })}
                onClick={() => change(setWidgetHidden(items, item.id, false))}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-background px-3.5 text-sm outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Plus className="size-3.5" />
                {widgetTitle(item.id)}
              </button>
            ))}
            {hidden.length === 0 && (
              <span className="text-sm text-muted-foreground">{t("creative.desk.noHidden")}</span>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
