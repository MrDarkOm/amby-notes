import type { TFunction } from "i18next"
import type { TargetLabels } from "./project-tree-model"

/**
 * Names of the base sections in the active language. The folder of
 * a section is named once, at creation, so the names are resolved here and sent
 * to Rust (`labels`) instead of being fixed in the backend.
 */
export function projectLabels(t: TFunction): Record<string, string> {
  return {
    "section:stories": t("creative.sections.stories"),
    "section:notes": t("creative.sections.notes"),
    "section:characters": t("creative.sections.characters"),
    "section:locations": t("creative.sections.locations"),
    "section:universes": t("creative.sections.universes"),
    "section:arcs": t("creative.sections.arcs"),
    "section:anchors": t("creative.sections.anchors"),
    ...linkLabels(t),
    ...schemaLabels(t),
    ...presetLabels(t),
  }
}

/**
 * Names of the link properties: a world page's "Stories", a story's (and an anchor's) "Universe",
 * and the "Anchors" and "Arcs" of a story's text pages (also the arcs of an anchor). They become
 * property names (and keys in the notes' frontmatter), so they follow the language of the moment.
 */
export function linkLabels(t: TFunction): Record<string, string> {
  return {
    "property:stories": t("creative.preset.properties.stories"),
    "property:universe": t("creative.preset.properties.universe"),
    "property:anchors": t("creative.preset.properties.anchors"),
    "property:arcs": t("creative.preset.properties.arcs"),
  }
}

const PROPERTY_KEYS = ["level", "parent", "order", "format", "status"] as const
const LEVEL_KEYS = ["book", "arc", "chapter", "page"] as const
const FORMAT_KINDS = ["manuscript", "screenplay", "comic", "note"] as const
const STATUS_KEYS = ["draft", "inProgress", "done"] as const

/**
 * Names of the status property and its three options in the active language, used when adding
 * the status property to an existing story or creating a new one.
 */
export function statusLabels(t: TFunction): Record<string, string> {
  const labels: Record<string, string> = {
    "property:status": t("creative.schema.properties.status"),
  }
  for (const key of STATUS_KEYS) {
    labels[`status:${key}`] = t(`creative.schema.statuses.${key}`)
  }
  return labels
}

/**
 * Names of the text schema: its five properties, the preset levels, the page formats and
 * the status options. They become names inside the database (and keys in the notes' frontmatter),
 * so they too are resolved from the active language when the text is created.
 */
function schemaLabels(t: TFunction): Record<string, string> {
  const labels: Record<string, string> = { ...statusLabels(t) }
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
const PRESET_PROPERTY_KEYS = [
  "importance",
  "kind",
  "portrait",
  "image",
  "status",
  "synopsis",
  "description",
  "participants",
  "characters",
] as const
const ARC_KIND_KEYS = ["character", "plot", "mini"] as const

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
  for (const key of ARC_KIND_KEYS) labels[`arcKind:${key}`] = t(`creative.preset.arcKinds.${key}`)
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

/** The words a page and its tab are named with when the catalog does not name them. */
export function creativeTitleLabels(t: TFunction): TargetLabels {
  return {
    universe: t("creative.kind.universe"),
    standalone: t("creative.workshop.standalone"),
    fallback: t("creative.welcome.title"),
  }
}
