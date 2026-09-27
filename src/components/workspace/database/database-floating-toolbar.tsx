"use client"

import { useTranslation } from "react-i18next"
import { Lock, Maximize2, Redo2, Settings2, Undo2, Unlock } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { ToolbarButton } from "../common/toolbar-button"

export interface DatabaseFloatingToolbarProps {
  rowCount: number
  propertyCount: number
  isDatabaseLocked: boolean
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onToggleLock: () => void
  contentWidth?: "normal" | "wide" | "full"
  onContentWidthChange?: (width: "normal" | "wide" | "full") => void
}

export function DatabaseFloatingToolbar({
  rowCount,
  propertyCount,
  isDatabaseLocked,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onToggleLock,
  contentWidth,
  onContentWidthChange,
}: DatabaseFloatingToolbarProps) {
  const { t } = useTranslation()

  return (
    <div className="pointer-events-none absolute bottom-2 right-2 z-10 select-none max-w-[calc(100%-1rem)]">
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl border border-border/80 bg-card/90 p-1 shadow-md backdrop-blur-md">
        {/* Statistics: Row count & Property count */}
        <div className="flex items-center px-1.5 text-[11px] text-muted-foreground select-none">
          <span>{t("databaseWorkspace.rowsCount", { count: rowCount })}</span>
          <span className="mx-1.5 text-border/80">·</span>
          <span>{t("databaseWorkspace.propertiesCount", { count: propertyCount })}</span>
        </div>

        {/* Undo & Redo (Only shown in edit mode) */}
        {!isDatabaseLocked && (
          <>
            <div className="mx-0.5 h-3.5 w-px bg-border/80" />
            <ToolbarButton
              title={t("docEditor.undo")}
              disabled={!canUndo}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onUndo}
            >
              <Undo2 className="size-3.5" />
            </ToolbarButton>
            <ToolbarButton
              title={t("docEditor.redo")}
              disabled={!canRedo}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onRedo}
            >
              <Redo2 className="size-3.5" />
            </ToolbarButton>
          </>
        )}

        <div className="mx-0.5 h-3.5 w-px bg-border/80" />

        {/* Lock Toggle Button */}
        <ToolbarButton
          title={isDatabaseLocked ? t("docEditor.editMode") : t("docEditor.viewMode")}
          active={isDatabaseLocked}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggleLock}
        >
          {isDatabaseLocked ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}
        </ToolbarButton>

        {/* Settings Popover */}
        {onContentWidthChange ? (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                title={t("common.settings")}
                onMouseDown={(e) => e.preventDefault()}
                className="flex size-7 items-center justify-center rounded-lg text-foreground hover:bg-accent hover:text-accent-foreground select-none"
              >
                <Settings2 className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="end"
              sideOffset={13}
              alignOffset={-5}
              className="w-64 rounded-xl border border-border/80 bg-popover/95 p-3 text-foreground shadow-lg backdrop-blur-md"
            >
              <div className="flex flex-col gap-3">
                <span className="text-xs font-semibold text-foreground">
                  {t("common.settings")}
                </span>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
                    <Maximize2 className="size-3 text-muted-foreground" />
                    {t("settings.editor.contentWidth")}
                  </span>
                  <div className="grid grid-cols-3 gap-1 rounded-lg border border-border/70 bg-muted/40 p-0.5">
                    {(["normal", "wide", "full"] as const).map((width) => (
                      <button
                        key={width}
                        type="button"
                        onClick={() => onContentWidthChange(width)}
                        className={cn(
                          "rounded-md py-1 text-center text-xs font-medium",
                          contentWidth === width
                            ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                        )}
                      >
                        {width === "full" ? "100%" : t(`settings.editor.${width}`)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
    </div>
  )
}
