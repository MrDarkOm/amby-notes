"use client"

import { useTranslation } from "react-i18next"
import type { PanelId, PanelRenderProps, Side } from "./panel-registry"
import { PANEL_DEFS } from "./panel-definitions"

interface PanelHostProps {
  side: Side
  activeId: PanelId | null
  props: PanelRenderProps
  flush?: boolean
}

/** Thin wrapper around the active PanelDef.render. Provides shared chrome. */
export function PanelHost({ side, activeId, props, flush = false }: PanelHostProps) {
  const { t } = useTranslation()
  const def = activeId ? PANEL_DEFS.find((d) => d.id === activeId) : undefined
  return (
    <div
      className={`amby-panel-shell mt-0 min-h-0 rounded-xl ${
        flush
          ? "h-full w-full"
          : `mb-2 h-[calc(100%-0.5rem)] w-[calc(100%-0.5rem)] ${side === "left" ? "ml-0 mr-2" : "ml-2 mr-0"}`
      }`}
    >
      <div className="amby-panel-host flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border/80 bg-card/70">
        {def ? (
          def.render(props)
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center">
            <p className="text-[11px] text-muted-foreground">{t("panelHost.noPanel")}</p>
          </div>
        )}
      </div>
    </div>
  )
}
