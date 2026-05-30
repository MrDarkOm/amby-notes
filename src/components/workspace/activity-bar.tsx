"use client"

import * as React from "react"
import { Bell, Check, Download, HelpCircle, Settings, Upload } from "lucide-react"
import { useTranslation } from "react-i18next"

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
  onImportPreset?: () => void
  onExportPreset?: () => void
  /** Whether the panel layout is shared globally or kept per-workspace. */
  panelScope?: "global" | "workspace"
  onSetPanelScope?: (scope: "global" | "workspace") => void
  /** Opens the application settings dialog (left bar only). */
  onOpenSettings?: () => void
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
  onImportPreset,
  onExportPreset,
  panelScope,
  onSetPanelScope,
  onOpenSettings,
}: ActivityBarProps) {
  const { t } = useTranslation()
  const sideButtons = buttonsForSide(buttons, side)

  return (
    <div
      data-activity-bar={side}
      className={cn(
        "flex w-11 shrink-0 flex-col bg-background",
        side === "left" ? "border-r" : "border-l",
        "border-border",
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
                  title={t(def.labelKey)}
                  data-activity-button={def.id}
                  data-dragging={isDragging || undefined}
                  onPointerDown={onPointerDownButton(def.id)}
                  onClick={() => onActivate(def.id)}
                  className={cn(
                    "amby-activity-button",
                    "flex size-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-white",
                    isActive && "bg-accent text-white",
                  )}
                >
                  <Icon className="size-4" />
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-52 border-border bg-popover text-foreground">
                <ContextMenuItem
                  className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                  onSelect={() => onMoveToOtherSide(def.id)}
                >
                  {side === "left" ? t("activityBar.moveRight") : t("activityBar.moveLeft")}
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
              title={t("activityBar.notifications")}
              className="flex size-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-white"
            >
              <Bell className="size-4" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title={t("activityBar.presetMenu")}
                  className="flex size-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-white"
                >
                  <Settings className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="right"
                align="end"
                className="w-48 border-border bg-popover text-foreground"
              >
                {onOpenSettings && (
                  <>
                    <DropdownMenuItem
                      onSelect={onOpenSettings}
                      className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                    >
                      <Settings className="size-3.5 text-muted-foreground" />
                      {t("activityBar.settings")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className="bg-accent" />
                  </>
                )}
                <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  {t("activityBar.presetSection")}
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="bg-accent" />
                {(presets ?? []).map(preset => (
                  <DropdownMenuItem
                    key={preset.id}
                    onSelect={() => onSwitchPreset?.(preset.id)}
                    className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
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
                {(onExportPreset || onImportPreset) && (
                  <DropdownMenuSeparator className="bg-accent" />
                )}
                {onExportPreset && (
                  <DropdownMenuItem
                    onSelect={onExportPreset}
                    className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                  >
                    <Download className="size-3.5 text-muted-foreground" />
                    {t("activityBar.exportCurrent")}
                  </DropdownMenuItem>
                )}
                {onImportPreset && (
                  <DropdownMenuItem
                    onSelect={onImportPreset}
                    className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                  >
                    <Upload className="size-3.5 text-muted-foreground" />
                    {t("activityBar.importPreset")}
                  </DropdownMenuItem>
                )}
                {onSetPanelScope && (
                  <>
                    <DropdownMenuSeparator className="bg-accent" />
                    <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      {t("activityBar.layoutSection")}
                    </DropdownMenuLabel>
                    {([
                      { id: "global", labelKey: "activityBar.layoutGlobal" },
                      { id: "workspace", labelKey: "activityBar.layoutWorkspace" },
                    ] as const).map(opt => (
                      <DropdownMenuItem
                        key={opt.id}
                        onSelect={() => onSetPanelScope(opt.id)}
                        className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                      >
                        <Check
                          className={cn(
                            "size-3.5",
                            opt.id === panelScope ? "text-sky-400 opacity-100" : "opacity-0",
                          )}
                        />
                        {t(opt.labelKey)}
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              title={t("activityBar.help")}
              className="flex size-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-white"
            >
              <HelpCircle className="size-4" />
            </button>
            <div className="mt-1 size-7 rounded-full bg-gradient-to-br from-amber-500 to-orange-600" title={t("activityBar.account")} />
          </div>
        </>
      )}
    </div>
  )
}
