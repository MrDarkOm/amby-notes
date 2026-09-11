import * as React from "react"
import { create } from "zustand"
import { useTheme } from "next-themes"
import { emitTo, listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { LogicalSize } from "@tauri-apps/api/dpi"
import i18n from "@/lib/i18n"
import { isTauri } from "@/lib/storage"
import { adoptAsyncDisposer } from "@/lib/async-disposable"
import { errorType, logger } from "@/lib/logger"
import {
  APP_FONT_FAMILY,
  APP_FONT_SCALE,
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
  type WindowPreferences,
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
const MAIN_WINDOW_LABEL = "main"

let windowStateFlusher: (() => Promise<void>) | null = null

/** Flushes the latest native window dimensions before the close lifecycle destroys the window. */
export async function flushWindowStatePersistence(): Promise<void> {
  await windowStateFlusher?.()
}

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
 * (--app-font-scale / --editor-font-size), density (data-density) and i18n language. Must be
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
    return adoptAsyncDisposer(
      listen<PreferencesChangedPayload>(PREFERENCES_CHANGED_EVENT, (event) => {
        const patch: Partial<Pick<SettingsStore, "prefs" | "experimental" | "themes">> = {}
        if (event.payload.prefs) patch.prefs = event.payload.prefs
        if (event.payload.experimental) patch.experimental = event.payload.experimental
        if (event.payload.themes) patch.themes = event.payload.themes
        useSettingsStore.setState(patch)
      }),
    )
  }, [])

  React.useEffect(() => {
    if (!hydrated) return
    let cancelled = false
    const root = document.documentElement
    root.dataset.accent = prefs.accent
    root.dataset.density = prefs.density
    root.dataset.rainbowTree = String(prefs.rainbowTree)
    root.dataset.treeGuides = String(prefs.treeGuides)
    root.dataset.fontScale = prefs.fontScale
    root.style.setProperty("--app-font-family", APP_FONT_FAMILY[prefs.fontFamily])
    root.style.removeProperty("font-size")
    root.style.setProperty("--app-font-scale", APP_FONT_SCALE[prefs.fontScale])
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

/**
 * Restores the main window once preferences are ready and keeps its logical
 * size in the global settings file. The native close lifecycle calls the
 * exported flusher so a resize followed immediately by close is not lost.
 */
export function useWindowStatePersistence(enabled: boolean): boolean {
  const hydrated = useSettingsStore((s) => s.hydrated)
  const setPrefs = useSettingsStore((s) => s.setPrefs)
  const [restored, setRestored] = React.useState(!enabled)

  React.useEffect(() => {
    if (!enabled) {
      setRestored(true)
      return
    }
    if (!hydrated || !isTauri()) {
      setRestored(false)
      return
    }

    let cancelled = false
    const win = getCurrentWindow()
    if (win.label !== MAIN_WINDOW_LABEL) {
      setRestored(true)
      return () => {
        cancelled = true
      }
    }
    void (async () => {
      try {
        const saved = useSettingsStore.getState().prefs.window
        const currentlyMaximized = await win.isMaximized()
        if (saved.maximized) {
          if (!currentlyMaximized) await win.maximize()
        } else {
          if (currentlyMaximized) await win.unmaximize()
          await win.setSize(new LogicalSize(saved.width, saved.height))
        }
      } catch (error) {
        logger.warn("window_state.restore_failed", { errorType: errorType(error) })
      } finally {
        if (!cancelled) setRestored(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [enabled, hydrated])

  React.useEffect(() => {
    if (!enabled || !hydrated || !restored || !isTauri()) return

    const win = getCurrentWindow()
    if (win.label !== MAIN_WINDOW_LABEL) return
    let disposed = false
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    let pending: Partial<WindowPreferences> | null = null

    function mergeAndPersist(patch: Partial<WindowPreferences>): Promise<void> {
      const current = useSettingsStore.getState().prefs.window
      const next: WindowPreferences = { ...current, ...patch }
      if (
        next.width === current.width &&
        next.height === current.height &&
        next.leftPanelWidth === current.leftPanelWidth &&
        next.rightPanelWidth === current.rightPanelWidth &&
        next.maximized === current.maximized
      )
        return Promise.resolve()
      return setPrefs({ window: next }).catch((error) => {
        logger.warn("window_state.save_failed", { errorType: errorType(error) })
      })
    }

    async function readCurrentState(): Promise<Partial<WindowPreferences>> {
      const [size, scaleFactor, maximized] = await Promise.all([
        win.innerSize(),
        win.scaleFactor(),
        win.isMaximized(),
      ])
      if (maximized) return { maximized: true }
      return {
        width: Math.round(size.width / scaleFactor),
        height: Math.round(size.height / scaleFactor),
        maximized: false,
      }
    }

    function schedule(patch: Partial<WindowPreferences>) {
      pending = { ...pending, ...patch }
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        saveTimer = undefined
        const next = pending
        pending = null
        if (!disposed && next) void mergeAndPersist(next)
      }, 250)
    }

    const onResized = (event: { payload: { width: number; height: number } }) => {
      void Promise.all([win.scaleFactor(), win.isMaximized()])
        .then(([scaleFactor, maximized]) => {
          if (maximized) {
            schedule({ maximized: true })
            return
          }
          schedule({
            width: Math.round(event.payload.width / scaleFactor),
            height: Math.round(event.payload.height / scaleFactor),
            maximized: false,
          })
        })
        .catch((error) =>
          logger.warn("window_state.read_size_failed", { errorType: errorType(error) }),
        )
    }

    const cleanupResize = adoptAsyncDisposer(win.onResized(onResized), (error) =>
      logger.warn("window_state.resize_listen_failed", { errorType: errorType(error) }),
    )

    const flush = async () => {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = undefined
      }
      try {
        const current = await readCurrentState()
        const latest = { ...pending, ...current }
        pending = null
        if (!disposed) await mergeAndPersist(latest)
      } catch (error) {
        logger.warn("window_state.flush_failed", { errorType: errorType(error) })
      }
    }
    windowStateFlusher = flush

    return () => {
      disposed = true
      if (saveTimer) clearTimeout(saveTimer)
      if (windowStateFlusher === flush) windowStateFlusher = null
      cleanupResize()
    }
  }, [enabled, hydrated, restored, setPrefs])

  return !enabled || !hydrated || restored
}
