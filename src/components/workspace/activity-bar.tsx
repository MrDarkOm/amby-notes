"use client"

import * as React from "react"
import { Check, Download, Upload } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
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
import { type ActivityButton, type ButtonDef, type PanelId, type Side } from "./panel-registry"
import { ACTION_DEFS, PANEL_DEFS, buttonsForSide } from "./panel-definitions"

interface ActivityBarProps {
  side: Side
  buttons: ActivityButton[]
  activeView: PanelId | null
  onActivate: (defId: string) => void
  onMoveToOtherSide: (defId: string) => void
  onPointerDownButton: (defId: string) => (event: React.PointerEvent<HTMLElement>) => void
  draggingId: string | null
  presets?: { id: string; label: string }[]
  activePresetId?: string
  onSwitchPreset?: (id: string) => void
  onImportPreset?: () => void
  onExportPreset?: () => void
  panelScope?: "global" | "workspace"
  onSetPanelScope?: (scope: "global" | "workspace") => void
  pinned?: boolean
  onPinnedChange?: (pinned: boolean) => void
  onHide?: () => void
}

type ActivityZone = "view" | "action"

function findDef(defId: string): ButtonDef | undefined {
  return PANEL_DEFS.find((def) => def.id === defId) ?? ACTION_DEFS.find((def) => def.id === defId)
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
  pinned = true,
  onPinnedChange,
  onHide,
}: ActivityBarProps) {
  const { t } = useTranslation()
  const [isAutoHideHover, setIsAutoHideHover] = React.useState(false)
  const sideButtons = buttonsForSide(buttons, side)
  const viewButtons = sideButtons.filter((button) => findDef(button.defId)?.kind === "view")
  const actionButtons = sideButtons.filter((button) => findDef(button.defId)?.kind === "action")

  function presetMenu() {
    return (
      <DropdownMenuContent
        side={side === "left" ? "right" : "left"}
        align="end"
        className="w-52 border-border bg-popover text-foreground"
      >
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {t("activityBar.presetSection")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-border" />
        {(presets ?? []).map((preset) => (
          <DropdownMenuItem
            key={preset.id}
            onSelect={() => onSwitchPreset?.(preset.id)}
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-accent-foreground"
          >
            <Check
              className={cn(
                "size-3.5",
                preset.id === activePresetId ? "text-primary opacity-100" : "opacity-0",
              )}
            />
            {preset.label}
          </DropdownMenuItem>
        ))}
        {(onExportPreset || onImportPreset) && <DropdownMenuSeparator className="bg-border" />}
        {onExportPreset && (
          <DropdownMenuItem
            onSelect={onExportPreset}
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-accent-foreground"
          >
            <Download className="size-3.5 text-muted-foreground" />
            {t("activityBar.exportCurrent")}
          </DropdownMenuItem>
        )}
        {onImportPreset && (
          <DropdownMenuItem
            onSelect={onImportPreset}
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-accent-foreground"
          >
            <Upload className="size-3.5 text-muted-foreground" />
            {t("activityBar.importPreset")}
          </DropdownMenuItem>
        )}
        {onSetPanelScope && (
          <>
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
              {t("activityBar.layoutSection")}
            </DropdownMenuLabel>
            {(
              [
                { id: "global", labelKey: "activityBar.layoutGlobal" },
                { id: "workspace", labelKey: "activityBar.layoutWorkspace" },
              ] as const
            ).map((option) => (
              <DropdownMenuItem
                key={option.id}
                onSelect={() => onSetPanelScope(option.id)}
                className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-accent-foreground"
              >
                <Check
                  className={cn(
                    "size-3.5",
                    option.id === panelScope ? "text-primary opacity-100" : "opacity-0",
                  )}
                />
                {t(option.labelKey)}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    )
  }

  function dockMenuItems() {
    return (
      <>
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem checked={pinned} onCheckedChange={onPinnedChange}>
          {t("dock.pin")}
        </ContextMenuCheckboxItem>
        <ContextMenuItem onSelect={onHide}>{t("dock.hide")}</ContextMenuItem>
      </>
    )
  }

  function renderButton(button: ActivityButton, zone: ActivityZone) {
    const def = findDef(button.defId)
    if (!def) return null
    const isActive = def.kind === "view" && activeView === def.id
    const isDragging = draggingId === def.id
    const Icon = def.icon
    const label = t(def.labelKey)
    const element = (
      <button
        type="button"
        title={label}
        aria-label={label}
        data-activity-button={def.id}
        data-activity-zone={zone}
        data-dragging={isDragging || undefined}
        onPointerDown={onPointerDownButton(def.id)}
        onClick={def.id === "presets" ? undefined : () => onActivate(def.id)}
        className={cn(
          "amby-activity-button flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
          isActive && "bg-primary text-primary-foreground shadow-sm",
        )}
      >
        <Icon className="size-4" />
      </button>
    )

    return (
      <div key={def.id} className="relative flex">
        <ContextMenu>
          {def.id === "presets" ? (
            <DropdownMenu>
              <ContextMenuTrigger asChild>
                <DropdownMenuTrigger asChild>{element}</DropdownMenuTrigger>
              </ContextMenuTrigger>
              {presetMenu()}
            </DropdownMenu>
          ) : (
            <ContextMenuTrigger asChild>{element}</ContextMenuTrigger>
          )}
          <ContextMenuContent className="w-52 border-border bg-popover text-foreground">
            <ContextMenuItem
              className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-accent-foreground"
              onSelect={() => onMoveToOtherSide(def.id)}
            >
              {side === "left" ? t("activityBar.moveRight") : t("activityBar.moveLeft")}
            </ContextMenuItem>
            {dockMenuItems()}
          </ContextMenuContent>
        </ContextMenu>
      </div>
    )
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "relative shrink-0 transition-[width] duration-200",
            pinned || isAutoHideHover ? "w-12" : "w-1",
          )}
          onMouseEnter={() => setIsAutoHideHover(true)}
          onMouseLeave={() => setIsAutoHideHover(false)}
        >
          <div
            data-activity-bar={side}
            className={cn(
              "absolute inset-y-0 flex w-12 flex-col bg-background transition-transform duration-200 ease-out",
              side === "left" ? "left-0" : "right-0",
              !pinned &&
                (side === "left"
                  ? isAutoHideHover
                    ? "translate-x-0"
                    : "-translate-x-11"
                  : isAutoHideHover
                    ? "translate-x-0"
                    : "translate-x-11"),
            )}
          >
            <div
              data-activity-zone="view"
              className="flex min-h-8 flex-col items-center gap-1.5 pt-2"
            >
              {viewButtons.map((button) => renderButton(button, "view"))}
            </div>

            <div className="flex-1" />

            <div
              data-activity-zone="action"
              className="mb-2 flex min-h-8 flex-col items-center gap-1.5 pb-2"
            >
              {actionButtons.map((button) => renderButton(button, "action"))}
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52 border-border bg-popover text-foreground">
        <ContextMenuCheckboxItem checked={pinned} onCheckedChange={onPinnedChange}>
          {t("dock.pin")}
        </ContextMenuCheckboxItem>
        <ContextMenuItem onSelect={onHide}>{t("dock.hide")}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
