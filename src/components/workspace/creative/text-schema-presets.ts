import type { TFunction } from "i18next"

/** The most levels a story's text may have; the backend refuses a longer list. */
export const MAX_TEXT_LEVELS = 6

/** The schemas a new story's text can start from; "custom" is the author's own list. */
export const TEXT_SCHEMAS = ["novel", "story", "comic", "custom"] as const
export type TextSchemaChoice = (typeof TEXT_SCHEMAS)[number]
export type PresetTextSchema = Exclude<TextSchemaChoice, "custom">

/** The levels of each ready schema, outermost first, as keys of `creative.schema.levels`. */
const PRESET_LEVELS: Record<PresetTextSchema, readonly string[]> = {
  novel: ["book", "chapter", "scene"],
  story: ["page"],
  comic: ["book", "arc", "chapter", "page"],
}

/** The names of a ready schema's levels in the active language. */
export function presetLevelNames(schema: PresetTextSchema, t: TFunction): string[] {
  return PRESET_LEVELS[schema].map((key) => t(`creative.schema.levels.${key}`))
}

export type LevelsProblem = "empty" | "duplicate" | "tooMany"

/** What the backend would refuse in a list of level names, found before asking it. */
export function levelsProblem(names: string[]): LevelsProblem | null {
  if (names.length === 0) return "empty"
  if (names.length > MAX_TEXT_LEVELS) return "tooMany"
  const seen = new Set<string>()
  for (const raw of names) {
    const name = raw.trim()
    if (!name) return "empty"
    const key = name.toLocaleLowerCase()
    if (seen.has(key)) return "duplicate"
    seen.add(key)
  }
  return null
}

/** The levels as one line: "Book → Chapter → Scene". Blank names are left out. */
export function levelChain(names: string[]): string {
  return names
    .map((name) => name.trim())
    .filter(Boolean)
    .join(" → ")
}
