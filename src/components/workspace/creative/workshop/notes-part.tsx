import * as React from "react"
import { ChevronRight, FileText, Folder, FolderPlus, Pencil, Plus, Trash2, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { motion } from "motion/react"
import { motionTransitions } from "@/lib/motion-config"
import { cn } from "@/lib/utils"
import { EmptyAction } from "./empty-action"
import { InlineCreateRow } from "./inline-create-row"
import { LinkAction } from "./link-action"
import { InlineRename, ItemMenu } from "./item-menu"
import {
  notebookTargets,
  sameSegments,
  type NoteItem,
  type NotebookNode,
  type NotebookTree,
} from "./notebook-model"
import type { NotebookActions } from "./use-notebook-actions"
import { treeIndent } from "./tree-indent"
import type { StoryLabels, WorkshopDraft } from "./workshop-model"

interface NotesPartProps {
  /** The notebooks and notes the filter lets through; every notebook is in it, empty or not. */
  tree: NotebookTree
  /** Notes in no story, only when the standalone stories are shown: a group of their own at the end. */
  withoutStory: NotebookTree | null
  canWrite: boolean
  /** The lists are still being read: an empty list is not yet "no notes". */
  loading: boolean
  activeNoteId: string | null
  onOpenNote: (noteId: string) => void
  /** Folding state: `notebook:<key>` is unfolded unless set. */
  collapsed: Record<string, boolean>
  onToggle: (key: string) => void
  /** The story names for a note's row (up to two and "+N"); `null` shows none. */
  storyLabelsOf: ((noteId: string) => StoryLabels) | null
  draft: WorkshopDraft | null
  onCommitDraft: (title: string) => Promise<void>
  onCancelDraft: () => void
  /** Starts naming a note inside a notebook (`[]`: the root of the base). */
  onAddNote: (notebook: string[]) => void
  /** Starts naming a notebook inside another (`[]`: the root of the base). */
  onAddNotebook: (parent: string[]) => void
  actions: NotebookActions
  /**
   * A notes base made before the links existed has no "Stories" relation, so no note is in a
   * story: offers adding it (`null` when it has one or the workshop is read-only).
   */
  link: { pending: boolean; error: string | null; onLink: () => void } | null
}

const ROOT = "root"

/**
 * The content of the "Notes" part: the notebooks as a tree of folders, each with its notes, the
 * notes that lie in no notebook last. Every notebook is listed, an empty one dimmed: it is still
 * where a note can be dropped or made. A note moves by dragging it onto a notebook, or from its
 * menu ("Move to notebook").
 */
export function NotesPart({
  tree,
  withoutStory,
  canWrite,
  loading,
  activeNoteId,
  onOpenNote,
  collapsed,
  onToggle,
  storyLabelsOf,
  draft,
  onCommitDraft,
  onCancelDraft,
  onAddNote,
  onAddNotebook,
  actions,
  link,
}: NotesPartProps) {
  const { t } = useTranslation()
  const [dragId, setDragId] = React.useState<string | null>(null)
  const [dropKey, setDropKey] = React.useState<string | null>(null)
  const [renaming, setRenaming] = React.useState<string | null>(null)
  const targets = React.useMemo(() => notebookTargets(tree), [tree])

  const endDrag = () => {
    setDragId(null)
    setDropKey(null)
  }
  const dropTarget = (key: string, segments: string[] | null) => ({
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      if (!canWrite || !dragId) return
      event.preventDefault()
      event.dataTransfer.dropEffect = "move"
      if (dropKey !== key) setDropKey(key)
    },
    onDragLeave: () => setDropKey((current) => (current === key ? null : current)),
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault()
      const moved = dragId
      endDrag()
      if (canWrite && moved) void actions.moveNote(moved, segments)
    },
  })

  const noteDraftIn = (notebook: readonly string[]) =>
    draft?.kind === "note" && sameSegments(draft.notebook ?? [], notebook)
  const notebookDraftIn = (parent: readonly string[]) =>
    draft?.kind === "notebook" && sameSegments(draft.parent, parent)

  const noteRow = (note: NoteItem, depth: number) => {
    const labels = storyLabelsOf?.(note.noteId)
    return (
      <ItemMenu
        key={note.noteId}
        noteId={note.noteId}
        title={note.title}
        indent={treeIndent(depth) - 6}
        move={
          canWrite
            ? {
                targets,
                current: note.categoryPath,
                onMove: (segments) => void actions.moveNote(note.noteId, segments),
              }
            : undefined
        }
      >
        <button
          type="button"
          draggable={canWrite}
          data-note-row={note.noteId}
          aria-current={activeNoteId === note.noteId ? "true" : undefined}
          onClick={() => onOpenNote(note.noteId)}
          onDragStart={
            canWrite
              ? (event) => {
                  event.dataTransfer.setData("text/plain", note.noteId)
                  event.dataTransfer.effectAllowed = "move"
                  setDragId(note.noteId)
                }
              : undefined
          }
          onDragEnd={endDrag}
          style={{ paddingLeft: treeIndent(depth) }}
          className={cn(
            "amby-tree-row flex w-full items-center gap-1.5 rounded py-0.5 pr-3 text-left text-[13px] hover:bg-accent",
            activeNoteId === note.noteId && "bg-accent",
            dragId === note.noteId && "opacity-50",
          )}
        >
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{note.title}</span>
          {labels && labels.names.length > 0 && (
            <span
              className="ml-auto max-w-[45%] shrink-0 truncate pl-2 text-[11px] text-muted-foreground"
              title={labels.names.join(", ")}
            >
              {labels.names.join(", ")}
              {labels.more > 0 ? ` +${labels.more}` : ""}
            </span>
          )}
        </button>
      </ItemMenu>
    )
  }

  const notebookRows = (
    nodes: readonly NotebookNode[],
    depth: number,
    scope: "main" | "without",
  ): React.ReactNode =>
    nodes.map((node) => {
      const foldKey = `${scope === "main" ? "notebook" : "notebook-ns"}:${node.key}`
      const open = !collapsed[foldKey]
      const muted = node.count === 0
      const hot = dropKey === `${scope}:${node.key}`
      const editable = scope === "main" && canWrite
      if (renaming === foldKey) {
        return (
          <InlineRename
            key={node.key}
            title={node.name}
            indent={treeIndent(depth) - 6}
            onCommit={(name) => {
              setRenaming(null)
              void actions.renameNotebook(node, name).catch((caught: unknown) => {
                actions.report(caught instanceof Error ? caught.message : String(caught))
              })
            }}
            onCancel={() => setRenaming(null)}
          />
        )
      }
      const row = (
        <div
          data-notebook={node.key}
          data-muted={muted ? "true" : undefined}
          {...dropTarget(`${scope}:${node.key}`, node.segments)}
          className={cn(
            "amby-tree-row group flex items-center gap-1.5 rounded border-y-2 border-transparent py-0 pr-1 text-[13px] hover:bg-accent",
            hot && "bg-primary/10 ring-1 ring-primary/50",
          )}
          style={{ paddingLeft: treeIndent(depth) }}
        >
          <button
            type="button"
            aria-expanded={open}
            onClick={() => onToggle(foldKey)}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              muted && "text-muted-foreground",
            )}
          >
            <motion.span
              className="flex size-3 shrink-0 items-center justify-center text-muted-foreground"
              initial={false}
              animate={{ rotate: open ? 90 : 0 }}
              transition={motionTransitions.default}
            >
              <ChevronRight className="size-3" />
            </motion.span>
            <Folder className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{node.name}</span>
            <span
              className={cn(
                "shrink-0 text-[11px] tabular-nums text-muted-foreground",
                muted && "opacity-60",
              )}
            >
              {node.count}
            </span>
          </button>
          {editable && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-5 text-muted-foreground opacity-50 hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
              title={t("creative.notebooks.addNoteHere")}
              aria-label={t("creative.notebooks.addNoteHereNamed", { name: node.name })}
              onClick={() => onAddNote(node.segments)}
            >
              <Plus className="size-3.5" />
            </Button>
          )}
        </div>
      )
      return (
        <React.Fragment key={node.key}>
          {editable ? (
            <ContextMenu>
              <ContextMenuTrigger
                asChild
                onContextMenu={(event: React.MouseEvent) => event.stopPropagation()}
              >
                {row}
              </ContextMenuTrigger>
              <ContextMenuContent className="w-60 border-border bg-popover text-foreground">
                <ContextMenuItem
                  className="gap-2 text-[13px]"
                  onSelect={() => onAddNote(node.segments)}
                >
                  <FileText className="size-3.5 text-muted-foreground" />
                  {t("creative.notebooks.addNoteHere")}
                </ContextMenuItem>
                <ContextMenuItem
                  className="gap-2 text-[13px]"
                  onSelect={() => onAddNotebook(node.segments)}
                >
                  <FolderPlus className="size-3.5 text-muted-foreground" />
                  {t("creative.notebooks.addInside")}
                </ContextMenuItem>
                <ContextMenuItem
                  className="gap-2 text-[13px]"
                  // The menu has to close before the field takes the focus.
                  onSelect={() => window.setTimeout(() => setRenaming(foldKey), 80)}
                >
                  <Pencil className="size-3.5 text-muted-foreground" />
                  {t("creative.notebooks.rename")}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  className="gap-2 text-[13px] text-destructive focus:text-destructive"
                  onSelect={() =>
                    void actions.deleteNotebook(node).catch((caught: unknown) => {
                      actions.report(caught instanceof Error ? caught.message : String(caught))
                    })
                  }
                >
                  <Trash2 className="size-3.5" />
                  {t("creative.notebooks.delete")}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ) : (
            row
          )}
          {open && (
            <>
              {scope === "main" && noteDraftIn(node.segments) && (
                <InlineCreateRow
                  depth={depth}
                  icon={<FileText className="size-3.5" />}
                  placeholder={t("creative.workshop.newNotePlaceholder")}
                  onSubmit={onCommitDraft}
                  onCancel={onCancelDraft}
                />
              )}
              {scope === "main" && notebookDraftIn(node.segments) && (
                <InlineCreateRow
                  depth={depth}
                  icon={<Folder className="size-3.5" />}
                  placeholder={t("creative.notebooks.newPlaceholder")}
                  onSubmit={onCommitDraft}
                  onCancel={onCancelDraft}
                />
              )}
              {notebookRows(node.children, depth + 1, scope)}
              {node.notes.map((note) => noteRow(note, depth + 1))}
            </>
          )}
        </React.Fragment>
      )
    })

  const rootHeader = (
    scope: "main" | "without",
    count: number,
    asTarget: boolean,
  ): React.ReactNode => (
    <h4
      data-notebook-root={scope}
      {...(asTarget ? dropTarget(`${scope}:${ROOT}`, null) : {})}
      className={cn(
        "flex items-center gap-1.5 rounded pb-0.5 pr-3 pt-1 text-[11px] text-muted-foreground",
        asTarget && dropKey === `${scope}:${ROOT}` && "bg-primary/10 ring-1 ring-primary/50",
        count === 0 && "opacity-60",
      )}
      style={{ paddingLeft: treeIndent(1) }}
    >
      <span className="truncate">{t("creative.notebooks.root")}</span>
      <span className="opacity-60">{count}</span>
    </h4>
  )

  const hasNotebooks = tree.nodes.length > 0
  const rootNoteDraft = noteDraftIn([])
  const rootNotebookDraft = notebookDraftIn([])
  const nothingHere =
    !hasNotebooks &&
    tree.rootNotes.length === 0 &&
    !rootNoteDraft &&
    !rootNotebookDraft &&
    (withoutStory?.count ?? 0) === 0
  const noNotes = t("creative.workshop.noNotesYet")

  return (
    <>
      {link && (
        <LinkAction
          label={t("creative.workshop.link.stories")}
          title={t("creative.workshop.link.storiesHint")}
          pending={link.pending}
          onClick={link.onLink}
        />
      )}
      {link?.error && (
        <p role="alert" className="px-2 py-1 text-[11px] text-destructive">
          {link.error}
        </p>
      )}
      {actions.error && (
        <div
          role="alert"
          className="flex items-start gap-1 py-1 pr-2 text-[11px] text-destructive"
          style={{ paddingLeft: treeIndent(1) }}
        >
          <span className="min-w-0 flex-1 break-words">{actions.error}</span>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 hover:bg-accent"
            aria-label={t("creative.notebooks.dismiss")}
            onClick={actions.clearError}
          >
            <X className="size-3" />
          </button>
        </div>
      )}
      {nothingHere &&
        !loading &&
        (canWrite ? (
          <EmptyAction label={t("creative.workshop.addFirstNote")} onClick={() => onAddNote([])} />
        ) : (
          <p
            className="py-1 pr-3 text-xs text-muted-foreground"
            style={{ paddingLeft: treeIndent(1) }}
          >
            {noNotes}
          </p>
        ))}
      {rootNotebookDraft && (
        <InlineCreateRow
          depth={0}
          icon={<Folder className="size-3.5" />}
          placeholder={t("creative.notebooks.newPlaceholder")}
          onSubmit={onCommitDraft}
          onCancel={onCancelDraft}
        />
      )}
      {notebookRows(tree.nodes, 1, "main")}
      {(hasNotebooks || tree.rootNotes.length > 0) &&
        (hasNotebooks ? rootHeader("main", tree.rootNotes.length, true) : null)}
      {rootNoteDraft && (
        <InlineCreateRow
          depth={0}
          icon={<FileText className="size-3.5" />}
          placeholder={t("creative.workshop.newNotePlaceholder")}
          onSubmit={onCommitDraft}
          onCancel={onCancelDraft}
        />
      )}
      {tree.rootNotes.map((note) => noteRow(note, 1))}
      {withoutStory && withoutStory.count > 0 && (
        <div data-testid="notes-without-story">
          <h4
            className="flex items-center gap-1.5 pb-0.5 pr-3 pt-2 text-[11px] text-muted-foreground"
            style={{ paddingLeft: treeIndent(1) }}
          >
            <span className="truncate">{t("creative.workshop.noStory")}</span>
            <span className="opacity-60">{withoutStory.count}</span>
          </h4>
          {notebookRows(withoutStory.nodes, 1, "without")}
          {withoutStory.nodes.length > 0 &&
            withoutStory.rootNotes.length > 0 &&
            rootHeader("without", withoutStory.rootNotes.length, false)}
          {withoutStory.rootNotes.map((note) => noteRow(note, 1))}
        </div>
      )}
      {canWrite && (
        <button
          type="button"
          onClick={() => onAddNotebook([])}
          style={{ paddingLeft: treeIndent(1) }}
          className="amby-tree-row flex w-full items-center gap-1.5 rounded py-1 pr-3 text-left text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <FolderPlus aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{t("creative.notebooks.add")}</span>
        </button>
      )}
    </>
  )
}
