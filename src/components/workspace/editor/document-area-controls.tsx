import { useTranslation } from "react-i18next"
import { EyeOff, Files, Maximize2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { PageFloatingBar } from "../page-chrome/page-floating-bar"
import { useSettingsStore } from "../use-settings-store"
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
  const showAreaControls = useSettingsStore((s) => s.prefs.editor.showAreaControls ?? true)
  const setPrefs = useSettingsStore((s) => s.setPrefs)

  const settingsContent = (
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

      <div className="border-t border-border/60 pt-2">
        <button
          type="button"
          onClick={() => {
            const currentEditor = useSettingsStore.getState().prefs.editor
            void setPrefs({
              editor: { ...currentEditor, showAreaControls: false },
            })
          }}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <EyeOff className="size-3.5 shrink-0" />
          <span>{t("docEditor.hideBottomBar")}</span>
        </button>
      </div>
    </div>
  )

  return (
    <PageFloatingBar
      hidden={!showAreaControls}
      modified={docModified}
      wordCount={t("docEditor.wordCount", { count: wordCount })}
      onUndo={onUndo}
      onRedo={onRedo}
      undoLabel={t("docEditor.undo")}
      redoLabel={t("docEditor.redo")}
      historyDisabled={isLocked}
      lock={
        onToggleLock
          ? {
              locked: isLocked,
              onToggle: onToggleLock,
              title: isLocked ? t("docEditor.editMode") : t("docEditor.viewMode"),
            }
          : undefined
      }
      settings={{ title: t("common.settings"), content: settingsContent }}
    />
  )
}
