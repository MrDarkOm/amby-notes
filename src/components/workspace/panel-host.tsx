"use client"

import { useTranslation } from "react-i18next"
import type { PanelId, PanelRenderProps, Side } from "./panel-registry"
import { PANEL_DEFS } from "./panel-definitions"

interface PanelHostProps {
  side: Side
  activeId: PanelId | null
  props: PanelRenderProps
}

/** Thin wrapper around the active PanelDef.render. Provides shared chrome. */
export function PanelHost({ side, activeId, props }: PanelHostProps) {
  const { t } = useTranslation()
  const def = activeId ? PANEL_DEFS.find((d) => d.id === activeId) : undefined
  return (
    <div
      className={`amby-panel-host mb-2 mt-0 flex h-[calc(100%-0.5rem)] min-h-0 w-[calc(100%-0.5rem)] flex-col overflow-hidden rounded-xl border border-border/80 bg-card/70 ${side === "left" ? "ml-0 mr-2" : "ml-2 mr-0"}`}
    >
      {def ? (
        def.render(props)
      ) : (
        <div className="flex h-full items-center justify-center px-4 text-center">
          <p className="text-[11px] text-muted-foreground">{t("panelHost.noPanel")}</p>
        </div>
      )}
    </div>
  )
}
