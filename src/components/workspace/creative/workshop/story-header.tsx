import { BookOpen, Play, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { StorySummary } from "@/lib/storage"
import { ScopeCard, ScopePrompt } from "./scope-card"

const ALL = "all"

interface StoryHeaderProps {
  /** The stories in the scope of the universe chosen below (every story with none chosen). */
  stories: StorySummary[]
  /** The story chosen, or `null` for "All stories". */
  selectedStoryId: string | null
  /** Pages of the text, or `null` while they are not loaded (nothing is shown, not "0"). */
  pages: number | null
  /** Words of the text, or `null` while they are not loaded. */
  words: number | null
  onSelectStory: (storyId: string | null) => void
  onNewStory: () => void
  /** What the open button leads to: the page of the story, of the universe or of the workshop. */
  openTarget: "story" | "universe" | "workshop"
  onOpenTarget: () => void
  /** The page of the text changed last, offered as the place to go on from; none hides the row. */
  resume?: { noteId: string; title: string; when: string } | null
  onOpenNote?: (noteId: string) => void
}

/**
 * The top of the panel: the card of the stories. It chooses one story or "All stories" among
 * those in the scope of the universe, and ends its list with "New story".
 */
export function StoryHeader({
  stories,
  selectedStoryId,
  pages,
  words,
  onSelectStory,
  onNewStory,
  openTarget,
  onOpenTarget,
  resume = null,
  onOpenNote,
}: StoryHeaderProps) {
  const { t } = useTranslation()

  const selected = selectedStoryId
    ? (stories.find((story) => story.storyId === selectedStoryId) ?? null)
    : null

  const meta = selected
    ? [
        pages === null ? null : t("creative.workshop.pagesShort", { count: pages }),
        words === null ? null : t("docEditor.wordCount", { count: words }),
      ]
        .filter(Boolean)
        .join(" · ")
    : stories.length > 0
      ? t("creative.workshop.storiesCount", { count: stories.length })
      : ""

  const options = [
    { value: ALL, label: t("creative.workshop.allStories") },
    ...stories.map((story) => ({ value: story.storyId, label: story.name })),
  ]
  const openLabel =
    openTarget === "story"
      ? t("creative.workshop.openStory")
      : openTarget === "universe"
        ? t("creative.workshop.openUniverse")
        : t("creative.workshop.openWorkshop")

  // With no story in the scope there is nothing to choose: the card offers the first one.
  if (stories.length === 0) {
    return (
      <div className="shrink-0 px-3 pb-2">
        <ScopePrompt
          label={t("creative.workshop.storiesLabel")}
          icon={<Plus />}
          name={t("creative.workshop.createFirstStory")}
          onClick={onNewStory}
        />
      </div>
    )
  }

  return (
    <div className="shrink-0 px-3 pb-2">
      <ScopeCard
        label={t("creative.workshop.storiesLabel")}
        ariaLabel={t("creative.workshop.chooseStory")}
        icon={<BookOpen />}
        name={selected ? selected.name : t("creative.workshop.allStories")}
        meta={meta || null}
        value={selected ? selected.storyId : ALL}
        options={options}
        onValueChange={(value) => onSelectStory(value === ALL ? null : value)}
        action={{
          label: t("creative.panel.newStory"),
          icon: <Plus className="size-4" />,
          onSelect: onNewStory,
        }}
        openLabel={openLabel}
        onOpen={onOpenTarget}
      />
      {resume && onOpenNote && selected && (
        <button
          type="button"
          onClick={() => onOpenNote(resume.noteId)}
          className="mt-1.5 flex w-full items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5 text-left text-xs hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Play aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 break-words">
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
