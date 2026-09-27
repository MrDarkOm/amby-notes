"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ProfileSelector } from "./profile-selector"
import type { ProfileId } from "@/lib/modules"

export interface WorkspaceProfileModalProps {
  open: boolean
  workspaceName?: string
  initialProfileId?: ProfileId
  onConfirm: (profileId: ProfileId) => void
  onCancel: () => void
}

export function WorkspaceProfileModal({
  open,
  workspaceName,
  initialProfileId = "standard",
  onConfirm,
  onCancel,
}: WorkspaceProfileModalProps) {
  const { t } = useTranslation()
  const [selectedProfile, setSelectedProfile] = React.useState<ProfileId>(initialProfileId)

  React.useEffect(() => {
    if (open) {
      setSelectedProfile(initialProfileId)
    }
  }, [open, initialProfileId])

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-2xl border-border bg-card p-6 shadow-xl">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold text-foreground">
            {workspaceName
              ? `${t("profiles.initialSelection.title")}: ${workspaceName}`
              : t("profiles.initialSelection.title")}
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs text-muted-foreground">
            {t("profiles.initialSelection.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <ProfileSelector
            selectedProfileId={selectedProfile}
            onSelectProfile={setSelectedProfile}
          />
        </div>

        <DialogFooter className="flex items-center justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t("profiles.initialSelection.cancel")}
          </Button>
          <Button size="sm" onClick={() => onConfirm(selectedProfile)}>
            {t("profiles.initialSelection.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
