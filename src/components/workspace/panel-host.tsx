"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import type { PanelId, PanelRenderProps, Side } from "./panel-registry"
import { PANEL_DEFS } from "./panel-definitions"

interface PanelHostProps {
  side: Side
  activeId: PanelId | null
  props: PanelRenderProps
  flush?: boolean
}

interface PanelSlotProps {
  definition: (typeof PANEL_DEFS)[number]
  props: PanelRenderProps
  active: boolean
}

/**
 * Hidden panels keep their last rendered subtree. Workspace props change with
 * the active note, but there is no reason to update every panel the user has
 * visited until that panel becomes visible again.
 */
const PanelContent = React.memo(
  function PanelContent({ definition, props }: PanelSlotProps) {
    return definition.render(props)
  },
  (previous, next) => {
    if (!next.active) return true
    return (
      previous.definition === next.definition &&
      previous.props === next.props &&
      previous.active === next.active
    )
  },
)

/** Thin wrapper around the active PanelDef.render. Provides shared chrome. */
export function PanelHost({ side, activeId, props, flush = false }: PanelHostProps) {
  const { t } = useTranslation()
  // Keep panels mounted after their first visit. History and properties both
  // own async data and scrollable content; remounting them on every activity
  // button click makes the switch feel like a reload.
  const [visitedIds, setVisitedIds] = React.useState<PanelId[]>(() => (activeId ? [activeId] : []))
  React.useEffect(() => {
    if (!activeId) return
    setVisitedIds((current) => (current.includes(activeId) ? current : [...current, activeId]))
  }, [activeId])

  const visibleIds = new Set(visitedIds)
  if (activeId) visibleIds.add(activeId)
  const cachedDefs = PANEL_DEFS.filter((definition) => visibleIds.has(definition.id))
  return (
    <div
      className={`amby-panel-shell mt-0 min-h-0 rounded-xl ${
        flush
          ? "h-full w-full"
          : `mb-2 h-[calc(100%-0.5rem)] w-[calc(100%-0.5rem)] ${side === "left" ? "ml-0 mr-2" : "ml-2 mr-0"}`
      }`}
    >
      <div className="amby-panel-host relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border/80">
        {activeId && cachedDefs.length > 0 ? (
          cachedDefs.map((definition) => {
            const active = definition.id === activeId
            return (
              <div
                key={definition.id}
                aria-hidden={!active}
                className={
                  active
                    ? "flex h-full min-h-0 flex-col"
                    : "invisible pointer-events-none absolute inset-0 flex h-full min-h-0 flex-col"
                }
              >
                <PanelContent definition={definition} props={props} active={active} />
              </div>
            )
          })
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center">
            <p className="text-[11px] text-muted-foreground">{t("panelHost.noPanel")}</p>
          </div>
        )}
      </div>
    </div>
  )
}
