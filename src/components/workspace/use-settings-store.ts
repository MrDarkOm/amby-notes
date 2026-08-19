import * as React from "react"
import { create } from "zustand"
import { useTheme } from "next-themes"
import i18n from "@/lib/i18n"
import {
  EDITOR_CONTENT_WIDTH,
  EDITOR_FONT_SIZE,
  THEME_TOKENS,
  themeById,
  type ThemeDefinition,
} from "@/lib/themes"
import { DEFAULT_PREFS, loadSettings, saveSettingsPatch, type AppPreferences } from "./app-config"

interface SettingsStore {
  prefs: AppPreferences
  themes: ThemeDefinition[]
  hydrated: boolean
  lastSaveError: Error | null
  hydrate: () => Promise<void>
  /** Shallow-merge a patch into prefs and persist. Nested objects (editor,
   *  startup) must be passed whole by the caller. */
  setPrefs: (patch: Partial<AppPreferences>) => Promise<void>
  /** Replaces the validated global library of imported themes. */
  setThemes: (themes: ThemeDefinition[]) => Promise<void>
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  prefs: DEFAULT_PREFS,
  themes: [],
  hydrated: false,
  lastSaveError: null,
  hydrate: async () => {
    if (get().hydrated) return
    const s = await loadSettings()
    set({ prefs: s.prefs, themes: s.themes, hydrated: true })
  },
  setPrefs: async (patch) => {
    const prefs = { ...get().prefs, ...patch }
    set({ prefs, lastSaveError: null })
    try {
      await saveSettingsPatch({ prefs })
    } catch (err) {
      set({ lastSaveError: err instanceof Error ? err : new Error(String(err)) })
      throw err
    }
  },
  setThemes: async (themes) => {
    set({ themes, lastSaveError: null })
    try {
      await saveSettingsPatch({ themes })
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
  const { setTheme } = useTheme()

  React.useEffect(() => {
    void useSettingsStore.getState().hydrate()
  }, [])

  React.useEffect(() => {
    const root = document.documentElement
    root.dataset.accent = prefs.accent
    root.dataset.density = prefs.density
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
    if (i18n.language !== prefs.language) void i18n.changeLanguage(prefs.language)
  }, [prefs, setTheme, themes])

  return hydrated
}
