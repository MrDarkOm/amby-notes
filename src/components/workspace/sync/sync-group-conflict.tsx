import * as React from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { SyncPortError } from "@/lib/sync/sync-port"
import type { GroupConflictVersions, NotePick } from "@/lib/sync/sync-port"
import { IconValue } from "../icon-value"

/** What the list of conflicts needs to choose a group of note properties by notes (З69). */
export interface GroupConflictActions {
  read: (id: string) => Promise<GroupConflictVersions>
  resolve: (id: string, picks: Record<string, NotePick>, stamp: string) => Promise<void>
  /** A refusal other than `conflict_changed`: the panel shows it. */
  onError: (caught: unknown) => void
}

/**
 * The choice by notes for a conflict of a group of note properties (З17, З69): for every note
 * changed differently on the two computers, two cards that show what each side keeps; "Применить"
 * when every note has a side. When the app cannot
 * choose by notes (`conflict_not_group`) it renders `fallback` — the whole-file choice.
 */
export function GroupConflictChooser({
  id,
  actions,
  disabled,
  fallback,
}: {
  id: string
  actions: GroupConflictActions
  disabled: boolean
  fallback: React.ReactNode
}) {
  const { t } = useTranslation()
  const [read, setRead] = React.useState<GroupConflictVersions | null>(null)
  const [whole, setWhole] = React.useState(false)
  const [picks, setPicks] = React.useState<Record<string, NotePick>>({})
  const [saving, setSaving] = React.useState(false)
  const [changed, setChanged] = React.useState(false)
  const { read: readGroup, resolve, onError } = actions

  const load = React.useCallback(
    () =>
      readGroup(id).then(
        (answer) => {
          setRead(answer)
          setPicks({})
        },
        () => setWhole(true),
      ),
    [id, readGroup],
  )

  React.useEffect(() => {
    void load()
  }, [load])

  if (whole) return <>{fallback}</>
  if (!read) {
    return (
      <p className="text-[11px] text-muted-foreground">
        {t("sync.vault.conflicts.appData.group.loading")}
      </p>
    )
  }

  const notes = read.group.notes
  const complete = notes.every((note) => picks[note.noteId] !== undefined)
  const choose = (noteId: string, pick: NotePick) => {
    setChanged(false)
    setPicks((current) => ({ ...current, [noteId]: pick }))
  }
  const done = () => {
    setSaving(true)
    setChanged(false)
    resolve(id, picks, read.stamp)
      .catch(async (caught) => {
        if (caught instanceof SyncPortError && caught.code === "conflict_changed") {
          await load()
          setChanged(true)
          return
        }
        onError(caught)
      })
      .finally(() => setSaving(false))
  }

  const intro =
    notes.length > 1
      ? t("sync.vault.conflicts.appData.group.introMany")
      : t("sync.vault.conflicts.appData.group.intro")
  return (
    <div className="space-y-3">
      <p className="text-[12px] leading-snug">{intro}</p>
      <ul data-testid="sync-group-notes" className="space-y-3">
        {notes.map((note) => {
          const title = note.noteTitle
            ? t("sync.vault.conflicts.appData.group.note", { title: note.noteTitle })
            : t("sync.vault.conflicts.appData.group.untitled")
          return (
            <li key={note.noteId}>
              <div role="radiogroup" aria-label={title} className="space-y-1.5">
                {(notes.length > 1 || note.noteTitle) && (
                  <p
                    className="truncate text-[12px] font-medium"
                    title={note.notePath ?? undefined}
                  >
                    {title}
                  </p>
                )}
                <div className="grid grid-cols-2 gap-2">
                  {(["current", "other"] as const).map((side) => (
                    <SideCard
                      key={side}
                      note={note}
                      side={side}
                      checked={picks[note.noteId] === side}
                      disabled={disabled || saving}
                      onChoose={() => choose(note.noteId, side)}
                    />
                  ))}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
      {read.group.autoMerged > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {t("sync.vault.conflicts.appData.group.merged", { count: read.group.autoMerged })}
        </p>
      )}
      {changed && (
        <p role="alert" className="text-[12px] text-destructive">
          {t("sync.vault.conflicts.appData.group.changed")}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] leading-snug text-muted-foreground">
          {t("sync.vault.conflicts.appData.group.keep")}
        </p>
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          disabled={!complete || disabled || saving}
          onClick={done}
        >
          {t("sync.vault.conflicts.appData.group.done")}
        </Button>
      </div>
    </div>
  )
}

type GroupNote = GroupConflictVersions["group"]["notes"][number]
type Look = NonNullable<GroupNote["changes"][number]["current"]>

/** A select and a multi-select keep their values in `settings` (З62). */
const hasOptions = (type: string | null | undefined) => type === "select" || type === "list"

/** One side of a note: a card that is chosen whole and says what it keeps (З69). */
function SideCard({
  note,
  side,
  checked,
  disabled,
  onChoose,
}: {
  note: GroupNote
  side: NotePick
  checked: boolean
  disabled: boolean
  onChoose: () => void
}) {
  const { t } = useTranslation()
  const labelId = React.useId()
  const removed = side === "current" ? note.currentRemoved : note.otherRemoved
  const detail = (look: Look | null) => {
    if (!look) return t("sync.vault.conflicts.appData.group.defaultLook")
    const parts: string[] = []
    if (look.propertyType) parts.push(t(`infoPanel.propertyTypes.${look.propertyType}`))
    if (look.settings) {
      parts.push(
        hasOptions(look.propertyType)
          ? t("sync.vault.conflicts.appData.group.options")
          : t("sync.vault.conflicts.appData.group.settings"),
      )
    }
    if (parts.length === 0 && !look.icon) {
      return t("sync.vault.conflicts.appData.group.defaultLook")
    }
    return parts.join(", ")
  }
  const nothing = !removed && note.changes.length === 0 && !note.orderDiffers
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-labelledby={labelId}
      disabled={disabled}
      onClick={onChoose}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-md border bg-background p-2.5 text-left outline-none",
        "hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
        checked ? "border-primary ring-1 ring-primary" : "border-border",
      )}
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "flex size-3.5 shrink-0 items-center justify-center rounded-full border",
            checked ? "border-primary" : "border-muted-foreground/50",
          )}
        >
          {checked && <span className="size-1.5 rounded-full bg-primary" />}
        </span>
        <span id={labelId} className="text-[12px] font-medium">
          {t(`sync.vault.conflicts.appData.group.${side}`)}
        </span>
      </span>
      <span className="flex flex-col gap-1 text-[12px] text-muted-foreground">
        {removed ? (
          <span>{t("sync.vault.conflicts.appData.group.removed")}</span>
        ) : (
          <>
            {note.changes.map((change) => {
              const look = side === "current" ? change.current : change.other
              const text = detail(look)
              return (
                <span key={change.name} className="flex min-w-0 items-center gap-1.5">
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {look?.icon ? <IconValue value={look.icon} className="size-4" /> : null}
                  </span>
                  <span className="truncate">
                    <span className="text-foreground">{change.name}</span>
                    {text && <span> · {text}</span>}
                  </span>
                </span>
              )
            })}
            {note.orderDiffers && <span>{t("sync.vault.conflicts.appData.group.order")}</span>}
            {nothing && <span>{t("sync.vault.conflicts.appData.group.sameLook")}</span>}
          </>
        )}
      </span>
    </button>
  )
}
