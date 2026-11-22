"use client"

import { Calendar, Database, FileText, Files, FolderPlus, LayoutGrid, PenLine } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"

interface NewItemModalProps {
  open: boolean
  onClose: () => void
  onCreateNote: () => void
  onCreateFolder: () => void
  onCreateCanvas: () => void
  onCreateSketch: () => void
  onCreateDatabase?: () => void
  /** A note from a template; offered next to the note while the Templates module is on. */
  onCreateFromTemplate?: () => void
  /** Today's note; offered next to the note while the Daily notes module is on. */
  onCreateDaily?: () => void
  canCreateDatabase?: boolean
  canvasEnabled?: boolean
  sketchEnabled?: boolean
}

const ROW =
  "flex items-start gap-3 rounded-lg border border-border p-3 text-left hover:border-primary/40 hover:bg-accent/30"

export function NewItemModal({
  open,
  onClose,
  onCreateNote,
  onCreateFolder,
  onCreateCanvas,
  onCreateSketch,
  onCreateDatabase,
  onCreateFromTemplate,
  onCreateDaily,
  canCreateDatabase = false,
  canvasEnabled = true,
  sketchEnabled = true,
}: NewItemModalProps) {
  const { t } = useTranslation()
  const run = (action: () => void) => {
    onClose()
    action()
  }
  // What a switched-off module would create is not offered at all.
  const items = [
    { id: "folder", icon: FolderPlus, desc: t("newItem.folderDesc"), run: onCreateFolder },
    canvasEnabled
      ? { id: "canvas", icon: LayoutGrid, desc: t("newItem.canvasDesc"), run: onCreateCanvas }
      : null,
    sketchEnabled
      ? { id: "sketch", icon: PenLine, desc: t("newItem.sketchDesc"), run: onCreateSketch }
      : null,
    canCreateDatabase && onCreateDatabase
      ? { id: "database", icon: Database, desc: t("newItem.databaseDesc"), run: onCreateDatabase }
      : null,
  ].filter((item) => item !== null)
  // The kinds of note sit beside the note itself: from a template, and today's note.
  const noteKinds = [
    onCreateFromTemplate
      ? {
          id: "template",
          icon: Files,
          label: t("newItem.template"),
          short: t("newItem.templateShort"),
          run: onCreateFromTemplate,
        }
      : null,
    onCreateDaily
      ? {
          id: "daily",
          icon: Calendar,
          label: t("newItem.daily"),
          short: t("newItem.dailyShort"),
          run: onCreateDaily,
        }
      : null,
  ].filter((kind) => kind !== null)
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-md border-border bg-background text-foreground">
        <DialogHeader>
          <DialogTitle>{t("newItem.title")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          <div className="flex gap-2">
            <button type="button" onClick={() => run(onCreateNote)} className={`${ROW} flex-1`}>
              <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm font-medium">{t("newItem.note")}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {t("newItem.noteDesc")}
                </span>
              </span>
            </button>
            {noteKinds.map(({ id, icon: Icon, label, short, run: action }) => (
              <button
                key={id}
                type="button"
                title={label}
                aria-label={label}
                data-new-item={id}
                onClick={() => run(action)}
                className="flex w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-lg px-1 border border-border text-muted-foreground hover:border-primary/40 hover:bg-accent/30 hover:text-foreground"
              >
                <Icon className="size-4" />
                <span className="max-w-full truncate text-[11px] leading-none">{short}</span>
              </button>
            ))}
          </div>
          {items.map(({ id, icon: Icon, desc, run: action }) => (
            <button key={id} type="button" onClick={() => run(action)} className={ROW}>
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm font-medium">{t(`newItem.${id}`)}</span>
                <span className="truncate text-xs text-muted-foreground">{desc}</span>
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
