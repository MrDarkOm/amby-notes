import { MODULE_REGISTRY } from "./modules"

export const SETTINGS_SECTION_IDS = [
  "general",
  "appearance",
  "interface",
  "editor",
  "shortcuts",
  "modules",
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number]

export interface SettingsNavigationTarget {
  section: SettingsSectionId
  moduleId?: string
}

export function isSettingsSectionId(value: string | null): value is SettingsSectionId {
  return SETTINGS_SECTION_IDS.some((section) => section === value)
}

export function isSettingsModuleId(value: string | null): value is string {
  return MODULE_REGISTRY.some((module) => module.id === value)
}

/** Maps an activity-bar control to the part of Settings responsible for it. */
export function settingsTargetForActivityButton(buttonId: string): SettingsNavigationTarget {
  const moduleId = buttonId === "network" ? "graph" : buttonId
  if (isSettingsModuleId(moduleId)) return { section: "modules", moduleId }
  return { section: "general" }
}

const MODULE_SETTINGS_LABEL_KEYS: Record<string, string> = {
  tags: "activityBar.tagsSettings",
  favorites: "activityBar.favoritesSettings",
  databases: "activityBar.databasesSettings",
  history: "activityBar.historySettings",
  links: "activityBar.linksSettings",
  graph: "activityBar.graphSettings",
  sync: "activityBar.syncSettings",
  ai: "activityBar.aiSettings",
}

export function settingsLabelKeyForActivityButton(buttonId: string): string {
  const { moduleId } = settingsTargetForActivityButton(buttonId)
  return (moduleId && MODULE_SETTINGS_LABEL_KEYS[moduleId]) ?? "activityBar.generalSettings"
}
