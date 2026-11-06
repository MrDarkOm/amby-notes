import * as React from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { SyncPortError } from "@/lib/sync/sync-port"
import type { GroupConflictVersions, NotePick } from "@/lib/sync/sync-port"

/** What the list of conflicts needs to choose a group of note properties by notes (З69). */
export interface GroupConflictActions {
  read: (id: string) => Promise<GroupConflictVersions>
  resolve: (id: string, picks: Record<string, NotePick>, stamp: string) => Promise<void>
  /** A refusal other than `conflict_changed`: the panel shows it. */
  onError: (caught: unknown) => void
}

/**
 * The choice by notes for a conflict of a group of note properties (З17, З69): one row per note
 * changed differently on the two computers, "Готово" when every note has a side. When the app cannot
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

  return (
    <div className="space-y-2">
      <ul data-testid="sync-group-notes" className="space-y-1.5">
        {notes.map((note) => {
          const title = note.noteTitle
            ? t("sync.vault.conflicts.appData.group.note", { title: note.noteTitle })
            : t("sync.vault.conflicts.appData.group.untitled")
          return (
            <li key={note.noteId}>
              <div
                role="group"
                aria-label={title}
                className="flex flex-wrap items-center gap-2 text-[12px]"
              >
                <span className="min-w-0 flex-1 truncate" title={note.notePath ?? undefined}>
                  {title}
                </span>
                {(
                  [
                    ["current", "sync.vault.conflicts.appData.group.current"],
                    ["other", "sync.vault.conflicts.appData.group.other"],
                  ] as const
                ).map(([pick, key]) => (
                  <Button
                    key={pick}
                    type="button"
                    size="sm"
                    variant={picks[note.noteId] === pick ? "default" : "outline"}
                    aria-pressed={picks[note.noteId] === pick}
                    disabled={disabled || saving}
                    onClick={() => choose(note.noteId, pick)}
                  >
                    {t(key)}
                  </Button>
                ))}
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
      <Button type="button" size="sm" disabled={!complete || disabled || saving} onClick={done}>
        {t("sync.vault.conflicts.appData.group.done")}
      </Button>
    </div>
  )
}
