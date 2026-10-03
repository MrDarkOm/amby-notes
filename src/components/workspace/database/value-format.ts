import type { DatabaseOptionSummary, DatabasePropertySummary } from "@/lib/storage"

/** Neutral state of a chip whose text is not (yet) known. */
export type DisplayChipState = "pending" | "missing"

export interface DisplayChip {
  key: string
  kind: "text" | "option" | "relation" | "file"
  /** `null` when the value cannot be named; see `state`. */
  label: string | null
  /** User-chosen option color (`#rgb`/`#rrggbb`), never an arbitrary CSS string. */
  color: string | null
  state?: DisplayChipState
}

export interface DisplayProperty {
  propertyId: string
  name: string
  propertyType: string
  chips: DisplayChip[]
}

export interface FormatOptions {
  /** Titles of related notes known to the caller, by note ID. */
  relationTitles?: Record<string, string>
  locale?: string
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const MAX_NUMBER_DIGITS = 15

export function safeOptionColor(color: string | undefined | null): string | null {
  return color && HEX_COLOR.test(color) ? color : null
}

function parseValues(valuesJson: string): Record<string, unknown> | null {
  try {
    const values: unknown = JSON.parse(valuesJson)
    return values && typeof values === "object" ? (values as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function parseConfig(configJson: string): Record<string, unknown> {
  try {
    const config: unknown = JSON.parse(configJson)
    return config && typeof config === "object" ? (config as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function textChip(key: string, label: string): DisplayChip {
  return { key, kind: "text", label, color: null }
}

function formatNumber(decimal: string, config: Record<string, unknown>, locale?: string): string {
  if (config.format === "percent") return `${decimal}%`
  if (config.format === "currency" && typeof config.currency === "string") {
    const digits = decimal.replace(/^-/, "").replace(".", "")
    const amount = Number(decimal)
    if (
      Number.isFinite(amount) &&
      /^-?\d+(\.\d+)?$/.test(decimal) &&
      digits.length <= MAX_NUMBER_DIGITS
    ) {
      try {
        return new Intl.NumberFormat(locale, {
          style: "currency",
          currency: config.currency,
          minimumFractionDigits: 0,
          maximumFractionDigits: 20,
        }).format(amount)
      } catch {
        // Unknown currency code: keep the exact stored decimal.
      }
    }
  }
  return decimal
}

function parseDate(value: string): { date: Date; hasTime: boolean } | null {
  const dateOnly = DATE_ONLY.exec(value)
  if (dateOnly) {
    const date = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    return Number.isNaN(date.getTime()) ? null : { date, hasTime: false }
  }
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : { date: new Date(timestamp), hasTime: true }
}

export type DateFormatId = "full" | "monthDayYear" | "dayMonthYear" | "yearMonthDay" | "relative"
export const DATE_FORMAT_IDS: DateFormatId[] = [
  "full",
  "monthDayYear",
  "dayMonthYear",
  "yearMonthDay",
  "relative",
]

/** How a Date property shows its values; only presentation, never what is stored. */
export interface DateDisplay {
  includeTime: boolean
  dateFormat: DateFormatId
  timeFormat: "12h" | "24h"
}

export function dateDisplayOf(configJson: string): DateDisplay {
  const config = parseConfig(configJson)
  return {
    includeTime: config.includeTime === true,
    dateFormat: DATE_FORMAT_IDS.includes(config.dateFormat as DateFormatId)
      ? (config.dateFormat as DateFormatId)
      : "full",
    timeFormat: config.timeFormat === "12h" ? "12h" : "24h",
  }
}

const pad = (value: number) => String(value).padStart(2, "0")

function dayDifference(date: Date, now: Date): number {
  const day = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate())
  return Math.round((day(date) - day(now)) / 86_400_000)
}

/** A stored date or date-time shown in the property's own format. */
export function formatDateValue(
  value: string,
  display: DateDisplay,
  locale?: string,
  now: Date = new Date(),
): string {
  const parsed = parseDate(value)
  if (!parsed) return value
  const { date } = parsed
  const time =
    display.includeTime && parsed.hasTime
      ? new Intl.DateTimeFormat(locale, {
          hour: display.timeFormat === "12h" ? "numeric" : "2-digit",
          minute: "2-digit",
          hour12: display.timeFormat === "12h",
        }).format(date)
      : null
  let day: string
  try {
    switch (display.dateFormat) {
      case "monthDayYear":
        day = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()}`
        break
      case "dayMonthYear":
        day = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`
        break
      case "yearMonthDay":
        day = `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
        break
      case "relative": {
        const difference = dayDifference(date, now)
        day =
          Math.abs(difference) <= 31
            ? new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(difference, "day")
            : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date)
        break
      }
      default:
        day = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date)
    }
  } catch {
    return value
  }
  return time ? `${day} ${time}` : day
}

function optionChip(
  key: string,
  optionId: string,
  options: DatabaseOptionSummary[],
): DisplayChip | null {
  if (!optionId) return null
  const option = options.find((candidate) => candidate.optionId === optionId)
  if (!option) return missingOptionChip(key, optionId)
  return { key, kind: "option", label: option.name, color: safeOptionColor(option.color) }
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i

/**
 * An option that is no longer in the list. Records store the option name, so a
 * deleted option's value is still readable text; only a bare ID has nothing to show.
 */
export function missingOptionChip(key: string, optionId: string): DisplayChip {
  return {
    key,
    kind: "option",
    label: ULID.test(optionId) ? null : optionId,
    color: null,
    state: "missing",
  }
}

/**
 * Text of a computed (Formula or Rollup) value; `null` when there is nothing to
 * show: no data, as opposed to zero (which is "0") or a failure (no value at all).
 */
export function formatComputedValue(
  value: Record<string, unknown> | null,
  property: DatabasePropertySummary,
  locale?: string,
): string | null {
  if (!value) return null
  switch (value.type) {
    case "number": {
      if (typeof value.decimal !== "string" || !value.decimal) return null
      const percent =
        property.propertyType === "rollup" &&
        parseConfig(property.configJson).aggregation === "percentChecked"
      if (percent) return `${trimTrailingZeros(value.decimal)}%`
      return formatNumber(value.decimal, parseConfig(property.configJson), locale)
    }
    case "text":
      return typeof value.value === "string" && value.value ? value.value : null
    case "checkbox":
      return value.checked === true ? "✓" : value.checked === false ? "–" : null
    case "date":
      return typeof value.start === "string" && value.start
        ? formatDateValue(value.start, dateDisplayOf(property.configJson), locale)
        : null
    default:
      return null
  }
}

function trimTrailingZeros(decimal: string): string {
  return decimal.includes(".") ? decimal.replace(/0+$/, "").replace(/\.$/, "") : decimal
}

function chipsFor(
  property: DatabasePropertySummary,
  value: Record<string, unknown>,
  options: FormatOptions,
): DisplayChip[] {
  const id = property.propertyId
  if (property.propertyType === "formula" || property.propertyType === "rollup") {
    const text = formatComputedValue(value, property, options.locale)
    return text ? [textChip(id, text)] : []
  }
  switch (value.type) {
    case "text":
    case "url":
      return typeof value.value === "string" && value.value ? [textChip(id, value.value)] : []
    case "number":
      return typeof value.decimal === "string" && value.decimal
        ? [
            textChip(
              id,
              formatNumber(value.decimal, parseConfig(property.configJson), options.locale),
            ),
          ]
        : []
    case "checkbox":
      // An unchecked box is the default and only adds noise to a compact card.
      return value.checked === true ? [textChip(id, "✓")] : []
    case "date": {
      if (typeof value.start !== "string" || !value.start) return []
      const display = dateDisplayOf(property.configJson)
      const start = formatDateValue(value.start, display, options.locale)
      const end =
        typeof value.end === "string" && value.end
          ? formatDateValue(value.end, display, options.locale)
          : null
      return [textChip(id, end ? `${start} – ${end}` : start)]
    }
    case "select":
    case "status": {
      const chip =
        typeof value.optionId === "string" ? optionChip(id, value.optionId, property.options) : null
      return chip ? [chip] : []
    }
    case "multiSelect":
      return Array.isArray(value.optionIds)
        ? value.optionIds.flatMap((optionId, index) => {
            const chip =
              typeof optionId === "string"
                ? optionChip(`${id}-${index}`, optionId, property.options)
                : null
            return chip ? [chip] : []
          })
        : []
    case "relation":
      return Array.isArray(value.targetNoteIds)
        ? // Links beyond a one-page limit set later stay stored; only the first is shown.
          (parseConfig(property.configJson).maxItems === 1
            ? value.targetNoteIds.slice(0, 1)
            : value.targetNoteIds
          ).flatMap((targetId) => {
            if (typeof targetId !== "string") return []
            const title = options.relationTitles?.[targetId]
            return [
              title
                ? { key: `${id}-${targetId}`, kind: "relation" as const, label: title, color: null }
                : {
                    key: `${id}-${targetId}`,
                    kind: "relation" as const,
                    label: null,
                    color: null,
                    state: "pending" as const,
                  },
            ]
          })
        : []
    case "files":
      return Array.isArray(value.items)
        ? value.items.flatMap((item, index) => {
            const name = item && typeof item === "object" ? (item as { name?: unknown }).name : null
            return typeof name === "string" && name
              ? [{ key: `${id}-${index}`, kind: "file" as const, label: name, color: null }]
              : []
          })
        : []
    default:
      return []
  }
}

/**
 * Presents a row's stored values in schema order. Unknown properties are not
 * shown, and technical identifiers (option or note IDs) never become labels.
 */
export function formatRowProperties(
  valuesJson: string,
  properties: DatabasePropertySummary[],
  options: FormatOptions = {},
): DisplayProperty[] {
  const values = parseValues(valuesJson)
  if (!values) return []
  const result: DisplayProperty[] = []
  for (const property of properties) {
    const value = values[property.propertyId]
    if (!value || typeof value !== "object") continue
    const chips = chipsFor(property, value as Record<string, unknown>, options)
    if (chips.length > 0) {
      result.push({
        propertyId: property.propertyId,
        name: property.name,
        propertyType: property.propertyType,
        chips,
      })
    }
  }
  return result
}

/** The first non-empty properties in schema order, for a compact card. */
export function cardProperties(
  valuesJson: string,
  properties: DatabasePropertySummary[],
  options: FormatOptions & { limit?: number; exclude?: string[]; fields?: string[] | null } = {},
): DisplayProperty[] {
  const { limit = 3, exclude = [], fields = null, ...format } = options
  const candidates = properties.filter(
    (property) =>
      !exclude.includes(property.propertyId) && (!fields || fields.includes(property.propertyId)),
  )
  // A property list chosen in the view settings shows all of them; without one
  // a card stays compact.
  const shown = formatRowProperties(valuesJson, candidates, format)
  return fields ? shown : shown.slice(0, limit)
}
