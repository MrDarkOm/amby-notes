"use client"

import { useTranslation } from "react-i18next"
import { Map, Minimize2 } from "lucide-react"
import { MiniMap } from "@xyflow/react"

export interface CanvasMinimapPanelProps {
  maskColor: string
  nodeColor: string
  isOpen: boolean
  onToggle: () => void
}

export function CanvasMinimapPanel({
  maskColor,
  nodeColor,
  isOpen,
  onToggle,
}: CanvasMinimapPanelProps) {
  const { t } = useTranslation()

  if (!isOpen) {
    return (
      <div className="absolute bottom-14 right-4 z-10 select-none">
        <button
          type="button"
          title={t("canvas.showMinimap")}
          onClick={onToggle}
          className="flex size-8 items-center justify-center rounded-xl border border-border/80 bg-card/90 text-foreground shadow-md backdrop-blur-md hover:bg-accent hover:text-accent-foreground"
        >
          <Map className="size-4" />
        </button>
      </div>
    )
  }

  return (
    <div className="absolute bottom-14 right-4 z-10 select-none overflow-hidden rounded-xl border border-border/80 bg-card/90 p-1 shadow-md backdrop-blur-md">
      <button
        type="button"
        title={t("canvas.hideMinimap")}
        onClick={onToggle}
        className="absolute top-2 right-2 z-20 flex size-8 items-center justify-center rounded-xl border border-border/80 bg-card/90 text-foreground shadow-md backdrop-blur-md hover:bg-accent hover:text-accent-foreground"
      >
        <Minimize2 className="size-4" />
      </button>
      <div className="overflow-hidden rounded-lg border border-border/60">
        <MiniMap
          className="!relative !inset-auto !m-0 !border-none !bg-card"
          maskColor={maskColor}
          nodeColor={nodeColor}
          pannable
          zoomable
        />
      </div>
    </div>
  )
}
