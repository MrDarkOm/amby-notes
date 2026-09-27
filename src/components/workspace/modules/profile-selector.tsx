"use client"

import { useTranslation } from "react-i18next"
import { Check, Download, HardDrive, Shield, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatByteSize, PROFILES, type ProfileId } from "@/lib/modules"

export interface ProfileSelectorProps {
  selectedProfileId: ProfileId
  onSelectProfile: (id: ProfileId) => void
  isOnline?: boolean
  className?: string
}

export function ProfileSelector({
  selectedProfileId,
  onSelectProfile,
  isOnline = true,
  className,
}: ProfileSelectorProps) {
  const { t } = useTranslation()

  const profileList: ProfileId[] = ["minimal", "standard", "custom"]

  return (
    <div className={cn("space-y-4", className)}>
      <div className="grid gap-3 sm:grid-cols-3">
        {profileList.map((id) => {
          const profile = PROFILES[id]
          const isSelected = selectedProfileId === id
          const isStandard = id === "standard"
          const isMinimal = id === "minimal"

          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelectProfile(id)}
              className={cn(
                "relative flex flex-col justify-between rounded-lg border p-4 text-left",
                isSelected
                  ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary"
                  : "border-border bg-card text-muted-foreground hover:border-border/80 hover:bg-accent/40",
              )}
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-foreground">
                    {t(profile.labelKey)}
                  </span>
                  {isSelected && (
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="size-3" />
                    </span>
                  )}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {t(profile.descriptionKey)}
                </p>
              </div>

              <div className="mt-4 space-y-1.5 border-t border-border/50 pt-3 text-[11px]">
                {isStandard && (
                  <>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Download className="size-3" />
                      <span>{t("profiles.details.downloadSize")}:</span>
                      <span className="font-mono font-medium text-foreground">
                        {formatByteSize(profile.metadata.estimatedDownloadSizeBytes)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <HardDrive className="size-3" />
                      <span>{t("profiles.details.installedSize")}:</span>
                      <span className="font-mono font-medium text-foreground">
                        {formatByteSize(profile.metadata.estimatedInstalledSizeBytes)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Shield className="size-3" />
                      <span>{t("profiles.details.permissions")}:</span>
                      <span className="font-medium text-foreground">
                        {profile.metadata.permissions.length}
                      </span>
                    </div>
                  </>
                )}
                {isMinimal && (
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Sparkles className="size-3 text-primary" />
                    <span className="font-medium text-foreground">{formatByteSize(0)}</span>
                  </div>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {!isOnline && selectedProfileId === "standard" && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
          {t("profiles.details.offlineFallbackNotice")}
        </div>
      )}
    </div>
  )
}
