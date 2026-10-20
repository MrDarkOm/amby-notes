import { BookOpen, Star } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { formatModified } from "../../workspace-tree-utils"
import { progressOf, type StoryEntry } from "./story-list-model"

interface StoryCardProps {
  entry: StoryEntry
  onOpen: (storyId: string) => void
  /** Stars or unstars the story's main note by ID: the same favorite as Amby's Favorites panel. */
  onToggleFavorite: (cardNoteId: string) => void
}

/**
 * A story as a tile: its cover, name and world, how far it is, the words and the last change.
 * The star is a button of its own beside the clickable card, never inside it.
 */
export function StoryCard({ entry, onOpen, onToggleFavorite }: StoryCardProps) {
  const { t } = useTranslation()
  const cardNoteId = entry.cardNoteId
  const progress = Math.round(progressOf(entry) * 100)
  const favoriteLabel = entry.favorite
    ? t("creative.storyCard.unfavorite")
    : t("creative.storyCard.favorite")
  const readiness = entry.finished
    ? null
    : entry.donePages !== null
      ? t("creative.page.desk.doneOf", { done: entry.donePages, total: entry.pages })
      : t("creative.workshop.pagesShort", { count: entry.pages })
  return (
    <div className="relative rounded-2xl border border-border bg-card hover:border-primary/40">
      <button
        type="button"
        onClick={() => onOpen(entry.storyId)}
        className="flex w-full flex-col gap-3.5 rounded-2xl p-4 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-3 pr-9">
          <span
            aria-hidden="true"
            className={cn(
              "flex h-14 w-11 shrink-0 items-center justify-center rounded-md",
              entry.finished
                ? "bg-teal-500/15 text-teal-700 dark:text-teal-400"
                : "bg-primary/10 text-primary",
            )}
          >
            <BookOpen className="size-5" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="break-words text-base font-semibold leading-snug">{entry.name}</span>
            <span className="break-words text-xs text-muted-foreground">
              {entry.universeName ?? t("creative.storyCard.standalone")}
            </span>
          </span>
        </span>
        <span className="flex flex-col gap-1.5">
          <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            {entry.finished ? (
              <span className="rounded-full bg-teal-500/15 px-2 py-0.5 font-semibold text-teal-700 dark:text-teal-400">
                {t("creative.storyCard.finished")}
              </span>
            ) : (
              <span>{readiness}</span>
            )}
            <span className="tabular-nums">{t("docEditor.wordCount", { count: entry.words })}</span>
          </span>
          <span
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label={t("creative.storyCard.progress")}
            className="block h-1.5 w-full overflow-hidden rounded-full bg-accent"
          >
            <span
              className={cn(
                "block h-full rounded-full",
                entry.finished ? "bg-teal-500" : "bg-primary",
              )}
              style={{ width: `${Math.max(progress, 2)}%` }}
            />
          </span>
        </span>
        {entry.lastModified !== null && (
          <span className="text-xs text-muted-foreground">
            {t("creative.storyCard.edited", { when: formatModified(entry.lastModified) })}
          </span>
        )}
      </button>
      {cardNoteId && (
        <button
          type="button"
          aria-pressed={entry.favorite}
          aria-label={favoriteLabel}
          title={favoriteLabel}
          onClick={() => onToggleFavorite(cardNoteId)}
          className={cn(
            "absolute right-2.5 top-2.5 flex size-8 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring",
            entry.favorite ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground",
          )}
        >
          <Star className={cn("size-[18px]", entry.favorite && "fill-current")} />
        </button>
      )}
    </div>
  )
}
