"use client"

import * as React from "react"
import i18n from "@/lib/i18n"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface DeleteConfirmationDialogProps {
  name: string
  isDirtyOrConflicted?: boolean
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
  onArchive?: () => void
  onKeepRecovery?: () => void
  onDiscard?: () => void
}

/** A destructive-action confirmation whose opt-out is persisted by the caller. */
export function DeleteConfirmationDialog({
  name,
  isDirtyOrConflicted = false,
  onCancel,
  onConfirm,
  onArchive,
  onKeepRecovery,
  onDiscard,
}: DeleteConfirmationDialogProps) {
  const t = i18n.t.bind(i18n)
  const [dontAskAgain, setDontAskAgain] = React.useState(false)

  if (isDirtyOrConflicted) {
    return (
      <Dialog open onOpenChange={(open) => !open && onCancel()}>
        <DialogContent
          showCloseButton={false}
          className="w-96 border-border bg-popover p-5 text-foreground"
        >
          <DialogHeader>
            <DialogTitle className="text-base">{t("workspace.deleteDirtyTitle")}</DialogTitle>
            <DialogDescription>{t("workspace.deleteDirtyConfirm", { name })}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-wrap gap-2">
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
              onClick={onCancel}
            >
              {t("docEditor.cancel")}
            </button>
            <button
              type="button"
              className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
              onClick={onDiscard}
            >
              {t("workspace.deleteDiscard")}
            </button>
            <button
              type="button"
              autoFocus
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              onClick={onKeepRecovery}
            >
              {t("workspace.deleteKeepRecovery")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        showCloseButton={false}
        className="w-80 border-border bg-popover p-5 text-foreground"
      >
        <DialogHeader>
          <DialogTitle className="text-base">{t("workspace.deleteTitle")}</DialogTitle>
          <DialogDescription>{t("workspace.deleteConfirm", { name })}</DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(event) => setDontAskAgain(event.target.checked)}
            className="size-3.5 accent-primary"
          />
          {t("workspace.dontAskAgain")}
        </label>
        <DialogFooter>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
            onClick={onCancel}
          >
            {t("docEditor.cancel")}
          </button>
          <button
            type="button"
            autoFocus
            className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
            onClick={() => onConfirm(dontAskAgain)}
          >
            {t("docEditor.delete")}
          </button>
          {onArchive && (
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
              onClick={onArchive}
            >
              {t("workspace.archive")}
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
