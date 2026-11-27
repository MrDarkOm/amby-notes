import * as React from "react"
import { useTranslation } from "react-i18next"
import { AmbySelect } from "@/components/ui/amby-select"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { NoticeLine } from "../notices/notice-line"
import {
  openVault,
  resolveWorkshopFolder,
  workshopImport,
  type ImportPreview,
  type ImportSelection,
  type ImportSource,
} from "@/lib/storage"
import { useOperationId } from "./use-operation-id"

interface Choice {
  id: string
  name: string
}

interface WorkshopImportDialogProps {
  workshopId: string
  generation: number
  sections: readonly Choice[]
  databases: readonly Choice[]
  onClose: () => void
  onChanged: () => void
}

export function WorkshopImportDialog({
  workshopId,
  generation,
  sections,
  databases,
  onClose,
  onChanged,
}: WorkshopImportDialogProps) {
  const { t } = useTranslation()
  const nextSource = React.useRef(1)
  const [sources, setSources] = React.useState<(ImportSource & { key: number })[]>(() => [
    { key: 0, kind: "folder", sourceId: "", sectionId: sections[0]?.id ?? "" },
  ])
  const [preview, setPreview] = React.useState<ImportPreview | null>(null)
  const [selection, setSelection] = React.useState<ImportSelection[]>([])
  const [receipt, setReceipt] = React.useState<{ operationId: string; added: number } | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const requestSources = sources.map(({ kind, sourceId, sectionId }) => ({
    kind,
    sourceId: sourceId.trim(),
    sectionId,
  }))
  const operationId = useOperationId("workshop-import", {
    workshopId,
    preview: preview?.revision,
    selection,
  })
  const replaceSource = (key: number, patch: Partial<ImportSource>) =>
    setSources((current) =>
      current.map((source) => (source.key === key ? { ...source, ...patch } : source)),
    )
  const editSelection = (
    sourceIndex: number,
    update: (current: ImportSelection) => ImportSelection,
  ) =>
    setSelection((current) =>
      current.map((item) => (item.sourceIndex === sourceIndex ? update(item) : item)),
    )

  const run = async (task: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      await task()
    } catch (caught) {
      const kind = (caught as { kind?: string } | null)?.kind
      setError(t(kind === "revisionConflict" ? "creative.import.stale" : "creative.import.failed"))
    } finally {
      setBusy(false)
    }
  }

  const prepare = () =>
    run(async () => {
      const result = await workshopImport({
        expectedGeneration: generation,
        workshopId,
        action: { kind: "preview", sources: requestSources },
      })
      if (!result.preview) throw new Error("Missing import preview")
      setSelection(
        result.preview.sources.map((source, sourceIndex) => ({
          sourceIndex,
          noteIds: source.candidates.flatMap((note) =>
            note.noteId && !note.alreadyLinked ? [note.noteId] : [],
          ),
          mappings: source.suggested,
        })),
      )
      setPreview(result.preview)
    })

  const apply = () =>
    run(async () => {
      if (!preview) return
      const id = operationId()
      const result = await workshopImport({
        workshopId,
        expectedGeneration: generation,
        action: {
          kind: "apply",
          sources: requestSources,
          selection,
          operationId: id,
          expectedPreview: preview.revision,
        },
      })
      setReceipt({ operationId: id, added: result.added })
      onChanged()
    })

  const undo = () =>
    run(async () => {
      if (!receipt) return
      await workshopImport({
        workshopId,
        expectedGeneration: generation,
        action: { kind: "undo", operationId: receipt.operationId },
      })
      onChanged()
      onClose()
    })

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>{t("creative.import.title")}</DialogTitle>
          <DialogDescription>{t("creative.import.hint")}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-3 overflow-y-auto">
          {error && <NoticeLine role="alert" text={error} />}
          {receipt ? (
            <NoticeLine
              role="status"
              text={t("creative.import.finished", { count: receipt.added })}
            />
          ) : preview ? (
            <>
              <p className="break-words text-xs text-muted-foreground">
                {t("creative.import.writePath", { path: preview.writePath })}
              </p>
              {preview.sources.map((source, index) => {
                const chosen = selection[index]
                return (
                  <fieldset
                    key={sources[index].key}
                    disabled={busy}
                    className="grid gap-2 rounded-lg border p-3"
                  >
                    <legend className="max-w-full break-words px-1 text-sm font-medium">
                      {t("creative.import.sourceDestination", {
                        source:
                          databases.find((database) => database.id === source.source.sourceId)
                            ?.name ?? source.source.sourceId,
                        destination:
                          sections.find((section) => section.id === source.source.sectionId)
                            ?.name ?? source.source.sectionId,
                      })}
                    </legend>
                    {source.candidates.length === 0 && (
                      <p className="text-xs text-muted-foreground">{t("creative.import.empty")}</p>
                    )}
                    {source.candidates.some((note) => note.noteId && !note.alreadyLinked) && (
                      <div className="flex flex-wrap gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            editSelection(index, (current) => ({
                              ...current,
                              noteIds: source.candidates.flatMap((note) =>
                                note.noteId && !note.alreadyLinked ? [note.noteId] : [],
                              ),
                            }))
                          }
                        >
                          {t("databaseRowMenu.selectAll")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            editSelection(index, (current) => ({ ...current, noteIds: [] }))
                          }
                        >
                          {t("databaseRowMenu.clearSelection")}
                        </Button>
                      </div>
                    )}
                    {source.candidates.map((note) => (
                      <label key={note.path} className="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="mt-1 accent-primary"
                          disabled={!note.noteId || note.alreadyLinked}
                          checked={Boolean(note.noteId && chosen.noteIds.includes(note.noteId))}
                          onChange={(event) => {
                            const id = note.noteId
                            if (!id) return
                            const checked = event.target.checked
                            editSelection(index, (current) => ({
                              ...current,
                              noteIds: checked
                                ? [...current.noteIds, id]
                                : current.noteIds.filter((key) => key !== id),
                            }))
                          }}
                        />
                        <span className="min-w-0 break-words">
                          {note.title}
                          <span className="block text-xs text-muted-foreground">{note.path}</span>
                          {(!note.noteId || note.alreadyLinked) && (
                            <span className="block text-xs text-muted-foreground">
                              {t(
                                note.alreadyLinked
                                  ? "creative.import.alreadyLinked"
                                  : "creative.import.identityUnavailable",
                              )}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                    {source.targetFields.map((target) => {
                      const compatible = source.sourceFields.filter(
                        (field) => field.valueType === target.valueType,
                      )
                      if (compatible.length === 0) return null
                      return (
                        <label key={target.key} className="grid gap-1 text-xs">
                          {t("creative.import.mapField", { name: target.name })}
                          <AmbySelect
                            size="sm"
                            disabled={busy}
                            aria-label={t("creative.import.mapField", { name: target.name })}
                            value={
                              chosen.mappings.find((mapping) => mapping.targetId === target.key)
                                ?.sourceKey ?? ""
                            }
                            options={[
                              { value: "", label: t("creative.import.skipField") },
                              ...compatible.map((field) => ({
                                value: field.key,
                                label: field.example
                                  ? t("creative.import.fieldExample", {
                                      name: field.name,
                                      example: field.example,
                                    })
                                  : field.name,
                              })),
                            ]}
                            onValueChange={(sourceKey) => {
                              editSelection(index, (current) => {
                                const mappings = current.mappings.filter(
                                  (mapping) => mapping.targetId !== target.key,
                                )
                                return {
                                  ...current,
                                  mappings: sourceKey
                                    ? [...mappings, { sourceKey, targetId: target.key }]
                                    : mappings,
                                }
                              })
                            }}
                          />
                        </label>
                      )
                    })}
                  </fieldset>
                )
              })}
            </>
          ) : (
            <>
              {sources.map((source, index) => (
                <fieldset
                  key={source.key}
                  disabled={busy}
                  className="grid gap-2 rounded-lg border p-3"
                >
                  <legend className="px-1 text-sm font-medium">
                    {t("creative.import.sourceNumber", { number: index + 1 })}
                  </legend>
                  <label className="grid gap-1 text-xs">
                    {t("creative.import.sourceType")}
                    <AmbySelect
                      size="sm"
                      disabled={busy}
                      aria-label={t("creative.import.sourceType")}
                      value={source.kind}
                      options={[
                        { value: "folder", label: t("creative.import.folder") },
                        { value: "database", label: t("creative.import.database") },
                      ]}
                      onValueChange={(value) =>
                        replaceSource(source.key, {
                          kind: value === "database" ? "database" : "folder",
                          sourceId: "",
                        })
                      }
                    />
                  </label>
                  {source.kind === "folder" ? (
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="grid min-w-44 flex-1 gap-1 text-xs">
                        {t("creative.import.folderPath")}
                        <Input
                          value={source.sourceId}
                          onChange={(event) =>
                            replaceSource(source.key, { sourceId: event.target.value })
                          }
                        />
                      </label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void run(async () => {
                            const picked = await openVault()
                            if (picked)
                              replaceSource(source.key, {
                                sourceId: await resolveWorkshopFolder(picked),
                              })
                          })
                        }
                      >
                        {t("creative.import.chooseFolder")}
                      </Button>
                    </div>
                  ) : (
                    <label className="grid gap-1 text-xs">
                      {t("creative.import.database")}
                      <AmbySelect
                        size="sm"
                        disabled={busy}
                        aria-label={t("creative.import.database")}
                        value={source.sourceId}
                        placeholder={t("creative.import.chooseDatabase")}
                        options={databases.map((database) => ({
                          value: database.id,
                          label: database.name,
                        }))}
                        onValueChange={(sourceId) => replaceSource(source.key, { sourceId })}
                      />
                    </label>
                  )}
                  <label className="grid gap-1 text-xs">
                    {t("creative.import.destination")}
                    <AmbySelect
                      size="sm"
                      disabled={busy}
                      aria-label={t("creative.import.destination")}
                      value={source.sectionId}
                      options={sections.map((section) => ({
                        value: section.id,
                        label: section.name,
                      }))}
                      onValueChange={(sectionId) => replaceSource(source.key, { sectionId })}
                    />
                  </label>
                  {sources.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="justify-self-start"
                      onClick={() =>
                        setSources((current) => current.filter((item) => item.key !== source.key))
                      }
                    >
                      {t("creative.import.removeSource")}
                    </Button>
                  )}
                </fieldset>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="justify-self-start"
                disabled={busy || sources.length >= 24}
                onClick={() => {
                  const key = nextSource.current++
                  setSources((current) => [
                    ...current,
                    { key, kind: "folder", sourceId: "", sectionId: sections[0]?.id ?? "" },
                  ])
                }}
              >
                {t("creative.import.addSource")}
              </Button>
            </>
          )}
        </div>
        <DialogFooter>
          {receipt ? (
            <>
              {receipt.added > 0 && (
                <Button variant="outline" disabled={busy} onClick={() => void undo()}>
                  {t("creative.import.undo")}
                </Button>
              )}
              <Button disabled={busy} onClick={onClose}>
                {t("common.close")}
              </Button>
            </>
          ) : preview ? (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setPreview(null)
                  setError("")
                }}
              >
                {t("creative.import.editSources")}
              </Button>
              <Button
                disabled={busy || !selection.some((item) => item.noteIds.length > 0)}
                onClick={() => void apply()}
              >
                {t("creative.import.apply")}
              </Button>
            </>
          ) : (
            <Button
              disabled={
                busy || !requestSources.every((source) => source.sourceId && source.sectionId)
              }
              onClick={() => void prepare()}
            >
              {t("creative.import.preview")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
