import type { TFunction } from "i18next"

/**
 * Names of the base sections and groups in the active language. The folder of
 * a section is named once, at creation, so the names are resolved here and sent
 * to Rust (`labels`) instead of being fixed in the backend.
 */
export function projectLabels(t: TFunction): Record<string, string> {
  return {
    "section:text": t("creative.sections.text"),
    "section:notes": t("creative.sections.notes"),
    "section:characters": t("creative.sections.characters"),
    "section:locations": t("creative.sections.locations"),
    "group:work": t("creative.groups.work"),
    "group:world": t("creative.groups.world"),
    ...schemaLabels(t),
    ...presetLabels(t),
  }
}

const PROPERTY_KEYS = ["level", "parent", "order", "format"] as const
const LEVEL_KEYS = ["book", "arc", "chapter", "page"] as const
const FORMAT_KINDS = ["manuscript", "screenplay", "comic", "note"] as const

/**
 * Names of the text schema: its four properties, the preset levels and the page formats.
 * They become names inside the database (and keys in the notes' frontmatter), so they too
 * are resolved from the active language when the text is created.
 */
function schemaLabels(t: TFunction): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const key of PROPERTY_KEYS)
    labels[`property:${key}`] = t(`creative.schema.properties.${key}`)
  for (const key of LEVEL_KEYS) labels[`level:${key}`] = t(`creative.schema.levels.${key}`)
  for (const kind of FORMAT_KINDS) labels[`format:${kind}`] = t(`creative.schema.formats.${kind}`)
  return labels
}

const IMPORTANCE_KEYS = ["main", "side", "episode"] as const
const KIND_KEYS = ["city", "district", "place", "nature"] as const
const HEADING_KEYS = [
  "basic",
  "traits",
  "appearance",
  "biography",
  "description",
  "history",
] as const
const PRESET_PROPERTY_KEYS = ["importance", "kind", "portrait", "image"] as const

/**
 * Names a section preset starts with: its properties and their options, the starter headings
 * of the dossier template, the gallery view and the template itself. Like the schema names,
 * they become names inside the database, so they are resolved from the active language.
 */
function presetLabels(t: TFunction): Record<string, string> {
  const labels: Record<string, string> = {
    "view:gallery": t("creative.preset.view"),
    "template:dossier": t("creative.preset.template"),
  }
  for (const key of PRESET_PROPERTY_KEYS)
    labels[`preset:${key}`] = t(`creative.preset.properties.${key}`)
  for (const key of IMPORTANCE_KEYS)
    labels[`importance:${key}`] = t(`creative.preset.importance.${key}`)
  for (const key of KIND_KEYS) labels[`kind:${key}`] = t(`creative.preset.kinds.${key}`)
  for (const key of HEADING_KEYS) labels[`heading:${key}`] = t(`creative.preset.headings.${key}`)
  return labels
}

/** The starting points a new section can be made from; none is an empty database. */
export const SECTION_PRESETS = ["characters", "locations", "organizations", "items"] as const
export type SectionPreset = (typeof SECTION_PRESETS)[number]

/** A project the dialog can create. A universe is a collection with its own world sections. */
export type NewProjectKind = "story" | "universe" | "collection"

export function projectRequestKind(kind: NewProjectKind): {
  kind: "story" | "collection"
  baseSections: boolean
} {
  if (kind === "story") return { kind: "story", baseSections: true }
  if (kind === "universe") return { kind: "collection", baseSections: true }
  return { kind: "collection", baseSections: false }
}
