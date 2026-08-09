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
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}

/** A destructive-action confirmation whose opt-out is persisted by the caller. */
export function DeleteConfirmationDialog({
  name,
  onCancel,
  onConfirm,
}: DeleteConfirmationDialogProps) {
  const t = i18n.t.bind(i18n)
  const [dontAskAgain, setDontAskAgain] = React.useState(false)
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
