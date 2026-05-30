import * as React from "react"
import { create } from "zustand"
import { useTheme } from "next-themes"
import i18n from "@/lib/i18n"
import {
  DEFAULT_PREFS,
  loadSettings,
  saveSettingsPatch,
  type AppPreferences,
  type ContentWidth,
  type FontScale,
} from "./app-config"

interface SettingsStore {
  prefs: AppPreferences
  hydrated: boolean
  hydrate: () => Promise<void>
  /** Shallow-merge a patch into prefs and persist. Nested objects (editor,
   *  startup) must be passed whole by the caller. */
  setPrefs: (patch: Partial<AppPreferences>) => void
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  prefs: DEFAULT_PREFS,
  hydrated: false,
  hydrate: async () => {
    if (get().hydrated) return
    const s = await loadSettings()
    set({ prefs: s.prefs, hydrated: true })
  },
  setPrefs: (patch) => {
    const prefs = { ...get().prefs, ...patch }
    set({ prefs })
    void saveSettingsPatch({ prefs })
  },
}))

/** Editor base font size per scale (consumed via --editor-font-size). */
const FONT_SIZE: Record<FontScale, string> = {
  sm: "0.92rem",
  md: "1.02rem",
  lg: "1.16rem",
}

/** Editor content max-width per setting (consumed via --content-max-width). */
const CONTENT_WIDTH: Record<ContentWidth, string> = {
  normal: "48rem",
  wide: "64rem",
  full: "none",
}

/**
 * Hydrates the settings store once, then reflects preferences onto the DOM:
 * theme (next-themes), accent (data-accent → CSS vars in index.css), font size
 * (--editor-font-size), density (data-density) and i18n language. Must be
 * mounted inside ThemeProvider. Returns whether hydration has completed.
 */
export function useApplyPreferences(): boolean {
  const prefs = useSettingsStore((s) => s.prefs)
  const hydrated = useSettingsStore((s) => s.hydrated)
  const { setTheme } = useTheme()

  React.useEffect(() => {
    void useSettingsStore.getState().hydrate()
  }, [])

  React.useEffect(() => {
    const root = document.documentElement
    root.dataset.accent = prefs.accent
    root.dataset.density = prefs.density
    root.style.setProperty("--editor-font-size", FONT_SIZE[prefs.fontScale])
    root.style.setProperty("--content-max-width", CONTENT_WIDTH[prefs.editor.contentWidth])
    setTheme(prefs.theme)
    if (i18n.language !== prefs.language) void i18n.changeLanguage(prefs.language)
  }, [prefs, setTheme])

  return hydrated
}
