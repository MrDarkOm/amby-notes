import * as React from "react"
import { Plus, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { NoticeLine } from "@/components/workspace/notices/notice-line"
import type { DatabaseRow, StorySummary, WorkshopSummary } from "@/lib/storage"
import { isEnterKey } from "@/lib/keyboard"
import { projectErrorText } from "@/lib/operation-errors"
import { useCreativeNavStore } from "../creative-nav-store"
import { readScene } from "../workshop/scene-model"
import { usePlotEnsurer } from "../workshop/use-ensure-plot"
import { useDatabaseRows } from "../workshop/use-database-rows"
import { useSceneLinks, type ScenePart } from "../workshop/use-scene-links"
import { storySection } from "../workshop/workshop-model"

type RelationPart = Exclude<ScenePart, "storyTime">

function Chip({
  title,
  removeLabel,
  onRemove,
}: {
  title: string
  removeLabel: string
  onRemove?: () => void
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-0.5 rounded-full bg-accent px-2 py-0.5 text-xs">
      <span className="truncate">{title}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel}
          title={removeLabel}
          className="-mr-1 rounded-full p-0.5 text-muted-foreground hover:text-foreground"
          onClick={onRemove}
        >
          <X aria-hidden="true" className="size-3" />
        </button>
      )}
    </span>
  )
}

function Picker({
  label,
  options,
  disabled,
  onPick,
}: {
  label: string
  options: DatabaseRow[]
  disabled: boolean
  onPick: (noteId: string) => void
}) {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={disabled}
          aria-label={label}
          title={label}
          className="size-6"
        >
          <Plus aria-hidden="true" className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-64 w-52 overflow-y-auto">
        {options.length === 0 ? (
          <DropdownMenuItem disabled>{t("creative.scene.nobody")}</DropdownMenuItem>
        ) : (
          options.map((option) => (
            <DropdownMenuItem key={option.noteId} onSelect={() => onPick(option.noteId)}>
              <span className="truncate">{option.title}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The scene of a page of a story's text: its point of view, its characters, its places and its
 * story time, each a property of the text made on the author's first use (format §6). Shown for
 * every page of a workshop with characters or locations; editable unless the page is locked.
 */
export function SceneBlock({
  workshop,
  story,
  noteId,
  locked,
}: {
  workshop: WorkshopSummary
  story: StorySummary
  noteId: string
  locked?: boolean
}) {
  const { t } = useTranslation()
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const bumpData = useCreativeNavStore((state) => state.bumpData)
  const text = story.text
  const characters = storySection(workshop, "characters")
  const locations = storySection(workshop, "locations")
  const databaseIds = React.useMemo(
    () =>
      [text?.databaseId, characters?.databaseId, locations?.databaseId].filter((id): id is string =>
        Boolean(id),
      ),
    [characters?.databaseId, locations?.databaseId, text?.databaseId],
  )
  const data = useDatabaseRows(databaseIds, dataNonce)
  const { ensure } = usePlotEnsurer()
  const scene = useSceneLinks(ensure)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const row = text?.databaseId
    ? data.rows[text.databaseId]?.find((candidate) => candidate.noteId === noteId)
    : undefined
  const current = row && text ? readScene(row, text.properties) : null
  const people = characters ? (data.rows[characters.databaseId] ?? []) : []
  const places = locations ? (data.rows[locations.databaseId] ?? []) : []
  const titleOf = (rows: DatabaseRow[], id: string) =>
    rows.find((candidate) => candidate.noteId === id)?.title ?? t("creative.dossier.missingPage")
  const editable = Boolean(row) && !locked && !workshop.readOnly

  // The story time is edited in place and written when the field is left.
  const stored = current?.storyTime ?? ""
  const [time, setTime] = React.useState(stored)
  const saved = React.useRef(stored)
  const focused = React.useRef(false)
  React.useEffect(() => {
    if (focused.current) return
    saved.current = stored
    setTime(stored)
  }, [stored])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      bumpData()
    } catch (caught) {
      setError(projectErrorText(t, caught))
    } finally {
      setBusy(false)
    }
  }
  const toggle = (part: RelationPart, targetId: string, add: boolean) => {
    if (!row) return
    void run(() => scene.toggle({ workshop, story, row, part, targetId, add }))
  }
  const saveTime = () => {
    focused.current = false
    if (!row || !editable) return
    const next = time.trim()
    if (next === saved.current.trim()) return
    void run(async () => {
      await scene.setStoryTime({ workshop, story, row, value: next })
      saved.current = next
    })
  }

  if (!text || (!characters && !locations)) return null

  const chips = (part: RelationPart, ids: string[], rows: DatabaseRow[]) =>
    ids.map((id) => (
      <Chip
        key={`${part}:${id}`}
        title={titleOf(rows, id)}
        removeLabel={t("creative.scene.remove", { name: titleOf(rows, id) })}
        onRemove={editable ? () => toggle(part, id, false) : undefined}
      />
    ))

  const line = (label: string, content: React.ReactNode) => (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-1">{content}</div>
    </div>
  )

  return (
    <section aria-label={t("creative.scene.title")} className="flex flex-col gap-2">
      <span className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("creative.scene.title")}
      </span>
      <div className="flex flex-col gap-2 px-2">
        {characters &&
          line(
            t("creative.scene.properties.pov"),
            <>
              {current?.pov ? chips("pov", [current.pov], people) : null}
              {editable && (
                <Picker
                  label={t("creative.scene.choosePov")}
                  options={people.filter((person) => person.noteId !== current?.pov)}
                  disabled={busy}
                  onPick={(id) => toggle("pov", id, true)}
                />
              )}
            </>,
          )}
        {characters &&
          line(
            t("creative.scene.properties.characters"),
            <>
              {chips("characters", current?.characters ?? [], people)}
              {editable && (
                <Picker
                  label={t("creative.scene.addCharacter")}
                  options={people.filter((person) => !current?.characters.includes(person.noteId))}
                  disabled={busy}
                  onPick={(id) => toggle("characters", id, true)}
                />
              )}
            </>,
          )}
        {locations &&
          line(
            t("creative.scene.properties.places"),
            <>
              {chips("places", current?.places ?? [], places)}
              {editable && (
                <Picker
                  label={t("creative.scene.addPlace")}
                  options={places.filter((place) => !current?.places.includes(place.noteId))}
                  disabled={busy}
                  onPick={(id) => toggle("places", id, true)}
                />
              )}
            </>,
          )}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">
            {t("creative.scene.properties.storyTime")}
          </span>
          <input
            type="text"
            value={time}
            readOnly={!editable}
            placeholder={editable ? t("creative.scene.storyTimeHint") : undefined}
            className="rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-xs outline-none hover:border-border focus:border-ring read-only:hover:border-transparent"
            onFocus={() => {
              focused.current = true
            }}
            onChange={(event) => setTime(event.target.value)}
            onBlur={saveTime}
            onKeyDown={(event) => {
              if (isEnterKey(event)) event.currentTarget.blur()
              if (event.key === "Escape") {
                setTime(saved.current)
                event.currentTarget.blur()
              }
            }}
          />
        </label>
      </div>
      {error && <NoticeLine text={error} role="status" />}
    </section>
  )
}
