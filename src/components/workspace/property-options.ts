import { OPTION_COLOR_NAMES, type OptionColorName } from "@/themes/palettes"

/**
 * The options of a select or a multi-select (docs/sync-plan.md, З62). `settings` stays a string:
 * the new form is JSON `{"options":[…],"default":"…"}` (an option may hold a comma), the old one is
 * a comma list and is read as before. The old form is rewritten only when the options are edited.
 */
export interface PropertyOptions {
  options: string[]
  /** The option written into the header when the property is created; `null` for none. */
  default: string | null
}

export function parseOptions(settings: string): PropertyOptions {
  if (settings.trimStart().startsWith("{")) {
    try {
      const value: unknown = JSON.parse(settings)
      if (
        value &&
        typeof value === "object" &&
        Array.isArray((value as { options?: unknown }).options)
      ) {
        const options = (value as { options: unknown[] }).options
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
        const wanted = (value as { default?: unknown }).default
        return {
          options,
          default: typeof wanted === "string" && options.includes(wanted) ? wanted : null,
        }
      }
    } catch {
      /* not JSON after all: the old comma form below */
    }
  }
  return {
    options: settings
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    default: null,
  }
}

/**
 * The colours chosen for the options, by option (З63): only values written as strings. A name that
 * is not in the palette is kept as it is, so that it survives until the options are edited.
 */
export function parseOptionColors(settings: string): Record<string, string> {
  if (!settings.trimStart().startsWith("{")) return {}
  try {
    const colors = (JSON.parse(settings) as { colors?: unknown }).colors
    if (!colors || typeof colors !== "object" || Array.isArray(colors)) return {}
    return Object.fromEntries(
      Object.entries(colors as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    )
  } catch {
    return {}
  }
}

/** The new form; empty options give an empty string. */
export function serializeOptions(
  options: string[],
  defaultOption: string | null,
  colors: Record<string, string> = {},
): string {
  const clean = options.map((item) => item.trim()).filter(Boolean)
  if (clean.length === 0) return ""
  const kept = Object.fromEntries(
    Object.entries(colors).filter(([option]) => clean.includes(option)),
  )
  return JSON.stringify({
    options: clean,
    ...(defaultOption && clean.includes(defaultOption) ? { default: defaultOption } : {}),
    ...(Object.keys(kept).length > 0 ? { colors: kept } : {}),
  })
}

const isColorName = (name: string): name is OptionColorName =>
  (OPTION_COLOR_NAMES as readonly string[]).includes(name)

/**
 * The colour of an option: the one chosen, else one that follows from its text, the same on every
 * device (З63). `gray` is left for values that are not options.
 */
export function optionColor(option: string, colors: Record<string, string>): OptionColorName {
  const chosen = colors[option]
  if (chosen && isColorName(chosen)) return chosen
  let hash = 2166136261
  for (let at = 0; at < option.length; at++) {
    hash = Math.imul(hash ^ option.charCodeAt(at), 16777619) >>> 0
  }
  const own = OPTION_COLOR_NAMES.slice(1)
  return own[hash % own.length]
}

/** The colours after an option got another name: the colour goes with it. */
export function renameOptionColor(
  colors: Record<string, string>,
  from: string,
  to: string,
): Record<string, string> {
  if (!(from in colors) || from === to) return colors
  const { [from]: moved, ...rest } = colors
  return { ...rest, [to]: moved }
}

/** The colours after an option was removed. */
export function dropOptionColor(
  colors: Record<string, string>,
  option: string,
): Record<string, string> {
  const { [option]: _removed, ...rest } = colors
  return rest
}

/** A select or a multi-select needs at least one non-empty option. */
export function validateOptions(options: string[]): boolean {
  return options.some((item) => item.trim() !== "")
}

/** The options as one line, for a quick look. */
export function optionsText(settings: string): string {
  return parseOptions(settings).options.join(", ")
}
