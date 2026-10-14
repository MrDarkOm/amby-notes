import * as React from "react"
import {
  Anchor,
  BookText,
  ChevronRight,
  FileText,
  Plus,
  StickyNote,
  type LucideIcon,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  applyDatabaseValueBatch,
  moveTextPage,
  type DatabaseRow,
  type StorySummary,
  type TextLevelSummary,
  type TextPageStat,
  type TextStatusOptionSummary,
  type WorkshopSummary,
} from "@/lib/storage"
import { motion } from "motion/react"
import { motionTransitions } from "@/lib/motion-config"
import { cn } from "@/lib/utils"
import { IconValue } from "../../icon-value"
import { Accordion } from "./accordion"
import { treeIndent } from "./tree-indent"
import { EmptyAction } from "./empty-action"
import { InlineCreateRow } from "./inline-create-row"
import { StoryHeader } from "./story-header"
import { ItemMenu } from "./item-menu"
import { useCreativeNavStore } from "../creative-nav-store"
import { projectErrorText } from "../project-error"
import { formatModified } from "../../workspace-tree-utils"
import { moveRowInOrder, type RowDropPlacement } from "../../database/row-order"
import {
  orderByAuthor,
  storySection,
  WORKS_SECTIONS,
  type WorkshopDraft,
  type WorksSection,
} from "./workshop-model"
import {
  ancestorIds,
  buildTextTree,
  canHaveChildPage,
  countNodes,
  descendantIds,
  pageStatusDotClass,
  planMove,
  resolvePageStatus,
  type DropZone,
  type TextNode,
} from "./text-tree-model"

interface WorksTabProps {
  workshop: WorkshopSummary
  stories: StorySummary[]
  /** The story whose parts are shown: the one chosen in the list above them. */
  selectedStoryId: string | null
  universes?: Array<{ noteId: string; title: string }>
  selectedUniverseId?: string | null
  onSelectStory: (storyId: string | null) => void
  onSelectUniverse?: (universeId: string | null) => void
  /** Which accordion parts are unfolded. */
  open: Record<WorksSection, boolean>
  onToggleSection: (section: WorksSection) => void
  rows: Record<string, DatabaseRow[]>
  status: "idle" | "loading" | "ready" | "error"
  error: string | null
  vaultGeneration: number | null
  onOpenNote: (noteId: string) => void
  onOpenProject: (projectId: string) => void
  /** Makes a new story: the last item of the header's list. */
  onNewStory: () => void
  /** Pages and words of the chosen story's text; `null` while not loaded. */
  totals: { pages: number | null; words: number | null }
  /** A page under `parent`, or at the top of the text for `null`. */
  onAddPage: (story: StorySummary, parent: TextNode | null) => void
  onAddAnchor: (story: StorySummary) => void
  /**
   * The notes part: the count, the "+" and the notebooks with their notes, already filtered by
   * what is shown. `null` when the workshop has no notes section. It stands under a story's
   * parts, or alone when a universe or the whole workshop is shown.
   */
  notes: NotesSlot | null
  /** The story has no anchors section: offers making one. */
  onCreateAnchors: (story: StorySummary) => void
  /** A page moved or a move was refused: the lists read the files again. */
  onMoved: () => void
  /** The page open in the editor: its row is marked and its parents are unfolded. */
  activeNoteId: string | null
  /** Words and last-change time of the text's pages, from the note index. */
  stats: Record<string, TextPageStat>
  /** Anchors in the order the author placed them by hand, and when each was made. */
  anchorOrder: string[]
  anchorCreated: Record<string, number | null>
  /** The anchors in a new order (note IDs); rejects when it could not be saved. */
  onReorderAnchors: (next: string[]) => Promise<void>
  /** The row being named where it will stand, if any. */
  draft: WorkshopDraft | null
  /** Creates what the draft names; a rejection is shown on the row. */
  onCommitDraft: (title: string) => Promise<void>
  onCancelDraft: () => void
  /** What goes under the story's parts: the world. */
  children?: React.ReactNode
}

export interface NotesSlot {
  count: number | null
  /** Starts naming a note in the root of the base; `null` when the workshop is read-only. */
  onAdd: (() => void) | null
  content: React.ReactNode
}

interface DropHint {
  noteId: string
  zone: DropZone
}

function zoneOf(event: React.DragEvent<HTMLElement>): DropZone {
  const rect = event.currentTarget.getBoundingClientRect()
  const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
  return ratio < 0.28 ? "before" : ratio > 0.72 ? "after" : "inside"
}

interface TreeContext {
  levels: TextLevelSummary[]
  statusOptions: TextStatusOptionSummary[]
  onSetStatus?: (node: TextNode, optionId: string | null) => void
  collapsed: Record<string, boolean>
  onToggle: (noteId: string) => void
  onOpenNote: (noteId: string) => void
  onAddPage: (parent: TextNode) => void
  /** Whether a page may have pages under it (the last level of the schema may not). */
  canAddChild: (node: TextNode) => boolean
  activeNoteId: string | null
  stats: Record<string, TextPageStat>
  /** Words of a page together with every page below it. */
  wordsOf: (node: TextNode) => number
  /** Whose children the new page's row goes among: a page, `null` for the top, none for no row. */
  draftParentId: string | null | undefined
  renderDraft: (depth: number) => React.ReactNode
  dragId: string | null
  hint: DropHint | null
  onDragStart: (noteId: string) => void
  onDragOver: (event: React.DragEvent<HTMLElement>, noteId: string) => void
  onDrop: (event: React.DragEvent<HTMLElement>, noteId: string) => void
  onDragEnd: () => void
}

function TreeRows({
  nodes,
  depth,
  context,
}: {
  nodes: TextNode[]
  depth: number
  context: TreeContext
}) {
  const { t } = useTranslation()
  return (
    <>
      {nodes.map((node) => {
        const open = !context.collapsed[`page:${node.noteId}`]
        const level = context.levels.find((entry) => entry.id === node.levelId)
        const hint = context.hint?.noteId === node.noteId ? context.hint.zone : null
        const active = context.activeNoteId === node.noteId
        const leaf = node.children.length === 0
        const words = context.wordsOf(node)
        const draftHere = context.draftParentId === node.noteId
        const statusOption = resolvePageStatus(context.statusOptions, node.statusOptionId)
        const dotClass = pageStatusDotClass(context.statusOptions, node.statusOptionId, words)
        const dotTitle =
          statusOption?.name ??
          t(words > 0 ? "creative.workshop.pageWritten" : "creative.workshop.pageBlank")
        return (
          <React.Fragment key={node.noteId}>
            <ItemMenu
              noteId={node.noteId}
              title={node.title}
              nested={descendantIds(node)}
              indent={treeIndent(depth + 1) - 6}
              statusOptions={context.statusOptions}
              statusOptionId={node.statusOptionId}
              onSelectStatus={
                context.onSetStatus
                  ? (optionId) => context.onSetStatus?.(node, optionId)
                  : undefined
              }
            >
              <div
                draggable
                data-text-page={node.noteId}
                onDragStart={(event) => {
                  event.dataTransfer.setData("text/plain", node.noteId)
                  event.dataTransfer.effectAllowed = "move"
                  context.onDragStart(node.noteId)
                }}
                onDragOver={(event) => context.onDragOver(event, node.noteId)}
                onDrop={(event) => context.onDrop(event, node.noteId)}
                onDragEnd={context.onDragEnd}
                className={cn(
                  "amby-tree-row group flex items-center gap-1.5 rounded border-y-2 border-transparent py-0 pr-1 text-[13px] hover:bg-accent",
                  active && "bg-accent",
                  context.dragId === node.noteId && "opacity-50",
                  hint === "before" && "border-t-primary",
                  hint === "after" && "border-b-primary",
                  hint === "inside" && "bg-primary/10",
                )}
                style={{ paddingLeft: treeIndent(depth + 1) }}
              >
                {leaf ? (
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {/* A page with nothing under it shows its status or whether it has been written yet. */}
                    <span
                      aria-hidden="true"
                      title={dotTitle}
                      className={cn("size-2 rounded-full", dotClass)}
                    />
                  </span>
                ) : (
                  <span className="amby-tree-folder-icon relative inline-flex size-4 shrink-0 items-center justify-center">
                    <span className="amby-tree-main-icon flex text-muted-foreground">
                      <IconValue
                        value={level?.icon ?? undefined}
                        fallback={<FileText className="size-4" />}
                        className="size-4"
                      />
                    </span>
                    <button
                      type="button"
                      className="amby-tree-folder-toggle absolute inset-0 z-10 flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      aria-label={open ? t("creative.panel.collapse") : t("creative.panel.expand")}
                      aria-expanded={open}
                      onClick={() => context.onToggle(node.noteId)}
                    >
                      <motion.span
                        className="flex"
                        initial={false}
                        animate={{ rotate: open ? 90 : 0 }}
                        transition={motionTransitions.default}
                      >
                        <ChevronRight className="size-3" />
                      </motion.span>
                    </button>
                  </span>
                )}
                <button
                  type="button"
                  title={level?.name ?? undefined}
                  aria-current={active ? "true" : undefined}
                  onClick={() => context.onOpenNote(node.noteId)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left"
                >
                  <span className="min-w-0 truncate">{node.title}</span>
                  {(leaf || words > 0) && (
                    <span
                      className={cn(
                        "ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground",
                        words === 0 && "opacity-60",
                      )}
                      title={t("docEditor.wordCount", { count: words })}
                    >
                      {words.toLocaleString()}
                    </span>
                  )}
                </button>
                {context.canAddChild(node) && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-5 text-muted-foreground opacity-50 hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
                    title={t("creative.workshop.addChildPage")}
                    aria-label={t("creative.workshop.addChildPage", { name: node.title })}
                    onClick={() => context.onAddPage(node)}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                )}
              </div>
            </ItemMenu>
            {open && (node.children.length > 0 || draftHere) && (
              <>
                <TreeRows nodes={node.children} depth={depth + 1} context={context} />
                {draftHere && context.renderDraft(depth + 1)}
              </>
            )}
          </React.Fragment>
        )
      })}
    </>
  )
}

const SECTION_ICONS: Record<WorksSection, LucideIcon> = {
  text: BookText,
  anchors: Anchor,
  notes: StickyNote,
}

const SECTION_LABEL_KEYS: Record<WorksSection, string> = {
  text: "creative.sections.text",
  anchors: "creative.workshop.sections.anchors",
  notes: "creative.sections.notes",
}

function StoryWorks({
  workshop,
  story,
  open,
  onToggleSection,
  rows,
  vaultGeneration,
  onOpenNote,
  onAddPage,
  onAddAnchor,
  notes,
  onCreateAnchors,
  onMoved,
  activeNoteId,
  stats,
  anchorOrder,
  anchorCreated,
  onReorderAnchors,
  draft,
  onCommitDraft,
  onCancelDraft,
}: {
  workshop: WorkshopSummary
  story: StorySummary
  open: Record<WorksSection, boolean>
  onToggleSection: (section: WorksSection) => void
  rows: Record<string, DatabaseRow[]>
  vaultGeneration: number | null
  onOpenNote: (noteId: string) => void
  onAddPage: (story: StorySummary, parent: TextNode | null) => void
  onAddAnchor: (story: StorySummary) => void
  notes: NotesSlot | null
  onCreateAnchors: (story: StorySummary) => void
  onMoved: () => void
  activeNoteId: string | null
  stats: Record<string, TextPageStat>
  anchorOrder: string[]
  anchorCreated: Record<string, number | null>
  onReorderAnchors: (next: string[]) => Promise<void>
  draft: WorkshopDraft | null
  onCommitDraft: (title: string) => Promise<void>
  onCancelDraft: () => void
}) {
  const { t } = useTranslation()
  const collapsed = useCreativeNavStore((state) => state.collapsed)
  const toggle = useCreativeNavStore((state) => state.toggleCollapsed)
  const [dragId, setDragId] = React.useState<string | null>(null)
  const [hint, setHint] = React.useState<DropHint | null>(null)
  const [moveError, setMoveError] = React.useState<string | null>(null)

  const text = story.text
  const textRows = text?.databaseId ? rows[text.databaseId] : undefined
  const roots = React.useMemo(
    () => (text && textRows ? buildTextTree(textRows, text.properties) : []),
    [text, textRows],
  )
  const levels = React.useMemo(() => text?.levels ?? [], [text])
  const anchorsSection = storySection(workshop, "anchors")
  const anchorRows = anchorsSection ? (rows[anchorsSection.databaseId] ?? []) : []
  const canWrite = !workshop.readOnly
  const rootRef = React.useRef<HTMLDivElement>(null)

  // The open page is found in the text: its parents unfold, the part opens, the row scrolls into
  // view. Only when the open page changes, so folding a part by hand afterwards is not undone.
  const revealed = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!activeNoteId) {
      revealed.current = null
      return
    }
    if (revealed.current === activeNoteId) return
    const path = ancestorIds(roots, activeNoteId)
    if (path === null) return
    revealed.current = activeNoteId
    if (!open.text) onToggleSection("text")
    const folded = useCreativeNavStore.getState().collapsed
    for (const id of path) if (folded[`page:${id}`]) toggle(`page:${id}`)
    requestAnimationFrame(() => {
      const row = Array.from(
        rootRef.current?.querySelectorAll<HTMLElement>("[data-text-page]") ?? [],
      ).find((element) => element.dataset.textPage === activeNoteId)
      row?.scrollIntoView?.({ block: "nearest" })
    })
    // `open` and the callbacks are read at the moment of the reveal, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNoteId, roots])

  // A page's words with those of the pages below it, counted once per read of the text.
  const subtreeWords = React.useMemo(() => {
    const result = new Map<string, number>()
    const visit = (node: TextNode): number => {
      let sum = stats[node.noteId]?.wordCount ?? 0
      for (const child of node.children) sum += visit(child)
      result.set(node.noteId, sum)
      return sum
    }
    roots.forEach(visit)
    return result
  }, [roots, stats])

  const reset = () => {
    setDragId(null)
    setHint(null)
  }
  const plan = (targetId: string, zone: DropZone) =>
    dragId ? planMove(roots, levels, dragId, targetId, zone) : null

  const statusOptions = text?.properties.status ? (text.statusOptions ?? []) : []

  const context: TreeContext = {
    levels,
    statusOptions,
    onSetStatus:
      canWrite && text?.databaseId && text.properties.status && statusOptions.length > 0
        ? (node, optionId) => {
            if (!text.databaseId || !text.properties.status || vaultGeneration === null) return
            setMoveError(null)
            void applyDatabaseValueBatch({
              expectedGeneration: vaultGeneration,
              databaseId: text.databaseId,
              operationId: `status-${crypto.randomUUID()}`,
              cells: [
                {
                  noteId: node.noteId,
                  propertyId: text.properties.status,
                  valueJson: optionId ? JSON.stringify({ type: "status", optionId }) : undefined,
                  expectedRevision: node.revision,
                },
              ],
            })
              .catch((error: unknown) => setMoveError(projectErrorText(t, error)))
              .finally(onMoved)
          }
        : undefined,
    collapsed,
    onToggle: (noteId) => toggle(`page:${noteId}`),
    onOpenNote,
    onAddPage: (parent) => onAddPage(story, parent),
    canAddChild: (node) => canHaveChildPage(levels, node),
    activeNoteId,
    stats,
    wordsOf: (node) => subtreeWords.get(node.noteId) ?? 0,
    draftParentId: draft?.kind === "page" ? draft.parentId : undefined,
    renderDraft: (depth) => (
      <InlineCreateRow
        depth={depth}
        icon={<FileText className="size-3.5" />}
        placeholder={t("creative.workshop.newPagePlaceholder")}
        onSubmit={onCommitDraft}
        onCancel={onCancelDraft}
      />
    ),
    dragId,
    hint,
    onDragStart: setDragId,
    onDragOver: (event, noteId) => {
      if (!canWrite || !dragId) return
      const zone = zoneOf(event)
      if (plan(noteId, zone) === null) {
        setHint(null)
        return
      }
      // Dropping is only allowed where the move is valid: the cursor says so.
      event.preventDefault()
      event.dataTransfer.dropEffect = "move"
      setHint((previous) =>
        previous?.noteId === noteId && previous.zone === zone ? previous : { noteId, zone },
      )
    },
    onDrop: (event, noteId) => {
      event.preventDefault()
      const zone = zoneOf(event)
      const move = plan(noteId, zone)
      const draggedId = dragId
      reset()
      if (!move || !draggedId || vaultGeneration === null) return
      const dragged = textRows?.find((row) => row.noteId === draggedId)
      if (!dragged) return
      setMoveError(null)
      void moveTextPage({
        expectedGeneration: vaultGeneration,
        operationId: `move-${crypto.randomUUID()}`,
        storyId: story.storyId,
        noteId: draggedId,
        newParentNoteId: move.newParentId,
        orderKey: move.orderKey,
        expectedRevision: dragged.rowRevision,
      })
        .catch((error: unknown) => setMoveError(projectErrorText(t, error)))
        .finally(onMoved)
    },
    onDragEnd: reset,
  }

  const byTitle = (a: DatabaseRow, b: DatabaseRow) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" })

  // Anchors are events, so they keep the author's order and can be moved: dropped on another
  // one, a row goes before or after it. The order is the first view's own `manualOrder`.
  const [anchorDrag, setAnchorDrag] = React.useState<{
    id: string
    overId: string | null
    placement: RowDropPlacement
  } | null>(null)
  const orderedAnchors = orderByAuthor(anchorRows, anchorOrder, (noteId) => anchorCreated[noteId])
  const dropAnchor = (targetId: string, placement: RowDropPlacement) => {
    const moved = anchorDrag?.id
    setAnchorDrag(null)
    if (!moved) return
    const next = moveRowInOrder(
      anchorOrder,
      orderedAnchors.map((row) => row.noteId),
      moved,
      targetId,
      placement,
    )
    if (!next) return
    setMoveError(null)
    onReorderAnchors(next).catch((error: unknown) => setMoveError(projectErrorText(t, error)))
  }

  const rowList = (list: DatabaseRow[], icon: React.ReactNode, reorder = false) =>
    (reorder ? list : [...list].sort(byTitle)).map((row) => {
      const over = reorder && anchorDrag?.overId === row.noteId ? anchorDrag.placement : null
      return (
        <ItemMenu key={row.noteId} noteId={row.noteId} title={row.title}>
          <button
            type="button"
            draggable={reorder && canWrite}
            aria-current={activeNoteId === row.noteId ? "true" : undefined}
            onClick={() => onOpenNote(row.noteId)}
            onDragStart={
              reorder && canWrite
                ? (event) => {
                    event.dataTransfer.setData("text/plain", row.noteId)
                    event.dataTransfer.effectAllowed = "move"
                    setAnchorDrag({ id: row.noteId, overId: null, placement: "after" })
                  }
                : undefined
            }
            onDragOver={
              reorder && canWrite
                ? (event) => {
                    if (!anchorDrag || anchorDrag.id === row.noteId) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = "move"
                    const rect = event.currentTarget.getBoundingClientRect()
                    const placement: RowDropPlacement =
                      event.clientY < rect.top + rect.height / 2 ? "before" : "after"
                    if (anchorDrag.overId !== row.noteId || anchorDrag.placement !== placement) {
                      setAnchorDrag({ ...anchorDrag, overId: row.noteId, placement })
                    }
                  }
                : undefined
            }
            onDrop={
              reorder && canWrite
                ? (event) => {
                    event.preventDefault()
                    dropAnchor(row.noteId, anchorDrag?.placement ?? "after")
                  }
                : undefined
            }
            onDragEnd={reorder ? () => setAnchorDrag(null) : undefined}
            style={{ paddingLeft: treeIndent(1) }}
            className={cn(
              "amby-tree-row flex w-full items-center gap-1.5 rounded border-y-2 border-transparent py-0.5 pr-3 text-left text-[13px] hover:bg-accent",
              activeNoteId === row.noteId && "bg-accent",
              reorder && anchorDrag?.id === row.noteId && "opacity-50",
              over === "before" && "border-t-primary",
              over === "after" && "border-b-primary",
            )}
          >
            {icon}
            <span className="min-w-0 truncate">{row.title}</span>
          </button>
        </ItemMenu>
      )
    })
  const hintText = (key: string) => (
    <p className="py-1 pr-3 text-xs text-muted-foreground" style={{ paddingLeft: treeIndent(1) }}>
      {t(key)}
    </p>
  )
  const anchorDraftRow =
    draft?.kind === "anchor" ? (
      <InlineCreateRow
        depth={0}
        icon={<Anchor className="size-3.5" />}
        placeholder={t("creative.workshop.newAnchorPlaceholder")}
        onSubmit={onCommitDraft}
        onCancel={onCancelDraft}
      />
    ) : null

  // The whole text, as the tree buildTextTree makes: every page once, a page without a parent or
  // a level among the roots.
  const textPart = () => {
    const topDraft = draft?.kind === "page" && draft.parentId === null
    let content: React.ReactNode
    if (!text?.databaseId) content = hintText("creative.workshop.noText")
    else if (roots.length === 0 && !topDraft) {
      content = canWrite ? (
        <EmptyAction
          label={t("creative.workshop.addFirstPage")}
          onClick={() => onAddPage(story, null)}
        />
      ) : (
        hintText("creative.workshop.noPages")
      )
    } else {
      content = (
        <>
          <TreeRows nodes={roots} depth={0} context={context} />
          {topDraft && context.renderDraft(0)}
        </>
      )
    }
    return {
      count: text?.databaseId ? countNodes(roots) : null,
      add: canWrite && text?.databaseId ? () => onAddPage(story, null) : null,
      content,
    }
  }

  const parts: Record<
    WorksSection,
    { count: number | null; add: (() => void) | null; content: React.ReactNode }
  > = {
    text: textPart(),
    anchors: {
      count: anchorsSection ? anchorRows.length : null,
      add: canWrite && anchorsSection ? () => onAddAnchor(story) : null,
      content: !anchorsSection ? (
        <div
          className="flex flex-col items-start gap-1.5 py-1 pr-3"
          style={{ paddingLeft: treeIndent(1) }}
        >
          <p className="text-xs text-muted-foreground">{t("creative.workshop.noAnchors")}</p>
          {canWrite && (
            <Button variant="outline" size="sm" onClick={() => onCreateAnchors(story)}>
              {t("creative.workshop.createAnchors")}
            </Button>
          )}
        </div>
      ) : (
        <>
          {anchorRows.length === 0 && draft?.kind !== "anchor" ? (
            canWrite ? (
              <EmptyAction
                label={t("creative.workshop.addFirstAnchor")}
                onClick={() => onAddAnchor(story)}
              />
            ) : (
              hintText("creative.workshop.noAnchorsYet")
            )
          ) : (
            rowList(
              orderedAnchors,
              <Anchor className="size-4 shrink-0 text-muted-foreground" />,
              true,
            )
          )}
          {anchorDraftRow}
        </>
      ),
    },
    notes: {
      count: notes?.count ?? null,
      add: canWrite && notes?.onAdd ? notes.onAdd : null,
      content: notes ? notes.content : hintText("creative.workshop.noNotesSection"),
    },
  }

  return (
    <div ref={rootRef}>
      {moveError && (
        <p role="alert" className="px-2 py-1 text-[11px] text-destructive">
          {moveError}
        </p>
      )}
      <h3 className="pb-0.5 pl-3.5 pt-1 text-[11px] text-muted-foreground">
        {t("creative.groups.work")}
      </h3>
      {WORKS_SECTIONS.map((section) => {
        const part = parts[section]
        return (
          <Accordion
            key={section}
            icon={SECTION_ICONS[section]}
            label={t(SECTION_LABEL_KEYS[section])}
            hint={section === "anchors" ? t("creative.workshop.anchorsHint") : undefined}
            count={part.count}
            open={open[section]}
            onToggle={() => onToggleSection(section)}
            onAdd={part.add}
            addLabel={t("creative.workshop.add")}
          >
            {part.content}
          </Accordion>
        )
      })}
    </div>
  )
}

/**
 * The works tab: a list of the stories and, for the chosen one, its parts as folding sections —
 * the text, anchors and notes.
 */
export function WorksTab({
  workshop,
  stories,
  selectedStoryId,
  universes = [],
  selectedUniverseId = null,
  onSelectStory,
  onSelectUniverse,
  open,
  onToggleSection,
  rows,
  status,
  error,
  vaultGeneration,
  onOpenNote,
  onOpenProject,
  onNewStory,
  totals,
  onAddPage,
  onAddAnchor,
  notes,
  onCreateAnchors,
  onMoved,
  activeNoteId,
  stats,
  anchorOrder,
  anchorCreated,
  onReorderAnchors,
  draft,
  onCommitDraft,
  onCancelDraft,
  children,
}: WorksTabProps) {
  const { t } = useTranslation()
  const story = selectedStoryId
    ? (stories.find((candidate) => candidate.storyId === selectedStoryId) ?? null)
    : null
  // Where to go on from: the page of the text changed last, unless it is the one already open.
  const textRows = story?.text?.databaseId ? rows[story.text.databaseId] : undefined
  const resume = React.useMemo(() => {
    let latest: DatabaseRow | null = null
    let latestAt = 0
    for (const row of textRows ?? []) {
      const at = stats[row.noteId]?.modified ?? 0
      if (at > latestAt) {
        latest = row
        latestAt = at
      }
    }
    if (!latest || latest.noteId === activeNoteId) return null
    return { noteId: latest.noteId, title: latest.title, when: formatModified(latestAt) ?? "" }
  }, [activeNoteId, stats, textRows])

  const handleOpenTarget = () => {
    if (selectedStoryId) {
      onOpenProject(selectedStoryId)
    } else if (selectedUniverseId) {
      onOpenProject(`universe:${selectedUniverseId}`)
    } else {
      onOpenProject(workshop.workshopId)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StoryHeader
        workshop={workshop}
        stories={stories}
        selectedStoryId={selectedStoryId}
        universes={universes}
        selectedUniverseId={selectedUniverseId}
        pages={totals.pages}
        words={totals.words}
        onSelectStory={onSelectStory}
        onSelectUniverse={onSelectUniverse}
        onNewStory={onNewStory}
        onOpenTarget={handleOpenTarget}
        resume={resume}
        onOpenNote={onOpenNote}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {status === "error" && (
          <p role="alert" className="px-2 py-3 text-xs text-destructive">
            {t("creative.workshop.loadFailed")}
            {error ? ` ${error}` : ""}
          </p>
        )}
        {stories.length === 0 && status !== "error" && (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            {t("creative.workshop.noStories")}
          </p>
        )}
        {story && (
          <StoryWorks
            key={story.storyId}
            workshop={workshop}
            story={story}
            open={open}
            onToggleSection={onToggleSection}
            rows={rows}
            vaultGeneration={vaultGeneration}
            onOpenNote={onOpenNote}
            onAddPage={onAddPage}
            onAddAnchor={onAddAnchor}
            notes={notes}
            onCreateAnchors={onCreateAnchors}
            onMoved={onMoved}
            activeNoteId={activeNoteId}
            stats={stats}
            anchorOrder={anchorOrder}
            anchorCreated={anchorCreated}
            onReorderAnchors={onReorderAnchors}
            draft={draft}
            onCommitDraft={onCommitDraft}
            onCancelDraft={onCancelDraft}
          />
        )}
        {!story && notes && (
          <div>
            <h3 className="pb-0.5 pl-3.5 pt-1 text-[11px] text-muted-foreground">
              {t("creative.groups.work")}
            </h3>
            <Accordion
              icon={SECTION_ICONS.notes}
              label={t(SECTION_LABEL_KEYS.notes)}
              count={notes.count}
              open={open.notes}
              onToggle={() => onToggleSection("notes")}
              onAdd={workshop.readOnly ? null : notes.onAdd}
              addLabel={t("creative.workshop.add")}
            >
              {notes.content}
            </Accordion>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
