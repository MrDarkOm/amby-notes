import { DATABASE_OPTION_COLORS } from "@/themes/palettes"
import type { DatabaseOptionInput, DatabasePropertySummary } from "@/lib/storage"

export const OPTION_COLORS = DATABASE_OPTION_COLORS

export const STATUS_GROUPS = ["notStarted", "inProgress", "done"] as const
export type StatusGroup = (typeof STATUS_GROUPS)[number]

export function isOptionProperty(propertyType: string): boolean {
  return propertyType === "select" || propertyType === "multiSelect" || propertyType === "status"
}

/** A row in the options editor. `id` is `null` until the option is saved. */
export interface OptionDraft {
  /** Stable key for rendering; the option ID once it exists. */
  key: string
  id: string | null
  name: string
  color: string
  group: StatusGroup
  /** New rows of the database start with this option. */
  isDefault: boolean
}

let draftCounter = 0
export function newDraftKey(): string {
  draftCounter += 1
  return `new-${draftCounter}`
}

/** The color a new option gets: the least used one, so neighbours differ. */
export function nextOptionColor(existing: { color: string }[]): string {
  const counts = new Map<string, number>(OPTION_COLORS.map((color) => [color.hex, 0]))
  for (const option of existing) {
    const hex = option.color.toLowerCase()
    if (counts.has(hex)) counts.set(hex, (counts.get(hex) ?? 0) + 1)
  }
  // The first entry (gray) is the neutral default: use it only when everything else is taken.
  const colors = [...OPTION_COLORS.slice(1), OPTION_COLORS[0]]
  return colors.reduce((best, color) =>
    (counts.get(color.hex) ?? 0) < (counts.get(best.hex) ?? 0) ? color : best,
  ).hex
}

function groupOf(value: unknown): StatusGroup {
  return STATUS_GROUPS.includes(value as StatusGroup) ? (value as StatusGroup) : "notStarted"
}

/** Option drafts of a property; status groups come from the stored configuration. */
export function draftsFromProperty(property: DatabasePropertySummary): OptionDraft[] {
  let groups = new Map<string, StatusGroup>()
  let defaults = new Set<string>()
  try {
    const config = JSON.parse(property.configJson) as {
      options?: unknown
      defaultOptionIds?: unknown
    }
    if (Array.isArray(config.defaultOptionIds)) {
      defaults = new Set(
        config.defaultOptionIds.filter((id): id is string => typeof id === "string"),
      )
    }
    if (Array.isArray(config.options)) {
      groups = new Map(
        config.options
          .filter((option): option is Record<string, unknown> => Boolean(option))
          .map((option) => [String(option.id), groupOf(option.group)]),
      )
    }
  } catch {
    // The summary options are still enough to edit names and colors.
  }
  return property.options.map((option) => ({
    key: option.optionId,
    id: option.optionId,
    name: option.name,
    color: option.color,
    group: groups.get(option.optionId) ?? "notStarted",
    isDefault: defaults.has(option.optionId),
  }))
}

export function draftsToInputs(drafts: OptionDraft[], status: boolean): DatabaseOptionInput[] {
  return drafts.map((draft) => ({
    id: draft.id,
    name: draft.name.trim(),
    color: draft.color,
    group: status ? draft.group : null,
    isDefault: draft.isDefault,
  }))
}

export type OptionDraftProblem = "emptyName" | "duplicateName"

/** The first problem that would make the backend reject the list, with the row index. */
export function findDraftProblem(
  drafts: OptionDraft[],
): { index: number; problem: OptionDraftProblem } | null {
  const seen = new Set<string>()
  for (let index = 0; index < drafts.length; index += 1) {
    const name = drafts[index].name.trim()
    if (!name) return { index, problem: "emptyName" }
    const lowered = name.toLowerCase()
    if (seen.has(lowered)) return { index, problem: "duplicateName" }
    seen.add(lowered)
  }
  return null
}

/** Whether the list differs from what is stored (name, color, group or order). */
export function draftsChanged(drafts: OptionDraft[], property: DatabasePropertySummary): boolean {
  const stored = draftsFromProperty(property)
  if (stored.length !== drafts.length) return true
  return drafts.some((draft, index) => {
    const other = stored[index]
    return (
      draft.id !== other.id ||
      draft.name.trim() !== other.name ||
      draft.color.toLowerCase() !== other.color.toLowerCase() ||
      draft.group !== other.group ||
      draft.isDefault !== other.isDefault
    )
  })
}

/** Names of the options a new Status property starts with, first to last stage. */
export function defaultStatusOptionNames(t: (key: string) => string): string[] {
  return [
    t("databaseOptions.statusNotStarted"),
    t("databaseOptions.statusInProgress"),
    t("databaseOptions.statusDone"),
  ]
}

/**
 * The list after one option changes. Making an option the default of a Select or Status takes
 * the mark from the others; a Multi-select may have several.
 */
export function applyDraftPatch(
  drafts: OptionDraft[],
  key: string,
  patch: Partial<OptionDraft>,
  multiple: boolean,
): OptionDraft[] {
  return drafts.map((draft) => {
    if (draft.key === key) return { ...draft, ...patch }
    return patch.isDefault && !multiple && draft.isDefault ? { ...draft, isDefault: false } : draft
  })
}
