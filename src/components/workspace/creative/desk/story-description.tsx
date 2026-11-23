import * as React from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { NoticeLine } from "@/components/workspace/notices/notice-line"
import { reportOperationError } from "@/lib/operation-errors"
import { isTauri, readNote, writeNote, type NoteReadOutcome } from "@/lib/storage"
import { DeskWidget } from "./desk-widget"

export function StoryDescription({
  vaultPath,
  noteId,
  generation,
  editable,
  refresh,
}: {
  vaultPath: string
  noteId: string
  generation: number | null
  editable: boolean
  refresh: number
}) {
  const { t } = useTranslation()
  const [note, setNote] = React.useState<Pick<NoteReadOutcome, "content" | "revision"> | null>(null)
  const [draft, setDraft] = React.useState<typeof note>(null)
  const [pending, setPending] = React.useState(false)
  const [readError, setReadError] = React.useState<string | null>(null)
  const [saveError, setSaveError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let current = true
    void readNote(vaultPath, noteId).then(
      (result) => {
        if (!current) return
        setNote(result)
        setReadError(null)
      },
      (error: unknown) => {
        if (current) setReadError(reportOperationError(error))
      },
    )
    return () => {
      current = false
    }
  }, [vaultPath, noteId, refresh])

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!draft || pending || !editable) return
    setPending(true)
    setSaveError(null)
    try {
      const result = await writeNote(
        vaultPath,
        noteId,
        draft.content,
        generation,
        draft.revision,
        isTauri() ? getCurrentWindow().label : "main",
      )
      setNote({ content: draft.content, revision: result.revision })
      setDraft(null)
    } catch (error) {
      setSaveError(reportOperationError(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <DeskWidget title={t("creative.storyDescription.title")}>
      {draft && editable ? (
        <form onSubmit={(event) => void save(event)} className="flex flex-col gap-2">
          <textarea
            autoFocus
            rows={4}
            aria-label={t("creative.storyDescription.title")}
            value={draft.content}
            disabled={pending}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
            className="w-full rounded-md border border-input bg-background p-2 text-sm"
          />
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={pending || draft.content === note?.content}>
              {t("common.save")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              disabled={pending}
              onClick={() => {
                setDraft(null)
                setSaveError(null)
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : note ? (
        <>
          <p className="whitespace-pre-wrap break-words text-sm">
            {note.content || t("creative.storyDescription.empty")}
          </p>
          {editable && (
            <Button size="sm" variant="outline" className="w-fit" onClick={() => setDraft(note)}>
              {t("creative.storyDescription.edit")}
            </Button>
          )}
        </>
      ) : null}
      {(saveError || readError) && <NoticeLine text={saveError ?? readError ?? ""} role="status" />}
    </DeskWidget>
  )
}
