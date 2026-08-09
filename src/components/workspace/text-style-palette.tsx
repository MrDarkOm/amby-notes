"use client"

import { Eraser, Highlighter, Type } from "lucide-react"
import { useTranslation } from "react-i18next"
import { EDITOR_BACKGROUND_COLORS, EDITOR_TEXT_COLORS } from "@/lib/themes"

function ColorButton({
  color,
  title,
  onClick,
}: {
  color: string
  title: string
  onClick: (color: string) => void
}) {
  return (
    <button
      type="button"
      title={title}
      className="size-5 rounded border border-border transition-transform hover:scale-110 focus:outline-none focus:ring-1 focus:ring-foreground/30"
      style={{ backgroundColor: color }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onClick(color)}
    />
  )
}

function ClearButton({
  title,
  label,
  onClick,
}: {
  title: string
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      className="flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Eraser className="size-3" />
      {label}
    </button>
  )
}

export function TextStylePalette({
  onTextColor,
  onBackgroundColor,
  onClearTextColor,
  onClearBackgroundColor,
}: {
  onTextColor: (color: string) => void
  onBackgroundColor: (color: string) => void
  onClearTextColor: () => void
  onClearBackgroundColor: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="w-[300px] space-y-2 p-1">
      <div className="flex items-center gap-2">
        <div className="flex size-6 items-center justify-center rounded border border-border bg-card text-foreground">
          <Type className="size-3.5" />
        </div>
        <div className="grid flex-1 grid-cols-9 gap-1">
          {EDITOR_TEXT_COLORS.map((color) => (
            <ColorButton
              key={color}
              color={color}
              title={t("palette.textColor", { color })}
              onClick={onTextColor}
            />
          ))}
        </div>
        <ClearButton
          title={t("palette.clearTextColor")}
          label={t("palette.clear")}
          onClick={onClearTextColor}
        />
      </div>
      <div className="flex items-center gap-2">
        <div className="flex size-6 items-center justify-center rounded border border-border bg-card text-foreground">
          <Highlighter className="size-3.5" />
        </div>
        <div className="grid flex-1 grid-cols-9 gap-1">
          {EDITOR_BACKGROUND_COLORS.map((color) => (
            <ColorButton
              key={color}
              color={color}
              title={t("palette.bgColor", { color })}
              onClick={onBackgroundColor}
            />
          ))}
        </div>
        <ClearButton
          title={t("palette.clearBg")}
          label={t("palette.clear")}
          onClick={onClearBackgroundColor}
        />
      </div>
    </div>
  )
}
