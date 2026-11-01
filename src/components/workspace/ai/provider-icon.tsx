"use client"

import { useTranslation } from "react-i18next"
import { Cloud, HardDrive } from "lucide-react"
import { cn } from "@/lib/utils"
import { hasProviderMark, markMarkup, modelMark, PROVIDER_MARK } from "./provider-marks"

/**
 * The mark of a model's family, else of its provider, in the current text color. A provider without a mark of its own gets
 * the cloud or disk icon, which says where the model runs. `label` names the provider for screen
 * readers; without it the mark is decoration next to a name.
 */
export function ProviderIcon({
  providerId,
  kind,
  label,
  className,
  modelId,
}: {
  providerId: string
  kind: "local" | "cloud"
  label?: string
  /** A model of the provider: when its family has a mark of its own, that mark is drawn. */
  modelId?: string
  className?: string
}) {
  const { t } = useTranslation()
  const classes = cn("size-4 shrink-0", className)
  const family = modelMark(modelId)
  const mark = family ?? (hasProviderMark(providerId) ? PROVIDER_MARK[providerId] : null)
  if (mark) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        fillRule="evenodd"
        className={classes}
        {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
        // Static markup of a bundled constant, never user input.
        dangerouslySetInnerHTML={{ __html: markMarkup(mark) }}
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
