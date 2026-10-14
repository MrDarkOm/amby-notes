import { BookOpen, ExternalLink, Feather, Globe2, Play, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { AmbySelect } from "@/components/ui/amby-select"
import { Button } from "@/components/ui/button"
import type { StorySummary, WorkshopSummary } from "@/lib/storage"
import { IconValue } from "../../icon-value"

interface UniverseItem {
  noteId: string
  title: string
}

interface StoryHeaderProps {
  workshop: WorkshopSummary
  /** Every story of the workshop. */
  stories: StorySummary[]
  selectedStoryId: string | null
  universes?: UniverseItem[]
  selectedUniverseId?: string | null
  /** Pages of the text, or `null` while they are not loaded (nothing is shown, not "0"). */
  pages: number | null
  /** Words of the text, or `null` while they are not loaded. */
  words: number | null
  onSelectStory: (storyId: string | null) => void
  onSelectUniverse?: (universeId: string | null) => void
  onNewStory: () => void
  onOpenTarget: () => void
  /** The page of the text changed last, offered as the place to go on from; none hides the row. */
  resume?: { noteId: string; title: string; when: string } | null
  onOpenNote?: (noteId: string) => void
}

/**
 * The top of the panel: header with "Вся мастерская", stories, and universes.
 */
export function StoryHeader({
  workshop,
  stories,
  selectedStoryId,
  universes = [],
  selectedUniverseId = null,
  pages,
  words,
  onSelectStory,
  onSelectUniverse,
  onNewStory,
  onOpenTarget,
  resume = null,
  onOpenNote,
}: StoryHeaderProps) {
  const { t } = useTranslation()

  const selectedStory = selectedStoryId
    ? (stories.find((s) => s.storyId === selectedStoryId) ?? null)
    : null
  const selectedUniverse = selectedUniverseId
    ? (universes.find((u) => u.noteId === selectedUniverseId) ?? null)
    : null

  let currentValue = "all"
  if (selectedUniverse) {
    currentValue = `universe:${selectedUniverse.noteId}`
  } else if (selectedStory) {
    currentValue = `story:${selectedStory.storyId}`
  }

  const meta = selectedStory
    ? [
        pages === null ? null : t("creative.workshop.pagesShort", { count: pages }),
        words === null ? null : t("docEditor.wordCount", { count: words }),
      ]
        .filter(Boolean)
        .join(" · ")
    : null

  const face = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {selectedStory ? (
          <BookOpen className="size-5" />
        ) : selectedUniverse ? (
          <Globe2 className="size-5" />
        ) : (
          <IconValue
            value={workshop.icon ?? undefined}
            fallback={<Feather className="size-5" />}
            className="size-5"
          />
        )}
      </span>
      <span className="ml-2.5 min-w-0 flex-1 text-left leading-tight">
        <span className="block truncate text-sm font-medium">
          {selectedStory
            ? selectedStory.name
            : selectedUniverse
              ? selectedUniverse.title
              : workshop.name}
        </span>
        {selectedStory ? (
          meta ? (
            <span className="block truncate text-[11px] text-muted-foreground">{meta}</span>
          ) : null
        ) : (
          <span className="block truncate text-[11px] text-muted-foreground">
            {selectedUniverse
              ? t("creative.kind.universe", "Вселенная")
              : t("creative.workshop.all", "Вся мастерская")}
          </span>
        )}
      </span>
    </>
  )

  const options = [
    { value: "all", label: t("creative.workshop.all", "Вся мастерская") },
    ...stories.map((story) => ({
      value: `story:${story.storyId}`,
      label: story.name,
    })),
    ...universes.map((univ) => ({
      value: `universe:${univ.noteId}`,
      label: univ.title,
    })),
  ]

  const handleValueChange = (val: string) => {
    if (val === "all") {
      onSelectUniverse?.(null)
      onSelectStory(null)
    } else if (val.startsWith("story:")) {
      onSelectUniverse?.(null)
      onSelectStory(val.slice("story:".length))
    } else if (val.startsWith("universe:")) {
      onSelectStory(null)
      onSelectUniverse?.(val.slice("universe:".length))
    }
  }

  return (
    <div className="shrink-0 px-3 pb-2">
      <div className="flex items-center gap-1 rounded-lg bg-accent/40 p-1">
        <div className="min-w-0 flex-1">
          <AmbySelect
            aria-label={t("creative.workshop.chooseStory", "Выбрать историю")}
            value={currentValue}
            onValueChange={handleValueChange}
            options={options}
            variant="bare"
            className="h-auto py-1"
            title={
              selectedStory?.name ??
              selectedUniverse?.title ??
              t("creative.workshop.all", "Вся мастерская")
            }
            renderValue={() => face}
            action={{
              label: t("creative.panel.newStory", "Новая история"),
              icon: <Plus className="size-4" />,
              onSelect: onNewStory,
            }}
          />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground"
          title={t("creative.workshop.openStory", "Открыть")}
          aria-label={t("creative.workshop.openStory", "Открыть")}
          onClick={onOpenTarget}
        >
          <ExternalLink className="size-4" />
        </Button>
      </div>
      {resume && onOpenNote && selectedStory && (
        <button
          type="button"
          onClick={() => onOpenNote(resume.noteId)}
          className="mt-1.5 flex w-full items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5 text-left text-xs hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Play aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate">
            {t("creative.workshop.resume", { name: resume.title })}
          </span>
          {resume.when && (
            <span className="shrink-0 text-[10px] text-muted-foreground">{resume.when}</span>
          )}
        </button>
      )}
    </div>
  )
}
