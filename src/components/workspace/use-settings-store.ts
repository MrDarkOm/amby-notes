import * as React from "react"
import { create } from "zustand"
import { useTheme } from "next-themes"
import { emitTo, listen } from "@tauri-apps/api/event"
import i18n from "@/lib/i18n"
import { isTauri } from "@/lib/storage"
import {
  APP_FONT_FAMILY,
  APP_FONT_SIZE,
  EDITOR_CONTENT_WIDTH,
  EDITOR_FONT_SIZE,
  THEME_TOKENS,
  themeById,
  type ThemeDefinition,
} from "@/lib/themes"
import {
  DEFAULT_EXPERIMENTAL,
  DEFAULT_PREFS,
  loadSettings,
  saveSettingsPatch,
  type AppPreferences,
  type ExperimentalSettings,
} from "./app-config"

interface SettingsStore {
  prefs: AppPreferences
  experimental: ExperimentalSettings
  themes: ThemeDefinition[]
  hydrated: boolean
  lastSaveError: Error | null
  hydrate: () => Promise<void>
  /** Shallow-merge a patch into prefs and persist. Nested objects (editor,
   *  startup) must be passed whole by the caller. */
  setPrefs: (patch: Partial<AppPreferences>) => Promise<void>
  /** Updates feature gates without implicitly enabling a module. */
  setExperimental: (patch: Partial<ExperimentalSettings>) => Promise<void>
  /** Replaces the validated global library of imported themes. */
  setThemes: (themes: ThemeDefinition[]) => Promise<void>
}

const PREFERENCES_CHANGED_EVENT = "amby:preferences-changed"

interface PreferencesChangedPayload {
  prefs?: AppPreferences
  experimental?: ExperimentalSettings
  themes?: ThemeDefinition[]
}

function broadcastPreferences(payload: PreferencesChangedPayload): void {
  if (!isTauri()) return
  void Promise.allSettled([
    emitTo<PreferencesChangedPayload>("main", PREFERENCES_CHANGED_EVENT, payload),
    emitTo<PreferencesChangedPayload>("settings", PREFERENCES_CHANGED_EVENT, payload),
  ])
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  prefs: DEFAULT_PREFS,
  experimental: DEFAULT_EXPERIMENTAL,
  themes: [],
  hydrated: false,
  lastSaveError: null,
  hydrate: async () => {
    if (get().hydrated) return
    const s = await loadSettings()
    set({ prefs: s.prefs, experimental: s.experimental, themes: s.themes, hydrated: true })
  },
  setPrefs: async (patch) => {
    const prefs = { ...get().prefs, ...patch }
    set({ prefs, lastSaveError: null })
    try {
      await saveSettingsPatch({ prefs })
      broadcastPreferences({ prefs })
    } catch (err) {
      set({ lastSaveError: err instanceof Error ? err : new Error(String(err)) })
      throw err
    }
  },
  setExperimental: async (patch) => {
    const experimental = { ...get().experimental, ...patch }
    set({ experimental, lastSaveError: null })
    try {
      await saveSettingsPatch({ experimental })
      broadcastPreferences({ experimental })
    } catch (err) {
      set({ lastSaveError: err instanceof Error ? err : new Error(String(err)) })
      throw err
    }
  },
  setThemes: async (themes) => {
    set({ themes, lastSaveError: null })
    try {
      await saveSettingsPatch({ themes })
      broadcastPreferences({ themes })
    } catch (err) {
      set({ lastSaveError: err instanceof Error ? err : new Error(String(err)) })
      throw err
    }
  },
}))

/**
 * Hydrates the settings store once, then reflects preferences onto the DOM:
 * theme (next-themes), accent (data-accent → CSS vars in themes/app.css), font size
 * (--editor-font-size), density (data-density) and i18n language. Must be
 * mounted inside ThemeProvider. Returns whether hydration has completed.
 */
export function useApplyPreferences(): boolean {
  const prefs = useSettingsStore((s) => s.prefs)
  const themes = useSettingsStore((s) => s.themes)
  const hydrated = useSettingsStore((s) => s.hydrated)
  const [applied, setApplied] = React.useState(false)
  const { setTheme } = useTheme()

  React.useEffect(() => {
    void useSettingsStore.getState().hydrate()
  }, [])

  React.useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    listen<PreferencesChangedPayload>(PREFERENCES_CHANGED_EVENT, (event) => {
      const patch: Partial<Pick<SettingsStore, "prefs" | "experimental" | "themes">> = {}
      if (event.payload.prefs) patch.prefs = event.payload.prefs
      if (event.payload.experimental) patch.experimental = event.payload.experimental
      if (event.payload.themes) patch.themes = event.payload.themes
      useSettingsStore.setState(patch)
    })
      .then((dispose) => {
        unlisten = dispose
      })
      .catch(() => {})
    return () => unlisten?.()
  }, [])

  React.useEffect(() => {
    if (!hydrated) return
    let cancelled = false
    const root = document.documentElement
    root.dataset.accent = prefs.accent
    root.dataset.density = prefs.density
    root.dataset.rainbowTree = String(prefs.rainbowTree)
    root.dataset.fontScale = prefs.fontScale
    root.style.setProperty("--app-font-family", APP_FONT_FAMILY[prefs.fontFamily])
    root.style.fontSize = APP_FONT_SIZE[prefs.fontScale]
    root.style.setProperty("--editor-font-size", EDITOR_FONT_SIZE[prefs.fontScale])
    root.style.setProperty("--content-max-width", EDITOR_CONTENT_WIDTH[prefs.editor.contentWidth])
    const theme = themeById(prefs.theme, themes)
    setTheme(theme.mode)
    root.dataset.ambyTheme = theme.id
    // Remove a previously selected theme before applying the next one. Theme
    // tokens are a strict allow-list, so an imported file cannot affect layout
    // or load remote content through arbitrary CSS.
    for (const token of THEME_TOKENS) root.style.removeProperty(token)
    for (const [token, value] of Object.entries(theme.tokens)) root.style.setProperty(token, value)
    // Keep the early bootstrap in sync so a Vite/Tauri full reload starts in
    // the same light/dark mode instead of exposing an unstyled white canvas.
    try {
      localStorage.setItem("amby:theme-mode", theme.mode)
      localStorage.setItem("theme", theme.mode)
    } catch {
      // Storage can be unavailable in restricted browser contexts.
    }
    const languageChange =
      i18n.language !== prefs.language ? i18n.changeLanguage(prefs.language) : Promise.resolve()
    void languageChange.finally(() => {
      if (!cancelled) setApplied(true)
    })
    return () => {
      cancelled = true
    }
  }, [hydrated, prefs, setTheme, themes])

  return hydrated && applied
}
