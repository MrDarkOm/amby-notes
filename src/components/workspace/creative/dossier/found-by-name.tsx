import * as React from "react"
import { Link2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { DatabaseRow, StorySummary } from "@/lib/storage"
import { projectErrorText } from "@/lib/operation-errors"
import { useCreativeNavStore } from "../creative-nav-store"
import { usePlotEnsurer } from "../workshop/use-ensure-plot"
import { useSceneLinks, type ScenePart } from "../workshop/use-scene-links"
import { bindingPartOf, type TextMention } from "./mention-model"
import type { NoteDossier } from "./use-note-dossier"

/**
 * The pages of the text that name this world page without being linked to it. Each opens its
 * page; for a character or a location, "Bind" links the page to it (the text's "Characters" or
 * "Places" is made on first use), after which the page moves up into "Appears in".
 */
export function FoundByName({
  dossier,
  mentions,
  pageOf,
  showStory,
  locked,
  onOpenNote,
}: {
  dossier: NoteDossier
  mentions: TextMention[]
  pageOf: (noteId: string) => { story: StorySummary; row: DatabaseRow } | null
  showStory: boolean
  locked?: boolean
  onOpenNote?: (noteId: string) => void
}) {
  const { t } = useTranslation()
  const bumpData = useCreativeNavStore((state) => state.bumpData)
  const { ensure } = usePlotEnsurer()
  const scene = useSceneLinks(ensure)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<{ noteId: string; text: string } | null>(null)
  const { workshop } = dossier.world
  const part: Exclude<ScenePart, "storyTime"> | null = bindingPartOf(dossier.world.section.role)
  const canBind = part !== null && !locked && !workshop.readOnly && !dossier.context.locked

  const bind = async (noteId: string) => {
    const page = pageOf(noteId)
    if (!page || !part) return
    setBusy(noteId)
    setError(null)
    try {
      await scene.toggle({
        workshop,
        story: page.story,
        row: page.row,
        part,
        targetId: dossier.context.row.noteId,
        add: true,
      })
      bumpData()
    } catch (caught) {
      setError({ noteId, text: projectErrorText(t, caught) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <span className="px-2 pt-1 text-[11px] text-muted-foreground">
        {t("creative.dossier.foundByName")}
      </span>
      {mentions.map((mention) => (
        <div key={mention.noteId} className="flex flex-col">
          <div className="group flex min-w-0 items-center gap-1">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-baseline gap-1.5 rounded-md px-2 py-1 text-left text-xs hover:bg-accent/50"
              title={`${mention.storyName} · …${mention.snippet}…`}
              onClick={() => onOpenNote?.(mention.noteId)}
            >
              <span className="truncate">{mention.title}</span>
              {showStory && (
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {mention.storyName}
                </span>
              )}
            </button>
            {canBind && (
              <button
                type="button"
                aria-label={t("creative.dossier.bind")}
                title={t(
                  part === "places"
                    ? "creative.dossier.bindPlaceHint"
                    : "creative.dossier.bindCharacterHint",
                )}
                disabled={busy !== null}
                className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
                onClick={() => void bind(mention.noteId)}
              >
                <Link2 aria-hidden="true" className="size-3" />
                {t("creative.dossier.bind")}
              </button>
            )}
          </div>
          {error?.noteId === mention.noteId && (
            <p role="alert" className="px-2 text-[11px] text-destructive">
              {error.text}
            </p>
          )}
        </div>
      ))}
    </>
  )
}
