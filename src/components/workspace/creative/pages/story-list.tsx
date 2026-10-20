import type * as React from "react"
import { Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { AmbySelect } from "@/components/ui/amby-select"
import { cn } from "@/lib/utils"
import { StoryCard } from "./story-card"
import {
  STORY_FILTERS,
  PLAIN_STORY_SORTS,
  filterAndSort,
  filterCounts,
  type StoryEntry,
  type StoryFilter,
  type StoryOrderInput,
  type StorySort,
  type WorldFilter,
} from "./story-list-model"

export interface StoryListWorld {
  id: string
  name: string
}

interface StoryListProps {
  entries: readonly StoryEntry[]
  filter: StoryFilter
  sort: StorySort
  onFilterChange: (filter: StoryFilter) => void
  onSortChange: (sort: StorySort) => void
  /** The universes to choose among; the "World" choice is offered only when there are some. */
  worlds?: readonly StoryListWorld[]
  world?: WorldFilter
  onWorldChange?: (world: WorldFilter) => void
  onOpen: (storyId: string) => void
  /** Stars or unstars a story's main note by its ID (the key of Amby's favorites). */
  onToggleFavorite: (cardNoteId: string) => void
  /** Starts a new story; `null` where the workshop cannot be written to. */
  onNewStory: (() => void) | null
  /** The sorts offered, in order; the plain ones unless the page also has "in order". */
  sorts?: readonly StorySort[]
  /** The author's order, for the sort "in order". */
  order?: StoryOrderInput
  /** Beside the heading: the switch between cards and the timeline on a universe's page. */
  leading?: React.ReactNode
  /** What to say when the list has no story at all. */
  emptyText?: string
}

/**
 * The stories as cards, with the filter (all, starred, in work, finished), the sort and, where
 * universes exist, the world. What is chosen is the page's to keep; the list only shows it.
 */
export function StoryList({
  entries,
  filter,
  sort,
  onFilterChange,
  onSortChange,
  worlds = [],
  world = "all",
  onWorldChange,
  onOpen,
  onToggleFavorite,
  onNewStory,
  sorts = PLAIN_STORY_SORTS,
  order,
  leading,
  emptyText,
}: StoryListProps) {
  const { t } = useTranslation()
  const counts = filterCounts(entries, world)
  const shown = filterAndSort(entries, { filter, sort, world, order })
  return (
    <section aria-label={t("creative.page.stories")} className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-lg font-semibold">{t("creative.page.stories")}</h2>
        {leading}
        <div
          role="group"
          aria-label={t("creative.storyList.filterLabel")}
          className="flex flex-wrap gap-1 rounded-lg bg-accent/60 p-0.5"
        >
          {STORY_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={filter === option}
              onClick={() => onFilterChange(option)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring",
                filter === option
                  ? "bg-background font-semibold text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`creative.storyList.filters.${option}`)}
              <span className="tabular-nums text-muted-foreground">{counts[option]}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
          {worlds.length > 0 && onWorldChange && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {t("creative.storyList.world")}
              <AmbySelect
                size="sm"
                className="w-40"
                value={world}
                aria-label={t("creative.storyList.world")}
                options={[
                  { value: "all", label: t("creative.storyList.allWorlds") },
                  { value: "standalone", label: t("creative.storyList.standaloneWorld") },
                  ...worlds.map((item) => ({ value: item.id, label: item.name })),
                ]}
                onValueChange={onWorldChange}
              />
            </div>
          )}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {t("creative.storyList.sort")}
            <AmbySelect
              size="sm"
              className="w-44"
              value={sort}
              aria-label={t("creative.storyList.sort")}
              options={sorts.map((option) => ({
                value: option,
                label: t(`creative.storyList.sorts.${option}`),
              }))}
              onValueChange={(next) => onSortChange(next as StorySort)}
            />
          </div>
        </div>
      </div>
      {entries.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {emptyText ?? t("creative.storyList.empty")}
        </p>
      )}
      {shown.length === 0 && entries.length > 0 && (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {t("creative.storyList.noMatch")}
        </p>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-3.5">
        {shown.map((entry) => (
          <StoryCard
            key={entry.storyId}
            entry={entry}
            onOpen={onOpen}
            onToggleFavorite={onToggleFavorite}
          />
        ))}
        {onNewStory && (
          <button
            type="button"
            onClick={onNewStory}
            className="flex min-h-36 flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border text-sm text-muted-foreground outline-none hover:border-primary/40 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Plus className="size-5" />
            {t("creative.panel.newStory")}
          </button>
        )}
      </div>
    </section>
  )
}
