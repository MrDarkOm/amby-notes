import * as React from "react"
import {
  Anchor,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Library,
  Plus,
  StickyNote,
  Waypoints,
  type LucideIcon,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { AmbySelect } from "@/components/ui/amby-select"
import { Button } from "@/components/ui/button"
import {
  moveTextPage,
  type DatabaseRow,
  type ProjectSummary,
  type TextLevelSummary,
} from "@/lib/storage"
import { cn } from "@/lib/utils"
import { IconValue } from "../../icon-value"
import { Accordion } from "./accordion"
import { ItemMenu } from "./item-menu"
import { useCreativeNavStore } from "../creative-nav-store"
import { projectErrorText } from "../project-error"
import { levelIndexOfSection, storySection, type WorksSection } from "./workshop-model"
import {
  buildTextTree,
  descendantIds,
  nodesAtLevel,
  planMove,
  type DropZone,
  type TextNode,
} from "./text-tree-model"

interface WorksTabProps {
  stories: ProjectSummary[]
  /** The story whose parts are shown: the one chosen in the list above them. */
  selectedStoryId: string | null
  onSelectStory: (storyId: string) => void
  /** Which accordion parts are unfolded. */
  open: Record<WorksSection, boolean>
  onToggleSection: (section: WorksSection) => void
  rows: Record<string, DatabaseRow[]>
  status: "idle" | "loading" | "ready" | "error"
  error: string | null
  vaultGeneration: number | null
  onOpenNote: (noteId: string) => void
  onOpenProject: (projectId: string) => void
  /** `levelId` names the level the page starts at when it is not the parent's next one. */
  onAddPage: (story: ProjectSummary, parent: TextNode | null, levelId?: string | null) => void
  onAddNote: (story: ProjectSummary) => void
  onAddAnchor: (story: ProjectSummary) => void
  /** The story has no anchors section: offers making one. */
  onCreateAnchors: (story: ProjectSummary) => void
  /** A page moved or a move was refused: the lists read the files again. */
  onMoved: () => void
  /** What goes under the story's parts: the world. */
  children?: React.ReactNode
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
  collapsed: Record<string, boolean>
  onToggle: (noteId: string) => void
  onOpenNote: (noteId: string) => void
  onAddPage: (parent: TextNode) => void
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
        return (
          <React.Fragment key={node.noteId}>
            <ItemMenu
              noteId={node.noteId}
              title={node.title}
              nested={descendantIds(node)}
              indent={depth * 14 + 24}
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
                  "group flex items-center gap-1 rounded-md border-y-2 border-transparent pr-1 hover:bg-accent/40",
                  context.dragId === node.noteId && "opacity-50",
                  hint === "before" && "border-t-primary",
                  hint === "after" && "border-b-primary",
                  hint === "inside" && "bg-primary/10",
                )}
                style={{ paddingLeft: `${depth * 14}px` }}
              >
                <button
                  type="button"
                  className="flex size-5 shrink-0 items-center justify-center text-muted-foreground disabled:opacity-0"
                  disabled={node.children.length === 0}
                  aria-label={open ? t("creative.panel.collapse") : t("creative.panel.expand")}
                  aria-expanded={node.children.length > 0 ? open : undefined}
                  onClick={() => context.onToggle(node.noteId)}
                >
                  {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                </button>
                <button
                  type="button"
                  title={level?.name ?? undefined}
                  onClick={() => context.onOpenNote(node.noteId)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-xs"
                >
                  <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
                    <IconValue
                      value={level?.icon ?? undefined}
                      fallback={<FileText className="size-3.5" />}
                      className="size-3.5"
                    />
                  </span>
                  <span className="min-w-0 truncate">{node.title}</span>
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-6 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                  title={t("creative.workshop.addChildPage")}
                  aria-label={t("creative.workshop.addChildPage", { name: node.title })}
                  onClick={() => context.onAddPage(node)}
                >
                  <Plus className="size-3.5" />
                </Button>
              </div>
            </ItemMenu>
            {open && node.children.length > 0 && (
              <TreeRows nodes={node.children} depth={depth + 1} context={context} />
            )}
          </React.Fragment>
        )
      })}
    </>
  )
}

const SECTION_ICONS: Record<WorksSection, LucideIcon> = {
  books: Library,
  arcs: Waypoints,
  anchors: Anchor,
  notes: StickyNote,
}

/** A part's own name: the story's level name, with the template's names read as plurals. */
function sectionLabel(
  story: ProjectSummary,
  section: WorksSection,
  t: (key: string) => string,
): string {
  if (section === "anchors") return t("creative.workshop.sections.anchors")
  if (section === "notes") return t("creative.sections.notes")
  const index = levelIndexOfSection(section) ?? 0
  const name = story.text?.levels[index]?.name?.trim()
  const schemaKey = section === "books" ? "book" : "arc"
  const plural = t(`creative.workshop.sections.${section}`)
  return !name ||
    name.toLocaleLowerCase() === t(`creative.schema.levels.${schemaKey}`).toLocaleLowerCase()
    ? plural
    : name
}

function StoryWorks({
  story,
  open,
  onToggleSection,
  rows,
  vaultGeneration,
  onOpenNote,
  onAddPage,
  onAddNote,
  onAddAnchor,
  onCreateAnchors,
  onMoved,
}: {
  story: ProjectSummary
  open: Record<WorksSection, boolean>
  onToggleSection: (section: WorksSection) => void
  rows: Record<string, DatabaseRow[]>
  vaultGeneration: number | null
  onOpenNote: (noteId: string) => void
  onAddPage: (story: ProjectSummary, parent: TextNode | null, levelId?: string | null) => void
  onAddNote: (story: ProjectSummary) => void
  onAddAnchor: (story: ProjectSummary) => void
  onCreateAnchors: (story: ProjectSummary) => void
  onMoved: () => void
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
  const notesSection = storySection(story, "notes")
  const noteRows = notesSection ? (rows[notesSection.databaseId] ?? []) : []
  const anchorsSection = storySection(story, "anchors")
  const anchorRows = anchorsSection ? (rows[anchorsSection.databaseId] ?? []) : []
  const canWrite = !story.readOnly

  const reset = () => {
    setDragId(null)
    setHint(null)
  }
  const plan = (targetId: string, zone: DropZone) =>
    dragId ? planMove(roots, levels, dragId, targetId, zone) : null

  const context: TreeContext = {
    levels,
    collapsed,
    onToggle: (noteId) => toggle(`page:${noteId}`),
    onOpenNote,
    onAddPage: (parent) => onAddPage(story, parent),
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
        projectId: story.projectId,
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
  const rowList = (list: DatabaseRow[], icon: React.ReactNode) =>
    [...list].sort(byTitle).map((row) => (
      <ItemMenu key={row.noteId} noteId={row.noteId} title={row.title}>
        <button
          type="button"
          onClick={() => onOpenNote(row.noteId)}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/50"
        >
          {icon}
          <span className="min-w-0 truncate">{row.title}</span>
        </button>
      </ItemMenu>
    ))
  const hintText = (key: string) => (
    <p className="px-2 py-1.5 text-[11px] text-muted-foreground">{t(key)}</p>
  )

  const levelPart = (section: "books" | "arcs") => {
    const index = levelIndexOfSection(section) ?? 0
    const level = levels[index] ?? null
    const nodes = level ? nodesAtLevel(roots, level.id) : []
    let content: React.ReactNode
    if (!text?.databaseId) content = hintText("creative.workshop.noText")
    else if (!level) content = hintText("creative.workshop.noLevel")
    else if (nodes.length === 0) content = hintText("creative.workshop.noPages")
    else content = <TreeRows nodes={nodes} depth={0} context={context} />
    return {
      count: level ? nodes.length : null,
      add: canWrite && level && text?.databaseId ? () => onAddPage(story, null, level.id) : null,
      content,
    }
  }

  const parts: Record<
    WorksSection,
    { count: number | null; add: (() => void) | null; content: React.ReactNode }
  > = {
    books: levelPart("books"),
    arcs: levelPart("arcs"),
    anchors: {
      count: anchorsSection ? anchorRows.length : null,
      add: canWrite && anchorsSection ? () => onAddAnchor(story) : null,
      content: !anchorsSection ? (
        <div className="flex flex-col items-start gap-1.5 px-2 py-1.5">
          <p className="text-[11px] text-muted-foreground">{t("creative.workshop.noAnchors")}</p>
          {canWrite && (
            <Button variant="outline" size="sm" onClick={() => onCreateAnchors(story)}>
              {t("creative.workshop.createAnchors")}
            </Button>
          )}
        </div>
      ) : anchorRows.length === 0 ? (
        hintText("creative.workshop.noAnchorsYet")
      ) : (
        rowList(anchorRows, <Anchor className="size-3.5 shrink-0 text-muted-foreground" />)
      ),
    },
    notes: {
      count: notesSection ? noteRows.length : null,
      add: canWrite && notesSection ? () => onAddNote(story) : null,
      content: !notesSection
        ? hintText("creative.workshop.noNotesSection")
        : noteRows.length === 0
          ? hintText("creative.workshop.noNotesYet")
          : rowList(noteRows, <FileText className="size-3.5 shrink-0 text-muted-foreground" />),
    },
  }

  // The second level is a part only for a story whose schema has one.
  const shown: WorksSection[] = [
    "books",
    ...(levels.length > 1 ? (["arcs"] as const) : []),
    "anchors",
    "notes",
  ]

  return (
    <div>
      {moveError && (
        <p role="alert" className="px-2 py-1 text-[11px] text-destructive">
          {moveError}
        </p>
      )}
      {shown.map((section) => {
        const part = parts[section]
        const label = sectionLabel(story, section, t)
        return (
          <Accordion
            key={section}
            icon={SECTION_ICONS[section]}
            label={label}
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
 * books, arcs, anchors and notes.
 */
export function WorksTab({
  stories,
  selectedStoryId,
  onSelectStory,
  open,
  onToggleSection,
  rows,
  status,
  error,
  vaultGeneration,
  onOpenNote,
  onOpenProject,
  onAddPage,
  onAddNote,
  onAddAnchor,
  onCreateAnchors,
  onMoved,
  children,
}: WorksTabProps) {
  const { t } = useTranslation()
  const story = stories.find((candidate) => candidate.projectId === selectedStoryId) ?? null
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {stories.length > 0 && (
        <div className="flex shrink-0 items-center gap-1 px-4 pb-2">
          <div className="min-w-0 flex-1">
            <AmbySelect
              aria-label={t("creative.workshop.chooseStory")}
              value={story?.projectId ?? ""}
              onValueChange={onSelectStory}
              options={stories.map((entry) => ({ value: entry.projectId, label: entry.name }))}
            />
          </div>
          {story && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              title={t("creative.workshop.openStory")}
              aria-label={t("creative.workshop.openStory")}
              onClick={() => onOpenProject(story.projectId)}
            >
              <ExternalLink className="size-4" />
            </Button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
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
            key={story.projectId}
            story={story}
            open={open}
            onToggleSection={onToggleSection}
            rows={rows}
            vaultGeneration={vaultGeneration}
            onOpenNote={onOpenNote}
            onAddPage={onAddPage}
            onAddNote={onAddNote}
            onAddAnchor={onAddAnchor}
            onCreateAnchors={onCreateAnchors}
            onMoved={onMoved}
          />
        )}
        {children}
      </div>
    </div>
  )
}
