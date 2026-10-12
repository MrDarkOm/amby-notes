"use client"

import { Database, FileText, FolderPlus, LayoutGrid, PenLine } from "lucide-react"
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
  canCreateDatabase?: boolean
  canvasEnabled?: boolean
  sketchEnabled?: boolean
}

export function NewItemModal({
  open,
  onClose,
  onCreateNote,
  onCreateFolder,
  onCreateCanvas,
  onCreateSketch,
  onCreateDatabase,
  canCreateDatabase = false,
  canvasEnabled = true,
  sketchEnabled = true,
}: NewItemModalProps) {
  const { t } = useTranslation()
  // What a switched-off module would create is not offered at all.
  const items = [
    { id: "note", icon: FileText, desc: t("newItem.noteDesc"), run: onCreateNote },
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
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-md border-border bg-background text-foreground">
        <DialogHeader>
          <DialogTitle>{t("newItem.title")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          {items.map(({ id, icon: Icon, desc, run }) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                onClose()
                run()
              }}
              className="flex items-start gap-3 rounded-lg border border-border p-3 text-left hover:border-primary/40 hover:bg-accent/30"
            >
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
