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

function formatDate(value: string, includeTime: boolean, locale?: string): string {
  const parsed = parseDate(value)
  if (!parsed) return value
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      ...(includeTime && parsed.hasTime ? { timeStyle: "short" } : {}),
    }).format(parsed.date)
  } catch {
    return value
  }
}

function optionChip(
  key: string,
  optionId: string,
  options: DatabaseOptionSummary[],
): DisplayChip | null {
  if (!optionId) return null
  const option = options.find((candidate) => candidate.optionId === optionId)
  if (!option) return { key, kind: "option", label: null, color: null, state: "missing" }
  return { key, kind: "option", label: option.name, color: safeOptionColor(option.color) }
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
        ? formatDate(value.start, false, locale)
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
      const includeTime = parseConfig(property.configJson).includeTime === true
      const start = formatDate(value.start, includeTime, options.locale)
      const end =
        typeof value.end === "string" && value.end
          ? formatDate(value.end, includeTime, options.locale)
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
        ? value.targetNoteIds.flatMap((targetId) => {
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
