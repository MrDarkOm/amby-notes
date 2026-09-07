"use client"

import { useTranslation } from "react-i18next"
import { PanelHeader } from "./panel-header"

export function ComingSoonPanel({ labelKey }: { labelKey: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title={t(labelKey)} />
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <p className="text-[11px] text-muted-foreground">{t("common.comingSoon")}</p>
      </div>
    </div>
  )
}
