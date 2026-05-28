"use client"

import * as React from "react"
import { Bell, Check, HelpCircle, Settings } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  /** Available presets (left bar only) for the workspace switcher. */
  presets?: { id: string; label: string }[]
  activePresetId?: string
  onSwitchPreset?: (id: string) => void
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
  presets,
  activePresetId,
  onSwitchPreset,
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title="Пресет рабочего пространства"
                  className="flex size-8 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
                >
                  <Settings className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="right"
                align="end"
                className="w-48 border-zinc-800 bg-black text-zinc-300"
              >
                <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-zinc-500">
                  Пресет
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="bg-zinc-800" />
                {(presets ?? []).map(preset => (
                  <DropdownMenuItem
                    key={preset.id}
                    onSelect={() => onSwitchPreset?.(preset.id)}
                    className="flex items-center gap-2 text-[13px] focus:bg-zinc-800 focus:text-white"
                  >
                    <Check
                      className={cn(
                        "size-3.5",
                        preset.id === activePresetId ? "text-sky-400 opacity-100" : "opacity-0",
                      )}
                    />
                    {preset.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
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
