import * as React from "react"
import { useTranslation } from "react-i18next"
import type { DatabaseRow, Notebook } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { formatModified } from "../../workspace-tree-utils"
import { projectErrorText } from "../project-error"
import { QuickCreate } from "../workshop/quick-create"
import type { StoryLabels } from "../workshop/workshop-model"
import {
  ALL_NOTES,
  buildNoteTabs,
  newestNotesFirst,
  notebookForNewNote,
  notebookLabel,
  notesInTab,
} from "./notes-board-model"

interface NotesBoardProps {
  /** The rows of the notes base; `undefined` while they are being read. */
  notes: readonly DatabaseRow[] | undefined
  notebooks: readonly Notebook[]
  /** Seconds since the epoch of a note's last change, when the index knows it. */
  modifiedOf: (noteId: string) => number | null | undefined
  storyLabelsOf?: (noteId: string) => StoryLabels
  onOpenNote: (noteId: string) => void
  /** Makes a note under a typed name in a notebook; `null` where the base cannot be written. */
  onCreate: ((title: string, notebook: string[] | undefined) => Promise<void>) | null
  /**
   * Inside a widget of the desk, which has its own header: no heading, the notes as a plain list
   * of rows, the tabs as small pills.
   */
  embedded?: boolean
}

/**
 * The notes of the notes base as small cards under tabs that are its notebooks: every note, each
 * top-level notebook, and the notes in none. A note is made in the notebook of the tab shown.
 */
export function NotesBoard({
  notes,
  notebooks,
  modifiedOf,
  storyLabelsOf,
  onOpenNote,
  onCreate,
  embedded = false,
}: NotesBoardProps) {
  const { t } = useTranslation()
  const [selected, setSelected] = React.useState(ALL_NOTES)
  const rows = React.useMemo(() => notes ?? [], [notes])
  const tabs = React.useMemo(() => buildNoteTabs(rows, notebooks), [rows, notebooks])
  const tab = tabs.find((candidate) => candidate.key === selected) ?? tabs[0]
  const shown = React.useMemo(
    () => newestNotesFirst(notesInTab(rows, tab), modifiedOf),
    [modifiedOf, rows, tab],
  )
  const tabLabel = (item: (typeof tabs)[number]) =>
    item.kind === "all"
      ? t("creative.notesBoard.all")
      : item.kind === "none"
        ? t("creative.notesBoard.noNotebook")
        : (item.name ?? "")
  return (
    <section
      aria-label={embedded ? undefined : t("creative.notesBoard.title")}
      className="flex flex-col gap-2.5"
    >
      <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1", embedded && "order-last")}>
        {!embedded && <h2 className="text-lg font-semibold">{t("creative.notesBoard.title")}</h2>}
        {onCreate && (
          <div className="ml-auto">
            <QuickCreate
              label={t("creative.notesBoard.add")}
              placeholder={t("creative.notesBoard.placeholder")}
              failed={(message) => t("creative.workshop.createFailed", { message })}
              onCreate={(title) => onCreate(title, notebookForNewNote(tab))}
              describe={(caught) => projectErrorText(t, caught)}
            />
          </div>
        )}
      </div>
      <div
        role="tablist"
        aria-label={t("creative.notesBoard.notebooks")}
        className={cn("flex flex-wrap gap-0.5", !embedded && "border-b border-border")}
      >
        {tabs.map((item) => {
          const active = item.key === tab?.key
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSelected(item.key)}
              className={cn(
                "inline-flex items-center gap-1.5 outline-none focus-visible:ring-1 focus-visible:ring-ring",
                embedded
                  ? "h-7 rounded-md px-2.5 text-[13px]"
                  : "-mb-px h-9 border-b-2 px-3 text-sm",
                embedded
                  ? active
                    ? "bg-accent font-semibold text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  : active
                    ? "border-primary font-semibold text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tabLabel(item)}
              <span className="text-xs tabular-nums text-muted-foreground">{item.count}</span>
            </button>
          )
        })}
      </div>
      {notes !== undefined && shown.length === 0 && (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {t("creative.notesBoard.empty")}
        </p>
      )}
      <ul
        className={cn(
          "grid gap-3",
          embedded
            ? "grid-cols-1 gap-1"
            : "grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))]",
        )}
      >
        {shown.map((row) => {
          const labels = storyLabelsOf?.(row.noteId)
          const modified = modifiedOf(row.noteId)
          const meta = [
            notebookLabel(row),
            labels && labels.names.length > 0
              ? `${labels.names.join(", ")}${labels.more > 0 ? ` +${labels.more}` : ""}`
              : null,
            modified ? formatModified(modified) : null,
          ]
            .filter(Boolean)
            .join(" · ")
          return (
            <li key={row.noteId} className="min-w-0">
              <button
                type="button"
                onClick={() => onOpenNote(row.noteId)}
                className={cn(
                  "flex w-full flex-col items-start text-left outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  embedded
                    ? "gap-0.5 rounded-md px-1.5 py-1 hover:bg-accent"
                    : "h-full min-h-20 gap-1.5 rounded-xl border border-border bg-card px-4 py-3 hover:border-primary/40 hover:bg-accent/30",
                )}
              >
                <span
                  className={cn("break-words text-sm", embedded ? "font-medium" : "font-semibold")}
                >
                  {row.title}
                </span>
                {meta && (
                  <span
                    className={cn(
                      "break-words text-xs text-muted-foreground",
                      !embedded && "mt-auto",
                    )}
                  >
                    {meta}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
