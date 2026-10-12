import { ExternalLink, Play, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { AmbySelect } from "@/components/ui/amby-select"
import { Button } from "@/components/ui/button"
import type { ProjectSummary } from "@/lib/storage"
import { IconValue } from "../../icon-value"
import { projectFallbackIcon } from "../section-icons"

interface StoryHeaderProps {
  story: ProjectSummary
  /** Every story of the scope: the list the header opens. */
  stories: ProjectSummary[]
  /** Pages of the text, or `null` while they are not loaded (nothing is shown, not "0"). */
  pages: number | null
  /** Words of the text, or `null` while they are not loaded. */
  words: number | null
  onSelectStory: (storyId: string) => void
  onNewStory: () => void
  onOpenStory: (storyId: string) => void
  /** The page of the text changed last, offered as the place to go on from; none hides the row. */
  resume?: { noteId: string; title: string; when: string } | null
  onOpenNote?: (noteId: string) => void
}

/**
 * The top of the panel: the chosen story with its icon, its name and one quiet line under it (its
 * label, pages, words). It always opens the list of the scope's stories, even of one, because
 * "New story" is the last item of that list. Under it stands the page to go on from.
 */
export function StoryHeader({
  story,
  stories,
  pages,
  words,
  onSelectStory,
  onNewStory,
  onOpenStory,
  resume = null,
  onOpenNote,
}: StoryHeaderProps) {
  const { t } = useTranslation()
  const Fallback = projectFallbackIcon(story)
  const meta = [
    story.tags[0] ?? null,
    pages === null ? null : t("creative.workshop.pagesShort", { count: pages }),
    words === null ? null : t("docEditor.wordCount", { count: words }),
  ]
    .filter(Boolean)
    .join(" · ")

  const face = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <IconValue
          value={story.icon ?? undefined}
          fallback={<Fallback className="size-5" />}
          className="size-5"
        />
      </span>
      <span className="ml-2.5 min-w-0 flex-1 text-left leading-tight">
        <span className="block truncate text-sm font-medium">{story.name}</span>
        {meta && <span className="block truncate text-[11px] text-muted-foreground">{meta}</span>}
      </span>
    </>
  )

  return (
    <div className="shrink-0 px-3 pb-2">
      <div className="flex items-center gap-1 rounded-lg bg-accent/40 p-1">
        <div className="min-w-0 flex-1">
          <AmbySelect
            aria-label={t("creative.workshop.chooseStory")}
            value={story.projectId}
            onValueChange={onSelectStory}
            options={stories.map((entry) => ({ value: entry.projectId, label: entry.name }))}
            variant="bare"
            className="h-auto py-1"
            title={story.name}
            renderValue={() => face}
            action={{
              label: t("creative.panel.newStory"),
              icon: <Plus className="size-4" />,
              onSelect: onNewStory,
            }}
          />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground"
          title={t("creative.workshop.openStory")}
          aria-label={t("creative.workshop.openStory")}
          onClick={() => onOpenStory(story.projectId)}
        >
          <ExternalLink className="size-4" />
        </Button>
      </div>
      {resume && onOpenNote && (
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
