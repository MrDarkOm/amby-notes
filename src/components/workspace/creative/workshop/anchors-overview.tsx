import { Anchor } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import type { DatabaseRow } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { EmptyAction } from "./empty-action"
import { InlineCreateRow } from "./inline-create-row"
import { treeIndent } from "./tree-indent"
import type { AnchorBuckets } from "./plot-views"
import type { StoryLabels, WorkshopDraft } from "./workshop-model"

interface AnchorsOverviewProps {
  /** `null` while the workshop has no anchors section. */
  buckets: AnchorBuckets<DatabaseRow> | null
  /** A universe is shown: its events come first under a heading of their own. */
  universe: boolean
  canWrite: boolean
  loading: boolean
  activeNoteId: string | null
  onOpenNote: (noteId: string) => void
  /** The story names for an anchor's row (up to two and "+N"). */
  storyLabelsOf: ((noteId: string) => StoryLabels) | null
  draft: WorkshopDraft | null
  onCommitDraft: (title: string) => Promise<void>
  onCancelDraft: () => void
  onAddAnchor: () => void
  onCreateAnchors: () => void
}

/**
 * The anchors part when the panel is not about one story: the whole workshop in the author's own
 * order, the ones that belong nowhere last under "No story"; or a universe, with its events first.
 * Where the order of a story's text decides, the story's own part shows it; here the author's
 * order is all there is.
 */
export function AnchorsOverview({
  buckets,
  universe,
  canWrite,
  loading,
  activeNoteId,
  onOpenNote,
  storyLabelsOf,
  draft,
  onCommitDraft,
  onCancelDraft,
  onAddAnchor,
  onCreateAnchors,
}: AnchorsOverviewProps) {
  const { t } = useTranslation()
  const indent = treeIndent(1)
  if (!buckets) {
    return (
      <div className="flex flex-col items-start gap-1.5 py-1 pr-3" style={{ paddingLeft: indent }}>
        <p className="text-xs text-muted-foreground">{t("creative.workshop.noAnchors")}</p>
        {canWrite && (
          <Button variant="outline" size="sm" onClick={onCreateAnchors}>
            {t("creative.workshop.createAnchors")}
          </Button>
        )}
      </div>
    )
  }

  const row = (anchor: DatabaseRow) => {
    const labels = storyLabelsOf?.(anchor.noteId)
    return (
      <button
        key={anchor.noteId}
        type="button"
        aria-current={activeNoteId === anchor.noteId ? "true" : undefined}
        onClick={() => onOpenNote(anchor.noteId)}
        style={{ paddingLeft: indent }}
        className={cn(
          "amby-tree-row flex w-full items-center gap-1.5 rounded py-0.5 pr-3 text-left text-[13px] hover:bg-accent",
          activeNoteId === anchor.noteId && "bg-accent",
        )}
      >
        <Anchor className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{anchor.title}</span>
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
    )
  }
  const heading = (text: string, count?: number) => (
    <h4
      className="flex items-center gap-1 pb-0.5 pr-3 pt-1 text-[11px] text-muted-foreground"
      style={{ paddingLeft: indent }}
    >
      <span className="truncate">{text}</span>
      {count !== undefined && <span className="opacity-60">{count}</span>}
    </h4>
  )
  const quiet = (text: string) => (
    <p className="py-1 pr-3 text-xs text-muted-foreground" style={{ paddingLeft: indent }}>
      {text}
    </p>
  )

  const { events, shown, withoutStory } = buckets
  const empty = !universe && shown.length + withoutStory.length === 0
  const naming = draft?.kind === "anchor"
  return (
    <>
      {empty && !naming ? (
        canWrite ? (
          <EmptyAction label={t("creative.workshop.addFirstAnchor")} onClick={onAddAnchor} />
        ) : (
          quiet(loading ? "" : t("creative.workshop.noAnchorsYet"))
        )
      ) : (
        <>
          {universe && (
            <>
              {heading(t("creative.plot.events.group"), events.length)}
              {events.length === 0 ? quiet(t("creative.plot.events.empty")) : events.map(row)}
              {shown.length > 0 && heading(t("creative.plot.events.stories"), shown.length)}
            </>
          )}
          {shown.map(row)}
          {withoutStory.length > 0 && (
            <>
              {heading(t("creative.workshop.noStory"), withoutStory.length)}
              {withoutStory.map(row)}
            </>
          )}
        </>
      )}
      {naming && (
        <InlineCreateRow
          depth={0}
          icon={<Anchor className="size-3.5" />}
          placeholder={t("creative.workshop.newAnchorPlaceholder")}
          onSubmit={onCommitDraft}
          onCancel={onCancelDraft}
        />
      )}
    </>
  )
}
