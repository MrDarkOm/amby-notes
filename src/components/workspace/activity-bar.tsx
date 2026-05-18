"use client"

import * as React from "react"
import { Bell, HelpCircle, Settings } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  ACTION_DEFS,
  PANEL_DEFS,
  type ActivityButton,
  type ButtonDef,
  type PanelId,
  type Side,
  buttonsForSide,
} from "./panel-registry"

interface ActivityBarProps {
  side: Side
  buttons: ActivityButton[]
  activeView: PanelId | null
  onActivate: (defId: string) => void
  onMoveToOtherSide: (defId: string) => void
  onPointerDownButton: (defId: string) => (e: React.PointerEvent<HTMLElement>) => void
  draggingId: string | null
}

function findDef(defId: string): ButtonDef | undefined {
  return PANEL_DEFS.find(d => d.id === defId) ?? ACTION_DEFS.find(d => d.id === defId)
}

export function ActivityBar({
  side,
  buttons,
  activeView,
  onActivate,
  onMoveToOtherSide,
  onPointerDownButton,
  draggingId,
}: ActivityBarProps) {
  const sideButtons = buttonsForSide(buttons, side)

  return (
    <div
      data-activity-bar={side}
      className={cn(
        "flex w-11 shrink-0 flex-col bg-[#0A0A0A]",
        side === "left" ? "border-r" : "border-l",
        "border-zinc-800",
      )}
    >
      {/* Configurable buttons */}
      <div className="flex flex-col items-center gap-0.5 py-2">
        {sideButtons.map(button => {
          const def = findDef(button.defId)
          if (!def) return null
          const isView = def.kind === "view"
          const isActive = isView && activeView === def.id
          const isDragging = draggingId === def.id
          const Icon = def.icon
          return (
            <ContextMenu key={def.id}>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  title={def.label}
                  data-activity-button={def.id}
                  data-dragging={isDragging || undefined}
                  onPointerDown={onPointerDownButton(def.id)}
                  onClick={() => onActivate(def.id)}
                  className={cn(
                    "amby-activity-button",
                    "flex size-8 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white",
                    isActive && "bg-zinc-800 text-white",
                  )}
                >
                  <Icon className="size-4" />
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-52 border-zinc-800 bg-black text-zinc-300">
                <ContextMenuItem
                  className="flex items-center gap-2 text-[13px] focus:bg-zinc-800 focus:text-white"
                  onSelect={() => onMoveToOtherSide(def.id)}
                >
                  {side === "left" ? "Переместить вправо" : "Переместить влево"}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}
      </div>

      {/* System buttons pinned to the bottom (only on left side) */}
      {side === "left" && (
        <>
          <div className="flex-1" />
          <div className="flex flex-col items-center gap-0.5 py-2">
            <button
              type="button"
              title="Уведомления"
              className="flex size-8 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              <Bell className="size-4" />
            </button>
            <button
              type="button"
              title="Настройки"
              className="flex size-8 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              <Settings className="size-4" />
            </button>
            <button
              type="button"
              title="Справка"
              className="flex size-8 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              <HelpCircle className="size-4" />
            </button>
            <div className="mt-1 size-7 rounded-full bg-gradient-to-br from-amber-500 to-orange-600" title="Аккаунт" />
          </div>
        </>
      )}
    </div>
  )
}
