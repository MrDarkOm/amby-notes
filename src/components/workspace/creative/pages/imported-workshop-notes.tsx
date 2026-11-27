import * as React from "react"
import { FileText } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { NoticeLine } from "../../notices/notice-line"
import { useDatabaseStore } from "../../database/database-store"
import { isTauri, workshopImport, type ImportedNote, type WorkshopSummary } from "@/lib/storage"
import { useCreativeNavStore } from "../creative-nav-store"

/** Imported notes stay in their original source. The ordinary gallery owns only its own rows. */
export function ImportedWorkshopNotes({
  workshop,
  sectionId,
  onOpenNote,
}: {
  workshop: WorkshopSummary
  sectionId: string
  onOpenNote: (id: string) => void
}) {
  const { t } = useTranslation()
  const generation = useDatabaseStore((state) => state.vaultGeneration)
  const nonce = useCreativeNavStore((state) => state.dataNonce)
  const bumpData = useCreativeNavStore((state) => state.bumpData)
  const [entries, setEntries] = React.useState<ImportedNote[]>([])
  const [error, setError] = React.useState(false)
  const [pending, setPending] = React.useState(false)

  React.useEffect(() => {
    if (!isTauri() || generation === null) return
    let live = true
    void workshopImport({
      workshopId: workshop.workshopId,
      expectedGeneration: generation,
      action: { kind: "list" },
    })
      .then((result) => {
        if (!live) return
        setEntries(result.entries.filter((entry) => entry.sectionId === sectionId))
        setError(false)
      })
      .catch(() => {
        if (live) setError(true)
      })
    return () => {
      live = false
    }
  }, [generation, nonce, workshop, sectionId])

  const unlink = async (noteId: string) => {
    if (generation === null || pending) return
    setPending(true)
    try {
      const result = await workshopImport({
        workshopId: workshop.workshopId,
        expectedGeneration: generation,
        action: { kind: "unlink", sectionId, noteId },
      })
      setEntries(result.entries.filter((entry) => entry.sectionId === sectionId))
      setError(false)
      bumpData()
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }

  if (!entries.length && !error) return null
  return (
    <section aria-label={t("creative.import.linked")} className="flex flex-col gap-2">
      <h2 className="text-base font-medium">{t("creative.import.linked")}</h2>
      {error && <NoticeLine role="alert" text={t("creative.import.failed")} />}
      <ul className="divide-y rounded-lg border">
        {entries.map((entry) => (
          <li key={entry.noteId} className="flex flex-wrap items-start justify-between gap-3 p-3">
            <div className="min-w-0">
              {entry.available ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="max-w-full justify-start"
                  onClick={() => onOpenNote(entry.noteId)}
                >
                  <FileText className="size-4 shrink-0" />
                  <span className="truncate">{entry.title}</span>
                </Button>
              ) : (
                <>
                  <p className="break-words text-sm">{entry.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("creative.import.sourceMissing")}
                  </p>
                </>
              )}
              {entry.fields.length > 0 && (
                <dl className="grid gap-1 px-2 text-xs text-muted-foreground">
                  {entry.fields.map((field, index) => (
                    <div key={index} className="flex flex-wrap gap-x-2">
                      <dt>{field.name}</dt>
                      <dd className="min-w-0 break-words text-foreground">{field.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
            {!workshop.readOnly && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => void unlink(entry.noteId)}
              >
                {t("creative.import.unlink")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
