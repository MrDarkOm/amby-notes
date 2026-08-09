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
      <DialogContent className="w-[calc(100vw-2rem)] max-w-sm border-border bg-background p-0 text-foreground shadow-2xl">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-medium text-foreground">
            {t("newItem.title")}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-5 gap-2 p-4">
          {/* Note */}
          <button
            onClick={() => {
              onClose()
              onCreateNote()
            }}
            title={t("newItem.note")}
            aria-label={t("newItem.note")}
            className="flex size-12 justify-self-center items-center justify-center rounded-lg border border-border bg-card text-center transition-colors hover:border-border hover:bg-accent"
          >
            <FileText className="size-5 text-foreground" />
          </button>

          <button
            onClick={() => {
              onClose()
              onCreateFolder()
            }}
            title={t("newItem.folder")}
            aria-label={t("newItem.folder")}
            className="flex size-12 justify-self-center items-center justify-center rounded-lg border border-border bg-card text-center transition-colors hover:border-border hover:bg-accent"
          >
            <FolderPlus className="size-5 text-foreground" />
          </button>

          <button
            onClick={() => {
              onClose()
              onCreateCanvas()
            }}
            title={t("newItem.canvas")}
            aria-label={t("newItem.canvas")}
            className="flex size-12 justify-self-center items-center justify-center rounded-lg border border-border bg-card text-center transition-colors hover:border-border hover:bg-accent"
          >
            <LayoutGrid className="size-5 text-foreground" />
          </button>

          <button
            type="button"
            disabled
            title={`${t("newItem.database")} · ${t("common.comingSoon")}`}
            aria-label={t("newItem.database")}
            className="flex size-12 justify-self-center items-center justify-center rounded-lg border border-border bg-card text-muted-foreground opacity-50"
          >
            <Database className="size-5" />
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
