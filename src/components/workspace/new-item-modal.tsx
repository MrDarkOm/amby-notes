"use client"

import { Database, FileText, FolderPlus, LayoutGrid } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"

interface NewItemModalProps {
  open: boolean
  onClose: () => void
  onCreateNote: () => void
  onCreateFolder: () => void
  onCreateCanvas: () => void
}

export function NewItemModal({
  open,
  onClose,
  onCreateNote,
  onCreateFolder,
  onCreateCanvas,
}: NewItemModalProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-80 border-border bg-background p-0 text-foreground shadow-2xl">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-medium text-foreground">
            {t("newItem.title")}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 p-4">
          {/* Note */}
          <button
            onClick={() => {
              onClose()
              onCreateNote()
            }}
            className="flex flex-col items-center gap-2.5 rounded-lg border border-border bg-card px-4 py-5 text-center transition-colors hover:border-border hover:bg-accent"
          >
            <div className="flex size-10 items-center justify-center rounded-lg bg-accent">
              <FileText className="size-5 text-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">{t("newItem.note")}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{t("newItem.noteDesc")}</p>
            </div>
          </button>

          <button
            onClick={() => {
              onClose()
              onCreateFolder()
            }}
            className="flex flex-col items-center gap-2.5 rounded-lg border border-border bg-card px-4 py-5 text-center transition-colors hover:border-border hover:bg-accent"
          >
            <div className="flex size-10 items-center justify-center rounded-lg bg-accent">
              <FolderPlus className="size-5 text-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">{t("newItem.folder")}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{t("newItem.folderDesc")}</p>
            </div>
          </button>

          <button
            onClick={() => {
              onClose()
              onCreateCanvas()
            }}
            className="flex flex-col items-center gap-2.5 rounded-lg border border-border bg-card px-4 py-5 text-center transition-colors hover:border-border hover:bg-accent"
          >
            <div className="flex size-10 items-center justify-center rounded-lg bg-accent">
              <LayoutGrid className="size-5 text-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">{t("newItem.canvas")}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{t("newItem.canvasDesc")}</p>
            </div>
          </button>

          {/* Database — placeholder */}
          <div className="flex flex-col items-center gap-2.5 rounded-lg border border-border/50 bg-card/40 px-4 py-5 text-center opacity-50 cursor-not-allowed select-none">
            <div className="flex size-10 items-center justify-center rounded-lg bg-accent/60">
              <Database className="size-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">{t("newItem.database")}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{t("common.comingSoon")}</p>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
