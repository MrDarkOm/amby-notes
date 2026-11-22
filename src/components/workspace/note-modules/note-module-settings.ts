import { loadWorkspaceConfig, saveWorkspaceConfigPatch } from "../app-config"

/** The defaults Rust uses (`amby_core::note_templates`) when a setting is missing. */
export const DEFAULT_TEMPLATES_FOLDER = "Templates"
export const DEFAULT_DAILY_FOLDER = "Daily"

export interface TemplatesSettings {
  folder: string
}

export interface DailySettings {
  /** Vault-relative; "." for the vault root. */
  folder: string
  template: string | null
}

type Section = Record<string, unknown>

function sectionOf(
  config: { moduleSettings?: Record<string, unknown> } | null | undefined,
  key: "templates" | "daily",
): Section {
  const raw = config?.moduleSettings?.[key]
  return raw && typeof raw === "object" ? (raw as Section) : {}
}

/**
 * A folder as Rust accepts it (`note_templates::folder`): vault-relative, no `..`, no hidden or
 * absolute paths; `.` is the root where allowed. `null` when it is not acceptable.
 */
export function normalizeModuleFolder(value: string, rootAllowed: boolean): string | null {
  const text = value.trim().replace(/\\/gu, "/").replace(/\/+$/u, "")
  if (text === ".") return rootAllowed ? "." : null
  if (!text || text.startsWith("/") || /^[A-Za-z]:/u.test(text)) return null
  const parts = text.split("/").filter((part) => part !== "")
  if (parts.some((part) => part === ".." || part.startsWith("."))) return null
  return parts.join("/")
}

export async function loadNoteModuleSettings(): Promise<{
  templates: TemplatesSettings
  daily: DailySettings
}> {
  const config = await loadWorkspaceConfig()
  const templates = sectionOf(config, "templates")
  const daily = sectionOf(config, "daily")
  const folder = (value: unknown, fallback: string, rootAllowed: boolean) =>
    typeof value === "string" ? (normalizeModuleFolder(value, rootAllowed) ?? fallback) : fallback
  return {
    templates: { folder: folder(templates.folder, DEFAULT_TEMPLATES_FOLDER, false) },
    daily: {
      folder: folder(daily.folder, DEFAULT_DAILY_FOLDER, true),
      template:
        typeof daily.template === "string" && daily.template.trim() ? daily.template.trim() : null,
    },
  }
}

/** Saves one field of a module's settings and keeps the others (and unknown ones) as they are. */
export async function saveNoteModuleSetting(
  key: "templates" | "daily",
  field: "folder" | "template",
  value: string | null,
): Promise<void> {
  const config = await loadWorkspaceConfig()
  const { [field]: _previous, ...rest } = sectionOf(config, key)
  await saveWorkspaceConfigPatch({
    moduleSettings: {
      ...(config.moduleSettings ?? {}),
      [key]: value === null ? rest : { ...rest, [field]: value },
    },
  })
}
