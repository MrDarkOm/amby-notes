"use client"

import * as React from "react"
import { GripVertical, Palette, Plus, X } from "lucide-react"
import { Reorder, useDragControls } from "motion/react"
import { useTheme } from "next-themes"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { OPTION_COLOR_NAMES, OPTION_COLOR_SHADES, type OptionColorName } from "@/themes/palettes"
import { optionColor } from "../property-options"

/** A value or an option as a coloured chip; the shades come from the palette of the theme. */
export function OptionChip({
  label,
  color,
  className,
  ...rest
}: {
  label: string
  color: OptionColorName
} & React.HTMLAttributes<HTMLSpanElement>) {
  const { resolvedTheme } = useTheme()
  const shade = OPTION_COLOR_SHADES[color][resolvedTheme === "dark" ? "dark" : "light"]
  return (
    <span
      data-color={color}
      style={{ backgroundColor: shade.bg, color: shade.fg }}
      className={cn(
        "inline-flex max-w-full items-center rounded px-1.5 py-0.5 text-xs font-medium",
        className,
      )}
      {...rest}
    >
      <span className="truncate">{label}</span>
    </span>
  )
}

export interface OptionsChange {
  options: string[]
  colors: Record<string, string>
}

/**
 * The window that chooses the value of a select or a multi-select (docs/sync-plan.md, З63 г): the
 * chosen values on top with a cross, a field with the hint, the options as chips with a handle for
 * the order. A click chooses, a new text and Enter create an option and choose it. A value that is
 * not among the options is a grey chip and is kept.
 */
export function OptionPicker({
  options,
  colors,
  selected,
  multi,
  onSelect,
  onOptionsChange,
  disabled = false,
}: {
  options: string[]
  colors: Record<string, string>
  selected: string[]
  multi: boolean
  onSelect: (selected: string[]) => void
  onOptionsChange: (change: OptionsChange) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState("")
  const [coloring, setColoring] = React.useState<string | null>(null)
  const text = query.trim()
  const shown = text
    ? options.filter((option) => option.toLowerCase().includes(text.toLowerCase()))
    : options
  const exact = options.find((option) => option.toLowerCase() === text.toLowerCase())

  const choose = (option: string) => {
    if (multi) {
      onSelect(
        selected.includes(option)
          ? selected.filter((item) => item !== option)
          : [...selected, option],
      )
    } else {
      onSelect([option])
    }
  }
  const create = () => {
    if (!text) return
    if (exact) {
      if (!selected.includes(exact)) choose(exact)
    } else {
      onOptionsChange({ options: [...options, text], colors })
      onSelect(multi ? [...selected, text] : [text])
    }
    setQuery("")
  }
  const colorOf = (option: string) =>
    options.includes(option) ? optionColor(option, colors) : "gray"

  return (
    <div className="grid w-64 gap-1.5 text-xs" data-testid="option-picker">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((value) => (
            <span key={value} className="inline-flex items-center gap-0.5">
              <OptionChip
                label={value}
                color={colorOf(value)}
                data-selected={value}
                className="pr-1"
              />
              <button
                type="button"
                aria-label={t("infoPanel.removeValue", { value })}
                disabled={disabled}
                onClick={() => onSelect(selected.filter((item) => item !== value))}
                className="flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-accent"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        value={query}
        disabled={disabled}
        placeholder={t("infoPanel.optionPickerHint")}
        aria-label={t("infoPanel.optionPickerHint")}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === "Enter") {
            event.preventDefault()
            create()
          }
        }}
        className="h-7 min-w-0 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
      />
      <div data-testid="option-list" className="grid gap-0.5">
        {text ? (
          shown.map((option) => (
            <OptionRow
              key={option}
              option={option}
              colors={colors}
              disabled={disabled}
              draggable={false}
              coloring={coloring === option}
              onToggleColoring={() => setColoring(coloring === option ? null : option)}
              onChoose={() => choose(option)}
              onColor={(name) =>
                onOptionsChange({ options, colors: { ...colors, [option]: name } })
              }
            />
          ))
        ) : (
          <Reorder.Group
            as="div"
            axis="y"
            values={options}
            onReorder={(next) => onOptionsChange({ options: next, colors })}
            className="grid gap-0.5"
          >
            {options.map((option) => (
              <OptionRow
                key={option}
                option={option}
                colors={colors}
                disabled={disabled}
                draggable
                coloring={coloring === option}
                onToggleColoring={() => setColoring(coloring === option ? null : option)}
                onChoose={() => choose(option)}
                onColor={(name) =>
                  onOptionsChange({ options, colors: { ...colors, [option]: name } })
                }
              />
            ))}
          </Reorder.Group>
        )}
        {text && !exact && (
          <button
            type="button"
            disabled={disabled}
            onClick={create}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-left text-muted-foreground hover:bg-accent"
          >
            <Plus className="size-3" />
            {t("infoPanel.createOption", { value: text })}
          </button>
        )}
      </div>
    </div>
  )
}

function OptionRow({
  option,
  colors,
  disabled,
  draggable,
  coloring,
  onToggleColoring,
  onChoose,
  onColor,
}: {
  option: string
  colors: Record<string, string>
  disabled: boolean
  draggable: boolean
  coloring: boolean
  onToggleColoring: () => void
  onChoose: () => void
  onColor: (name: OptionColorName) => void
}) {
  const { t } = useTranslation()
  const controls = useDragControls()
  const color = optionColor(option, colors)
  const body = (
    <>
      <div className="flex items-center gap-1">
        {draggable ? (
          <button
            type="button"
            aria-label={t("infoPanel.dragOption", { value: option })}
            disabled={disabled}
            onPointerDown={(event) => controls.start(event)}
            className="flex size-5 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-accent"
          >
            <GripVertical className="size-3.5" />
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        <button
          type="button"
          data-option={option}
          data-color={color}
          disabled={disabled}
          onClick={onChoose}
          className="min-w-0 rounded text-left"
        >
          <OptionChip label={option} color={color} />
        </button>
        <button
          type="button"
          aria-label={t("infoPanel.optionColorOf", { value: option })}
          disabled={disabled}
          onClick={onToggleColoring}
          className="ml-auto flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent"
        >
          <Palette className="size-3.5" />
        </button>
      </div>
      {coloring && (
        <div className="ml-6 flex flex-wrap gap-1 py-0.5">
          {OPTION_COLOR_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              aria-label={t(`infoPanel.optionColors.${name}`)}
              aria-pressed={colors[option] === name}
              onClick={() => onColor(name)}
              style={{ backgroundColor: OPTION_COLOR_SHADES[name].dark.bg }}
              className={cn(
                "size-4 rounded-full border border-border",
                colors[option] === name && "ring-2 ring-ring",
              )}
            />
          ))}
        </div>
      )}
    </>
  )
  if (!draggable) return <div>{body}</div>
  return (
    <Reorder.Item as="div" value={option} dragListener={false} dragControls={controls}>
      {body}
    </Reorder.Item>
  )
}
