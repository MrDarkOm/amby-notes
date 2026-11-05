"use client"

import * as React from "react"
import { Plus, Star, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import {
  dropOptionColor,
  parseOptionColors,
  parseOptions,
  renameOptionColor,
  serializeOptions,
} from "../property-options"

/**
 * The options of a select or a multi-select as fields (docs/sync-plan.md, З62): one field for each
 * option, a small star to make one of them the default, a button to remove, and «Добавить вариант».
 * `onChange` gets `settings` in the new form on every change; the old comma form is read as it is
 * and rewritten only when the person edits the options.
 */
export function PropertyOptionsEditor({
  settings,
  onChange,
  onCommit,
  invalid = false,
  autoDefault = false,
}: {
  settings: string
  onChange: (settings: string) => void
  /** Called when a field is left or the list changes in structure: the place to save. */
  onCommit?: (settings: string) => void
  invalid?: boolean
  /**
   * A new property: until the person touches the star, the first filled option is the default
   * (the value of the new property), so no click is needed (З62 в).
   */
  autoDefault?: boolean
}) {
  const { t } = useTranslation()
  const parsed = React.useMemo(() => parseOptions(settings), [settings])
  const [rows, setRows] = React.useState<string[]>(parsed.options.length ? parsed.options : [""])
  const [chosen, setChosen] = React.useState<string | null>(parsed.default)
  const [touched, setTouched] = React.useState(false)
  // The colours go with their options: a rename moves the colour, a removal drops it (З63).
  const [colors, setColors] = React.useState(() => parseOptionColors(settings))

  // An outside change of `settings` (another property opened) replaces the fields.
  const lastWritten = React.useRef(settings)
  React.useEffect(() => {
    if (settings === lastWritten.current) return
    lastWritten.current = settings
    setRows(parsed.options.length ? parsed.options : [""])
    setChosen(parsed.default)
    setColors(parseOptionColors(settings))
    setTouched(false)
  }, [settings, parsed])

  const firstFilled = (list: string[]) => list.map((item) => item.trim()).find(Boolean) ?? null
  /** The default after a change of the fields: the first option while the star is untouched. */
  const followDefault = (nextRows: string[], current: string | null) =>
    autoDefault && !touched ? firstFilled(nextRows) : current

  const write = (
    nextRows: string[],
    nextDefault: string | null,
    commit: boolean,
    nextColors = colors,
  ) => {
    setColors(nextColors)
    const next = serializeOptions(nextRows, nextDefault, nextColors)
    lastWritten.current = next
    setRows(nextRows)
    setChosen(nextDefault)
    onChange(next)
    if (commit) onCommit?.(next)
  }

  return (
    <div className="grid gap-1.5 text-[10px] text-muted-foreground">
      <span>{t("infoPanel.propertyOptions")}</span>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-1">
          <input
            aria-label={t("infoPanel.optionField")}
            value={row}
            placeholder={t("infoPanel.optionField")}
            onChange={(event) => {
              const next = rows.map((item, at) => (at === index ? event.target.value : item))
              const renamed =
                chosen !== null && chosen === row.trim()
                  ? event.target.value.trim() || null
                  : chosen
              write(
                next,
                followDefault(next, renamed),
                false,
                renameOptionColor(colors, row.trim(), event.target.value.trim()),
              )
            }}
            onBlur={() => onCommit?.(serializeOptions(rows, chosen, colors))}
            onKeyDown={(event) => event.stopPropagation()}
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="button"
            title={t("infoPanel.defaultOption")}
            aria-pressed={Boolean(row.trim()) && chosen === row.trim()}
            disabled={!row.trim()}
            onClick={() => {
              setTouched(true)
              write(rows, chosen === row.trim() ? null : row.trim(), true)
            }}
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-accent disabled:opacity-40",
              chosen === row.trim() && row.trim() ? "text-primary" : "text-muted-foreground",
            )}
          >
            <Star
              className="size-3.5"
              fill={chosen === row.trim() && row.trim() ? "currentColor" : "none"}
            />
          </button>
          <button
            type="button"
            title={t("infoPanel.removeOption")}
            onClick={() => {
              const next = rows.filter((_, at) => at !== index)
              const rest = next.length ? next : [""]
              write(
                rest,
                followDefault(rest, chosen === row.trim() ? null : chosen),
                true,
                dropOptionColor(colors, row.trim()),
              )
            }}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => write([...rows, ""], followDefault([...rows, ""], chosen), false)}
        className="inline-flex w-fit items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <Plus className="size-3" />
        {t("infoPanel.addOption")}
      </button>
      {invalid && (
        <p role="alert" className="text-xs text-destructive">
          {t("infoPanel.optionsRequired")}
        </p>
      )}
    </div>
  )
}
