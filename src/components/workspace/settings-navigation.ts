import { MODULE_REGISTRY } from "./modules"

export const SETTINGS_SECTION_IDS = [
  "general",
  "appearance",
  "interface",
  "editor",
  "shortcuts",
  "modules",
  "sync",
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number]

/** A part of the interface that has no access to the workspace asks for Settings with this event. */
export const OPEN_SETTINGS_REQUEST_EVENT = "amby:open-settings-request"

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
  if (buttonId === "refresh") return { section: "sync" }
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
  creative: "activityBar.creativeSettings",
}

export function settingsLabelKeyForActivityButton(buttonId: string): string {
  if (buttonId === "refresh") return "activityBar.syncSettings"
  const { moduleId } = settingsTargetForActivityButton(buttonId)
  return (moduleId && MODULE_SETTINGS_LABEL_KEYS[moduleId]) ?? "activityBar.generalSettings"
}
