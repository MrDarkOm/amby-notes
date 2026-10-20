import * as React from "react"
import { ChevronLeft, ChevronRight, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { progressOf, type StoryEntry } from "./story-list-model"

interface StoryTimelineProps {
  /** The stories in the author's order, left to right. */
  entries: readonly StoryEntry[]
  onOpen: (storyId: string) => void
  /** Moves a story to a place in the order (the index among `entries`). `null`: no reordering. */
  onMove: ((storyId: string, to: number) => void) | null
  onNewStory: (() => void) | null
  /** Why the last move was not kept; shown under the line. */
  error?: string | null
}

/**
 * The stories of a universe left to right in the order the author placed them, each a small card
 * hung on a line with a dot. The box scrolls sideways on a narrow window, the page does not. A
 * card is moved by dragging it onto another place or by the two arrows under it, so the order can
 * be changed from the keyboard too.
 */
export function StoryTimeline({ entries, onOpen, onMove, onNewStory, error }: StoryTimelineProps) {
  const { t } = useTranslation()
  const [dragging, setDragging] = React.useState<string | null>(null)
  const [over, setOver] = React.useState<number | null>(null)
  const endDrag = () => {
    setDragging(null)
    setOver(null)
  }
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border p-4">
      <div className="max-w-full overflow-x-auto pb-1">
        <ol className="flex min-w-max gap-4">
          {entries.map((entry, index) => {
            const progress = Math.round(progressOf(entry) * 100)
            const movable = onMove !== null && entry.cardNoteId !== null
            return (
              <li
                key={entry.storyId}
                draggable={movable}
                onDragStart={(event) => {
                  if (!movable) return
                  setDragging(entry.storyId)
                  event.dataTransfer?.setData("text/plain", entry.storyId)
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
                }}
                onDragOver={(event) => {
                  if (dragging === null || !onMove) return
                  event.preventDefault()
                  setOver(index)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (dragging !== null && onMove) onMove(dragging, index)
                  endDrag()
                }}
                onDragEnd={endDrag}
                className={cn(
                  "flex w-52 shrink-0 flex-col gap-2.5 rounded-xl",
                  dragging === entry.storyId && "opacity-50",
                  over === index && dragging !== entry.storyId && "ring-1 ring-primary",
                )}
              >
                <div aria-hidden="true" className="flex items-center gap-2">
                  <span
                    className={cn(
                      "size-3 shrink-0 rounded-full",
                      entry.finished ? "bg-teal-500" : "bg-primary",
                    )}
                  />
                  <span className="h-0.5 flex-1 bg-border" />
                </div>
                <button
                  type="button"
                  onClick={() => onOpen(entry.storyId)}
                  className="flex flex-col gap-2 rounded-xl border border-border bg-card px-3.5 py-3 text-left outline-none hover:border-primary/40 focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <span className="break-words text-sm font-semibold leading-snug">
                    {entry.name}
                  </span>
                  <span
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress}
                    aria-label={t("creative.storyCard.progress")}
                    className="block h-1 w-full overflow-hidden rounded-full bg-accent"
                  >
                    <span
                      className={cn(
                        "block h-full rounded-full",
                        entry.finished ? "bg-teal-500" : "bg-primary",
                      )}
                      style={{ width: `${Math.max(progress, 2)}%` }}
                    />
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {[
                      entry.finished
                        ? t("creative.storyCard.finished")
                        : entry.donePages !== null
                          ? t("creative.page.desk.doneOf", {
                              done: entry.donePages,
                              total: entry.pages,
                            })
                          : t("creative.workshop.pagesShort", { count: entry.pages }),
                      t("docEditor.wordCount", { count: entry.words }),
                    ].join(" · ")}
                  </span>
                </button>
                {movable && (
                  <div className="flex gap-1">
                    <button
                      type="button"
                      disabled={index === 0}
                      aria-label={t("creative.timeline.earlier", { name: entry.name })}
                      title={t("creative.timeline.earlier", { name: entry.name })}
                      onClick={() => onMove(entry.storyId, index - 1)}
                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
                    >
                      <ChevronLeft className="size-4" />
                    </button>
                    <button
                      type="button"
                      disabled={index === entries.length - 1}
                      aria-label={t("creative.timeline.later", { name: entry.name })}
                      title={t("creative.timeline.later", { name: entry.name })}
                      onClick={() => onMove(entry.storyId, index + 1)}
                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
                    >
                      <ChevronRight className="size-4" />
                    </button>
                  </div>
                )}
              </li>
            )
          })}
          {onNewStory && (
            <li className="flex w-32 shrink-0 flex-col gap-2.5">
              <div aria-hidden="true" className="flex h-3 items-center">
                <span className="flex-1 border-t-2 border-dashed border-border" />
              </div>
              <button
                type="button"
                onClick={onNewStory}
                className="flex min-h-[4.5rem] flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border text-xs text-muted-foreground outline-none hover:border-primary/40 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Plus className="size-4" />
                {t("creative.timeline.newStory")}
              </button>
            </li>
          )}
        </ol>
      </div>
      {error && (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      )}
      {onMove && <p className="text-xs text-muted-foreground">{t("creative.timeline.hint")}</p>}
    </div>
  )
}
