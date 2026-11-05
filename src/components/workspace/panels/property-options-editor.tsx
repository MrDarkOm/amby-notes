"use client"

import * as React from "react"
import { Plus, Star, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { parseOptions, serializeOptions } from "../property-options"

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
}: {
  settings: string
  onChange: (settings: string) => void
  /** Called when a field is left or the list changes in structure: the place to save. */
  onCommit?: (settings: string) => void
  invalid?: boolean
}) {
  const { t } = useTranslation()
  const parsed = React.useMemo(() => parseOptions(settings), [settings])
  const [rows, setRows] = React.useState<string[]>(parsed.options.length ? parsed.options : [""])
  const [chosen, setChosen] = React.useState<string | null>(parsed.default)

  // An outside change of `settings` (another property opened) replaces the fields.
  const lastWritten = React.useRef(settings)
  React.useEffect(() => {
    if (settings === lastWritten.current) return
    lastWritten.current = settings
    setRows(parsed.options.length ? parsed.options : [""])
    setChosen(parsed.default)
  }, [settings, parsed])

  const write = (nextRows: string[], nextDefault: string | null, commit: boolean) => {
    const next = serializeOptions(nextRows, nextDefault)
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
              write(next, chosen === row ? event.target.value : chosen, false)
            }}
            onBlur={() => onCommit?.(serializeOptions(rows, chosen))}
            onKeyDown={(event) => event.stopPropagation()}
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="button"
            title={t("infoPanel.defaultOption")}
            aria-pressed={Boolean(row) && chosen === row}
            disabled={!row.trim()}
            onClick={() => write(rows, chosen === row ? null : row, true)}
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-accent disabled:opacity-40",
              chosen === row && row ? "text-primary" : "text-muted-foreground",
            )}
          >
            <Star className="size-3.5" fill={chosen === row && row ? "currentColor" : "none"} />
          </button>
          <button
            type="button"
            title={t("infoPanel.removeOption")}
            onClick={() => {
              const next = rows.filter((_, at) => at !== index)
              write(next.length ? next : [""], chosen === row ? null : chosen, true)
            }}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => write([...rows, ""], chosen, false)}
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
