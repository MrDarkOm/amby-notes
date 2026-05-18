"use client"

import { cn } from "@/lib/utils"
import {
  PANEL_DEFS,
  type PanelId,
  type PanelRenderProps,
  type Side,
} from "./panel-registry"

interface PanelHostProps {
  side: Side
  activeId: PanelId | null
  props: PanelRenderProps
}

/** Thin wrapper around the active PanelDef.render. Provides shared chrome. */
export function PanelHost({ side, activeId, props }: PanelHostProps) {
  const def = activeId ? PANEL_DEFS.find(d => d.id === activeId) : undefined
  return (
    <div
      className={cn(
        "flex h-full min-h-0 w-full flex-col bg-[#0A0A0A]",
        side === "left" ? "border-r" : "border-l",
        "border-zinc-800",
      )}
    >
      {def ? (
        def.render(props)
      ) : (
        <div className="flex h-full items-center justify-center px-4 text-center">
          <p className="text-[11px] text-zinc-600">Нет активной панели</p>
        </div>
      )}
    </div>
  )
}
