import * as React from "react"
import { useTranslation } from "react-i18next"
import { Files, Plus } from "lucide-react"
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
import { cn } from "@/lib/utils"
import { logger } from "@/lib/logger"
import { operationErrorCode } from "@/lib/operation-errors"
import { listNoteTemplates, type NoteTemplate } from "@/lib/storage"
import { NoticeLine } from "../notices/notice-line"
import { useNoteModulesStore } from "./note-modules-store"

interface TemplateNoteDialogProps {
  /** Makes the note and opens it; rejects when it cannot be made. */
  onCreate: (parentPath: string | null, name: string, template: string) => Promise<void>
  /** Makes a template in the templates folder and opens it; rejects when it cannot be made. */
  onCreateTemplate: (name: string) => Promise<void>
}

/** The placeholders as written in a template, shown literally in the explanation. */
const PLACEHOLDER_TAGS = {
  titleTag: "{{title}}",
  dateTag: "{{date}}",
  timeTag: "{{time}}",
  interpolation: { escapeValue: false },
}

type Listing =
  { state: "loading" } | { state: "failed" } | { state: "ready"; items: NoteTemplate[] }

/**
 * Asks for the name of the new note and the template to start it from, or, in its second mode,
 * for the name of a new template (offered first when there is none yet).
 */
export function TemplateNoteDialog({ onCreate, onCreateTemplate }: TemplateNoteDialogProps) {
  const { t } = useTranslation()
  const open = useNoteModulesStore((state) => state.open)
  const parentPath = useNoteModulesStore((state) => state.parentPath)
  const close = useNoteModulesStore((state) => state.close)
  const [listing, setListing] = React.useState<Listing>({ state: "loading" })
  const [template, setTemplate] = React.useState<string | null>(null)
  const [name, setName] = React.useState("")
  const [nameMissing, setNameMissing] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [mode, setMode] = React.useState<"note" | "template">("note")

  React.useEffect(() => {
    if (!open) return
    let current = true
    setListing({ state: "loading" })
    setTemplate(null)
    setName(t("defaults.untitled"))
    setNameMissing(false)
    setFailed(false)
    setMode("note")
    listNoteTemplates()
      .then((items) => {
        if (!current) return
        setListing({ state: "ready", items })
        setTemplate(items[0]?.name ?? null)
      })
      .catch((error: unknown) => {
        logger.warn("templates.list_failed", { failureCode: operationErrorCode(error) })
        if (current) setListing({ state: "failed" })
      })
    return () => {
      current = false
    }
  }, [open, t])

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || (mode === "note" && !template)) return
    const trimmed = name.trim()
    if (!trimmed) {
      setNameMissing(true)
      return
    }
    setBusy(true)
    setFailed(false)
    try {
      if (mode === "template") await onCreateTemplate(trimmed)
      else if (template) await onCreate(parentPath, trimmed, template)
      close()
    } catch (error) {
      logger.warn("templates.create_failed", { failureCode: operationErrorCode(error) })
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const items = listing.state === "ready" ? listing.items : []
  const startTemplate = () => {
    setMode("template")
    setName("")
    setNameMissing(false)
    setFailed(false)
  }
  const inTemplateMode = mode === "template"
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-md border-border bg-background text-foreground">
        <DialogHeader>
          <DialogTitle>
            {t(inTemplateMode ? "templates.dialog.newTemplate" : "templates.dialog.title")}
          </DialogTitle>
          <DialogDescription>
            {inTemplateMode
              ? t("templates.dialog.newTemplateDescription", PLACEHOLDER_TAGS)
              : t("templates.dialog.description")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="template-note-name" className="text-sm font-medium">
              {t(inTemplateMode ? "templates.dialog.templateName" : "templates.dialog.name")}
            </label>
            <Input
              key={mode}
              id="template-note-name"
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setNameMissing(false)
                setFailed(false)
              }}
              aria-invalid={nameMissing}
            />
            {nameMissing && (
              <p className="text-xs text-destructive">{t("templates.dialog.nameRequired")}</p>
            )}
          </div>
          {!inTemplateMode && (
            <div className="space-y-2">
              <span className="text-sm font-medium" id="template-note-list">
                {t("templates.dialog.template")}
              </span>
              {listing.state === "loading" ? (
                <p className="text-xs text-muted-foreground">{t("templates.dialog.loading")}</p>
              ) : listing.state === "failed" ? (
                <NoticeLine role="alert" text={t("templates.dialog.listFailed")} />
              ) : items.length === 0 ? (
                <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border p-3">
                  <p className="text-xs text-muted-foreground">{t("templates.dialog.empty")}</p>
                  <Button type="button" variant="outline" size="sm" onClick={startTemplate}>
                    <Plus className="size-3.5" />
                    {t("templates.dialog.createTemplate")}
                  </Button>
                </div>
              ) : (
                <div
                  role="radiogroup"
                  aria-labelledby="template-note-list"
                  className="grid max-h-60 gap-1 overflow-y-auto"
                >
                  {items.map((item) => (
                    <button
                      key={item.path}
                      type="button"
                      role="radio"
                      aria-checked={template === item.name}
                      onClick={() => setTemplate(item.name)}
                      className={cn(
                        "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm",
                        template === item.name
                          ? "border-primary/60 bg-accent/40"
                          : "border-border hover:bg-accent/30",
                      )}
                    >
                      <Files className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{item.name}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={startTemplate}
                    className="flex items-center gap-2 rounded-md border border-dashed border-border px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground"
                  >
                    <Plus className="size-3.5 shrink-0" />
                    <span className="truncate">{t("templates.dialog.newTemplate")}</span>
                  </button>
                </div>
              )}
            </div>
          )}
          {failed && (
            <NoticeLine
              role="alert"
              text={t(
                inTemplateMode
                  ? "templates.dialog.templateCreateFailed"
                  : "templates.dialog.createFailed",
              )}
            />
          )}
          <DialogFooter>
            {inTemplateMode && items.length > 0 ? (
              <Button type="button" variant="outline" onClick={() => setMode("note")}>
                {t("templates.dialog.back")}
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={close}>
                {t("newItem.cancel")}
              </Button>
            )}
            <Button type="submit" disabled={busy || (!inTemplateMode && !template)}>
              {t(inTemplateMode ? "templates.dialog.createTemplate" : "templates.dialog.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
