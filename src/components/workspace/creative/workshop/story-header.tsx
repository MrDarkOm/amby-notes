import { BookOpen, Globe2, Library, Play, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { StorySummary } from "@/lib/storage"
import { ScopeBar, type ScopeSegment } from "./scope-bar"
import type { UniverseItem } from "./workshop-model"

const ALL = "all"
/** The universe list's own first item: what no universe holds. It is never a universe's ID. */
const STANDALONE = "standalone"

/** The universes the bar chooses among: the card that used to stand under "Create". */
export interface UniverseSwitch {
  universes: UniverseItem[]
  /** The universe chosen, or `null` for the standalone stories. */
  selectedUniverseId: string | null
  onSelectUniverse: (universeId: string | null) => void
  /** Starts making a universe; `null` when the workshop cannot be written to. */
  onNewUniverse: (() => void) | null
}

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
  /** What the open button leads to: the page of the story, of the universe or of the standalone stories. */
  openTarget: "story" | "universe" | "standalone"
  onOpenTarget: () => void
  /** The page of the text changed last, offered as the place to go on from; none hides the row. */
  resume?: { noteId: string; title: string; when: string } | null
  onOpenNote?: (noteId: string) => void
  /** The universe the stories are looked at in; none leaves the story alone in the bar. */
  universe?: UniverseSwitch | null
  /** Opens the page of the universe, or of the standalone stories: the story's own button is `onOpenTarget`. */
  onOpenScope?: () => void
}

/**
 * The top of the panel, one bar: universe › story. The story is one of those in the scope of the
 * universe, or "All stories", and its list ends with "New story".
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
  universe = null,
  onOpenScope,
}: StoryHeaderProps) {
  const { t } = useTranslation()

  const selected = selectedStoryId
    ? (stories.find((story) => story.storyId === selectedStoryId) ?? null)
    : null

  const meta = selected
    ? [
        // An empty story shows no numbers: "0 pages" reads as a fault.
        pages ? t("creative.workshop.pagesShort", { count: pages }) : null,
        words ? t("docEditor.wordCount", { count: words }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : stories.length > 0
      ? t("creative.workshop.storiesCount", { count: stories.length })
      : ""

  const options = [
    {
      value: ALL,
      label: t("creative.workshop.allStories"),
      hint: selected ? undefined : meta || undefined,
    },
    ...stories.map((story) => ({
      value: story.storyId,
      label: story.name,
      hint: story.storyId === selectedStoryId ? meta || undefined : undefined,
    })),
  ]
  const openLabel =
    openTarget === "story"
      ? t("creative.workshop.openStory")
      : openTarget === "universe"
        ? t("creative.workshop.openUniverse")
        : t("creative.workshop.openStandalone")

  const untitled = t("creative.workshop.untitled")
  const selectedUniverse = universe?.selectedUniverseId
    ? (universe.universes.find((item) => item.noteId === universe.selectedUniverseId) ?? null)
    : null
  const universeSegment: ScopeSegment | null = universe
    ? {
        ariaLabel: t("creative.workshop.chooseUniverse"),
        icon: selectedUniverse ? <Globe2 /> : <Library />,
        name: selectedUniverse
          ? selectedUniverse.title || untitled
          : t("creative.workshop.standalone"),
        value: selectedUniverse ? selectedUniverse.noteId : STANDALONE,
        options: [
          { value: STANDALONE, label: t("creative.workshop.standalone") },
          ...universe.universes.map((item) => ({
            value: item.noteId,
            label: item.title || untitled,
          })),
        ],
        onValueChange: (value) => universe.onSelectUniverse(value === STANDALONE ? null : value),
        action: universe.onNewUniverse
          ? {
              label: t("creative.panel.newUniverse"),
              icon: <Plus className="size-4" />,
              onSelect: universe.onNewUniverse,
            }
          : undefined,
        open: onOpenScope
          ? {
              label: selectedUniverse
                ? t("creative.workshop.openUniverse")
                : t("creative.workshop.openStandalone"),
              onOpen: onOpenScope,
            }
          : undefined,
      }
    : null

  // With no story in the scope there is nothing to choose: the bar offers the first one.
  if (stories.length === 0) {
    return (
      <div className="shrink-0 px-3 pb-2">
        <ScopeBar
          universe={universeSegment}
          story={null}
          prompt={{ name: t("creative.workshop.createFirstStory"), onClick: onNewStory }}
        />
      </div>
    )
  }

  const resumeRow =
    resume && onOpenNote && selected ? (
      <button
        type="button"
        onClick={() => onOpenNote(resume.noteId)}
        title={t("creative.workshop.resume", { name: resume.title })}
        aria-label={t("creative.workshop.resume", { name: resume.title })}
        className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Play aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 break-words">{resume.title}</span>
        {resume.when && (
          <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
            {resume.when}
          </span>
        )}
      </button>
    ) : null

  return (
    <div className="shrink-0 px-3 pb-2">
      <ScopeBar
        universe={universeSegment}
        story={{
          ariaLabel: t("creative.workshop.chooseStory"),
          icon: <BookOpen />,
          name: selected ? selected.name : t("creative.workshop.allStories"),
          meta: meta || null,
          value: selected ? selected.storyId : ALL,
          // With no story chosen the universe's own button already leads where this would.
          open: selected ? { label: openLabel, onOpen: onOpenTarget } : undefined,
          options,
          onValueChange: (value) => onSelectStory(value === ALL ? null : value),
          action: {
            label: t("creative.panel.newStory"),
            icon: <Plus className="size-4" />,
            onSelect: onNewStory,
          },
        }}
        footer={resumeRow}
      />
    </div>
  )
}
