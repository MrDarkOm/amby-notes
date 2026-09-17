import { useTranslation } from "react-i18next"
import { Files, Lock, Maximize2, Redo2, Settings2, Undo2, Unlock } from "lucide-react"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ToolbarButton } from "../canvas/canvas-toolbar"
import type { DocumentViewMode } from "./use-document-view-mode"
import type { ContentWidth } from "../app-config"
import type { TreeItem } from "../sidebar-tree"

export interface DocumentAreaControlsProps {
  docModified?: string
  wordCount: number
  viewMode?: DocumentViewMode
  onViewModeChange?: (mode: DocumentViewMode) => void
  viewModeMenuOpen?: boolean
  onViewModeMenuOpenChange?: (open: boolean) => void
  isLocked?: boolean
  onToggleLock?: () => void
  onUndo: () => void
  onRedo: () => void
  contentWidth?: ContentWidth
  onContentWidthChange?: (width: ContentWidth) => void
  nestedNotes?: TreeItem[]
  nestedNotesPlacement?: "top" | "bottom" | "hidden"
  onNestedNotesPlacementChange?: (placement: "top" | "bottom" | "hidden") => void
}

export function DocumentAreaControls({
  docModified,
  wordCount,
  isLocked = false,
  onToggleLock,
  onUndo,
  onRedo,
  contentWidth = "normal",
  onContentWidthChange,
  nestedNotes = [],
  nestedNotesPlacement = "hidden",
  onNestedNotesPlacementChange,
}: DocumentAreaControlsProps) {
  const { t } = useTranslation()

  return (
    <div className="pointer-events-none absolute bottom-2 right-4 z-10 select-none max-w-[calc(100%-2rem)]">
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl border border-border/80 bg-card/90 p-1 shadow-md backdrop-blur-md">
        {/* Statistics: Timestamp & Word Count */}
        <div className="flex items-center px-1.5 text-[11px] text-muted-foreground select-none">
          {docModified ? (
            <>
              <span className="hidden sm:inline">{docModified}</span>
              <span className="hidden sm:inline mx-1.5 text-border/80">·</span>
            </>
          ) : null}
          <span>{t("docEditor.wordCount", { count: wordCount })}</span>
        </div>

        {/* Undo & Redo (Only shown in edit mode) */}
        {!isLocked && (
          <>
            <div className="mx-0.5 h-3.5 w-px bg-border/80" />
            <ToolbarButton
              title={t("docEditor.undo")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onUndo}
            >
              <Undo2 className="size-3.5" />
            </ToolbarButton>
            <ToolbarButton
              title={t("docEditor.redo")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onRedo}
            >
              <Redo2 className="size-3.5" />
            </ToolbarButton>
          </>
        )}

        <div className="mx-0.5 h-3.5 w-px bg-border/80" />

        {/* Lock Toggle Button (View mode / Edit mode) */}
        {onToggleLock ? (
          <ToolbarButton
            title={isLocked ? t("docEditor.editMode") : t("docEditor.viewMode")}
            active={isLocked}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onToggleLock}
          >
            {isLocked ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}
          </ToolbarButton>
        ) : null}

        <div className="mx-0.5 h-3.5 w-px bg-border/80" />

        {/* Settings Popover */}
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
              <span className="text-xs font-semibold text-foreground">{t("common.settings")}</span>

              {onContentWidthChange ? (
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
              ) : null}

              {onNestedNotesPlacementChange && nestedNotes.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
                    <Files className="size-3 text-muted-foreground" />
                    {t("docEditor.nestedNotesDisplay")}
                  </span>
                  <div className="grid grid-cols-3 gap-1 rounded-lg border border-border/70 bg-muted/40 p-0.5">
                    {(["top", "bottom", "hidden"] as const).map((placement) => (
                      <button
                        key={placement}
                        type="button"
                        onClick={() => onNestedNotesPlacementChange(placement)}
                        className={cn(
                          "rounded-md py-1 text-center text-xs font-medium",
                          nestedNotesPlacement === placement
                            ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                        )}
                      >
                        {placement === "top"
                          ? t("docEditor.nestedNotes_top")
                          : placement === "bottom"
                            ? t("docEditor.nestedNotes_bottom")
                            : t("docEditor.nestedNotes_hidden")}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
