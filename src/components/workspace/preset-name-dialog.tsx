"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"

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

/** Asks for the name of a new preset; the dock's preset menu opens it. */
export function PresetNameDialog({
  open,
  initialName,
  onClose,
  onConfirm,
}: {
  open: boolean
  initialName: string
  onClose: () => void
  onConfirm: (name: string) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = React.useState(initialName)
  React.useEffect(() => {
    if (open) setName(initialName)
  }, [initialName, open])
  const trimmed = name.trim()

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-sm border-border bg-background text-foreground">
        <DialogHeader>
          <DialogTitle>{t("presets.nameTitle")}</DialogTitle>
          <DialogDescription>{t("presets.nameDescription")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!trimmed) return
            onConfirm(trimmed)
            onClose()
          }}
        >
          <Input
            autoFocus
            value={name}
            aria-label={t("presets.nameTitle")}
            onChange={(event) => setName(event.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("newItem.cancel")}
            </Button>
            <Button type="submit" disabled={!trimmed}>
              {t("presets.nameConfirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
