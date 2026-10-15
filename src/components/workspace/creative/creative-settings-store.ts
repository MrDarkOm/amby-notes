import { create } from "zustand"
import { emit } from "@tauri-apps/api/event"
import { isTauri } from "@/lib/storage"
import { loadWorkspaceConfig, saveWorkspaceConfigPatch } from "../app-config"
import { normalizeWorkshopPath } from "./workshop-location"

/**
 * Settings open in their own window with their own copy of this store, so a saved change is
 * announced to every window; the main window listens (see `useProjectController`). A payload
 * carries only the setting that changed.
 */
export const CREATIVE_SETTINGS_CHANGED_EVENT = "amby:creative-settings-changed"

export interface CreativeSettingsChangedPayload {
  showInTree?: boolean
  /** The new workshop folder; `null` returns to the default of the language. */
  workshopPath?: string | null
}

interface CreativeSettingsState {
  /** Whether the creative folders and databases are listed in the file tree. */
  showInTree: boolean
  /**
   * The vault-relative folder the author chose for the workshop, or `null` while it is left to
   * the default (the localized "Workshop") and to the one marker found in the vault.
   */
  workshopPath: string | null
  /** Reads the settings of the open vault from `workspace.json`. */
  load: () => Promise<void>
  setShowInTree: (value: boolean) => Promise<void>
  /** Saves the folder; the files of an existing workshop are not moved. Rejects on failure. */
  setWorkshopPath: (value: string | null) => Promise<void>
}

type CreativeModuleSettings = Record<string, unknown> & {
  showInTree?: unknown
  workshopPath?: unknown
}

function moduleSettingsOf(config: { moduleSettings?: Record<string, unknown> } | null | undefined) {
  const raw = config?.moduleSettings?.creative
  return raw && typeof raw === "object" ? (raw as CreativeModuleSettings) : {}
}

async function saveCreative(
  edit: (current: CreativeModuleSettings) => CreativeModuleSettings,
): Promise<void> {
  const config = await loadWorkspaceConfig()
  await saveWorkspaceConfigPatch({
    moduleSettings: {
      ...(config.moduleSettings ?? {}),
      creative: edit(moduleSettingsOf(config)),
    },
  })
}

/**
 * Preferences of the creative module that live in the workspace file of the vault
 * (`moduleSettings.creative`). Showing the creative folders is on unless switched off,
 * so a vault written before the setting existed looks as it did.
 */
export const useCreativeSettingsStore = create<CreativeSettingsState>((set) => ({
  showInTree: true,
  workshopPath: null,
  load: async () => {
    try {
      const saved = moduleSettingsOf(await loadWorkspaceConfig())
      set({
        showInTree: typeof saved.showInTree === "boolean" ? saved.showInTree : true,
        workshopPath:
          typeof saved.workshopPath === "string" ? normalizeWorkshopPath(saved.workshopPath) : null,
      })
    } catch {
      // The file tree keeps listing everything when the preference cannot be read.
      set({ showInTree: true, workshopPath: null })
    }
  },
  setShowInTree: async (value) => {
    set({ showInTree: value })
    try {
      await saveCreative((current) => ({ ...current, showInTree: value }))
      if (isTauri()) {
        await emit<CreativeSettingsChangedPayload>(CREATIVE_SETTINGS_CHANGED_EVENT, {
          showInTree: value,
        })
      }
    } catch (error) {
      console.error("Failed to save creative settings to workspace.json:", error)
    }
  },
  setWorkshopPath: async (value) => {
    const next = value === null ? null : normalizeWorkshopPath(value)
    if (value !== null && next === null) {
      throw new Error("The workshop folder must be a folder inside the vault")
    }
    await saveCreative((current) => {
      const { workshopPath: _previous, ...rest } = current
      return next === null ? rest : { ...rest, workshopPath: next }
    })
    set({ workshopPath: next })
    if (isTauri()) {
      await emit<CreativeSettingsChangedPayload>(CREATIVE_SETTINGS_CHANGED_EVENT, {
        workshopPath: next,
      })
    }
  },
}))
