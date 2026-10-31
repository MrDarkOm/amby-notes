"use client"

import { useTranslation } from "react-i18next"
import { Cloud, HardDrive } from "lucide-react"
import { cn } from "@/lib/utils"
import { hasProviderMark, markMarkup, PROVIDER_MARK } from "./provider-marks"

/**
 * The mark of a provider in the current text color. A provider without a mark of its own gets
 * the cloud or disk icon, which says where the model runs. `label` names the provider for screen
 * readers; without it the mark is decoration next to a name.
 */
export function ProviderIcon({
  providerId,
  kind,
  label,
  className,
}: {
  providerId: string
  kind: "local" | "cloud"
  label?: string
  className?: string
}) {
  const { t } = useTranslation()
  const classes = cn("size-4 shrink-0", className)
  if (hasProviderMark(providerId)) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        fillRule="evenodd"
        className={classes}
        {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
        // Static markup of a bundled constant, never user input.
        dangerouslySetInnerHTML={{ __html: markMarkup(PROVIDER_MARK[providerId]) }}
      />
    )
  }
  const Icon = kind === "local" ? HardDrive : Cloud
  return (
    <Icon
      role="img"
      aria-label={t(kind === "local" ? "ai.localModel" : "ai.cloudModel")}
      className={classes}
    />
  )
}
