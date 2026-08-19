"use client"

import { useTranslation } from "react-i18next"

export function ComingSoonPanel({ labelKey }: { labelKey: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <p className="text-[12px] text-muted-foreground">{t(labelKey)}</p>
      <p className="text-[11px] text-muted-foreground">{t("common.comingSoon")}</p>
    </div>
  )
}
