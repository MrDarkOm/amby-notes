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

/** The new form; empty options give an empty string. */
export function serializeOptions(options: string[], defaultOption: string | null): string {
  const clean = options.map((item) => item.trim()).filter(Boolean)
  if (clean.length === 0) return ""
  return JSON.stringify(
    defaultOption && clean.includes(defaultOption)
      ? { options: clean, default: defaultOption }
      : { options: clean },
  )
}

/** A select or a multi-select needs at least one non-empty option. */
export function validateOptions(options: string[]): boolean {
  return options.some((item) => item.trim() !== "")
}

/** The options as one line, for a quick look. */
export function optionsText(settings: string): string {
  return parseOptions(settings).options.join(", ")
}
