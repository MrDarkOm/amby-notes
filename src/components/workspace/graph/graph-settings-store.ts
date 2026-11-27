import { create } from "zustand"
import { loadWorkspaceConfig, saveWorkspaceConfigPatch } from "../app-config"
import {
  DEFAULT_GRAPH_SETTINGS,
  normalizeGraphSettings,
  type GraphSettings,
} from "./graph-settings"

/** Sliders change many times a second; the file is written once they settle. */
const SAVE_DELAY_MS = 400

interface GraphSettingsState {
  settings: GraphSettings
  /** Reads the settings of the open vault from `workspace.json` (`moduleSettings.graph`). */
  load: () => Promise<void>
  update: (patch: Partial<GraphSettings>) => void
  /** Returns every setting to its default and saves that. */
  reset: () => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSave(settings: GraphSettings) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void (async () => {
      try {
        const config = await loadWorkspaceConfig()
        await saveWorkspaceConfigPatch({
          moduleSettings: { ...(config.moduleSettings ?? {}), graph: settings },
        })
      } catch (error) {
        console.error("Failed to save graph settings to workspace.json:", error)
      }
    })()
  }, SAVE_DELAY_MS)
}

export const useGraphSettingsStore = create<GraphSettingsState>((set, get) => ({
  settings: DEFAULT_GRAPH_SETTINGS,
  load: async () => {
    try {
      const config = await loadWorkspaceConfig()
      // A change made while the file was being read is newer than the file.
      if (saveTimer) return
      set({ settings: normalizeGraphSettings(config.moduleSettings?.graph) })
    } catch {
      set({ settings: DEFAULT_GRAPH_SETTINGS })
    }
  },
  update: (patch) => {
    const settings = { ...get().settings, ...patch }
    set({ settings })
    scheduleSave(settings)
  },
  reset: () => {
    set({ settings: DEFAULT_GRAPH_SETTINGS })
    scheduleSave(DEFAULT_GRAPH_SETTINGS)
  },
}))
