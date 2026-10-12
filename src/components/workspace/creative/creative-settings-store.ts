import { create } from "zustand"
import { emit } from "@tauri-apps/api/event"
import { isTauri } from "@/lib/storage"
import { loadWorkspaceConfig, saveWorkspaceConfigPatch } from "../app-config"

/**
 * Settings open in their own window with their own copy of this store, so a saved change is
 * announced to every window; the main window listens (see `useProjectController`).
 */
export const CREATIVE_SETTINGS_CHANGED_EVENT = "amby:creative-settings-changed"

export interface CreativeSettingsChangedPayload {
  showInTree: boolean
}

interface CreativeSettingsState {
  /** Whether the creative folders and databases are listed in the file tree. */
  showInTree: boolean
  /** Reads the setting of the open vault from `workspace.json`. */
  load: () => Promise<void>
  setShowInTree: (value: boolean) => Promise<void>
}

type CreativeModuleSettings = Record<string, unknown> & { showInTree?: unknown }

function moduleSettingsOf(config: { moduleSettings?: Record<string, unknown> } | null | undefined) {
  const raw = config?.moduleSettings?.creative
  return raw && typeof raw === "object" ? (raw as CreativeModuleSettings) : {}
}

/**
 * Preferences of the creative module that live in the workspace file of the vault
 * (`moduleSettings.creative`). Showing the creative folders is on unless switched off,
 * so a vault written before the setting existed looks as it did.
 */
export const useCreativeSettingsStore = create<CreativeSettingsState>((set) => ({
  showInTree: true,
  load: async () => {
    try {
      const saved = moduleSettingsOf(await loadWorkspaceConfig()).showInTree
      set({ showInTree: typeof saved === "boolean" ? saved : true })
    } catch {
      // The file tree keeps listing everything when the preference cannot be read.
      set({ showInTree: true })
    }
  },
  setShowInTree: async (value) => {
    set({ showInTree: value })
    try {
      const config = await loadWorkspaceConfig()
      await saveWorkspaceConfigPatch({
        moduleSettings: {
          ...(config.moduleSettings ?? {}),
          creative: { ...moduleSettingsOf(config), showInTree: value },
        },
      })
      if (isTauri()) {
        await emit<CreativeSettingsChangedPayload>(CREATIVE_SETTINGS_CHANGED_EVENT, {
          showInTree: value,
        })
      }
    } catch (error) {
      console.error("Failed to save creative settings to workspace.json:", error)
    }
  },
}))
