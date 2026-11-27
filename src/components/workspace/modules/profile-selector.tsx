"use client"

import { useTranslation } from "react-i18next"
import {
  Check,
  Download,
  FileText,
  HardDrive,
  Layers,
  Shield,
  SlidersHorizontal,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { formatByteSize, PROFILES, type ProfileId } from "@/lib/modules"

export interface ProfileSelectorProps {
  selectedProfileId: ProfileId
  onSelectProfile: (id: ProfileId) => void
  isOnline?: boolean
  showDetails?: boolean
  className?: string
}

const PROFILE_ICONS = { minimal: FileText, standard: Layers, custom: SlidersHorizontal }
const PROFILE_LIST: ProfileId[] = ["minimal", "standard", "custom"]

export function ProfileSelector({
  selectedProfileId,
  onSelectProfile,
  isOnline = true,
  showDetails = true,
  className,
}: ProfileSelectorProps) {
  const { t } = useTranslation()
  const selected = PROFILES[selectedProfileId]

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-col gap-2">
        {PROFILE_LIST.map((id) => {
          const profile = PROFILES[id]
          const isSelected = selectedProfileId === id
          const Icon = PROFILE_ICONS[id]
          return (
            <button
              key={id}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onSelectProfile(id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-xl border p-4 text-left",
                isSelected
                  ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary"
                  : "border-border bg-card text-muted-foreground hover:border-border/80 hover:bg-accent/40",
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Icon className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-foreground">
                  {t(profile.labelKey)}
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  {t(profile.descriptionKey)}
                </span>
              </span>
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border",
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border",
                )}
              >
                {isSelected && <Check className="size-3" />}
              </span>
            </button>
          )
        })}
      </div>
      {showDetails && selectedProfileId === "standard" && (
        <div className="flex flex-wrap gap-x-4 gap-y-2 px-1 text-[11px] text-muted-foreground">
          <span
            className="inline-flex items-center gap-1.5 whitespace-nowrap"
            title={t("profiles.details.downloadSize")}
          >
            <Download className="size-3" />
            {formatByteSize(selected.metadata.estimatedDownloadSizeBytes)}
          </span>
          <span
            className="inline-flex items-center gap-1.5 whitespace-nowrap"
            title={t("profiles.details.installedSize")}
          >
            <HardDrive className="size-3" />
            {formatByteSize(selected.metadata.estimatedInstalledSizeBytes)}
          </span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <Shield className="size-3" />
            {t("profiles.details.permissions")}: {selected.metadata.permissions.length}
          </span>
        </div>
      )}
      {!isOnline && selectedProfileId === "standard" && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
          {t("profiles.details.offlineFallbackNotice")}
        </div>
      )}
    </div>
  )
}
