import * as React from "react"
import {
  loadActiveBySide,
  loadButtons,
  saveActiveBySide,
  saveButtons,
  type ActivityButton,
  type PanelId,
  type Side,
} from "./panel-registry"
import { runModuleLifecycle, type ModuleContext } from "./modules"
import {
  BUILTIN_PRESETS,
  getPreset,
  loadActivePresetId,
  loadUserPresets,
  parsePresetFile,
  saveActivePresetId,
  saveUserPresets,
  serializePreset,
  visibleLayout,
  type Preset,
} from "./presets"

export interface ImportResult {
  ok: boolean
  error?: string
}

export interface UsePresets {
  activityButtons: ActivityButton[]
  setActivityButtons: React.Dispatch<React.SetStateAction<ActivityButton[]>>
  activeBySide: Record<Side, PanelId | null>
  setActiveBySide: React.Dispatch<React.SetStateAction<Record<Side, PanelId | null>>>
  activePresetId: string
  /** Built-in + user presets, for the switcher. */
  presets: Preset[]
  /** Hot-swap to another preset: run module lifecycle, then apply its layout. */
  switchPreset: (id: string, ctx: ModuleContext) => void
  /** Import a preset from its JSON text, store it, and switch to it. */
  importPreset: (text: string, ctx: ModuleContext) => ImportResult
  /** Serialize a preset to shareable JSON, or null if unknown. */
  exportPreset: (id: string) => string | null
}

/**
 * Owns the activity-bar / panel state and ties it to the active preset. The
 * working layout (a user's drag-reordering) persists in localStorage and takes
 * precedence over the preset's default layout on load, so customizations stick.
 */
export function usePresets(): UsePresets {
  const [userPresets, setUserPresets] = React.useState<Preset[]>(() => loadUserPresets())
  const presets = React.useMemo(() => [...BUILTIN_PRESETS, ...userPresets], [userPresets])

  const [activePresetId, setActivePresetId] = React.useState<string>(
    () => loadActivePresetId() ?? getPreset(null).id,
  )

  const [activityButtons, setActivityButtons] = React.useState<ActivityButton[]>(
    () => loadButtons() ?? getPreset(loadActivePresetId()).layout,
  )

  const [activeBySide, setActiveBySide] = React.useState<Record<Side, PanelId | null>>(() => {
    const saved = loadActiveBySide() ?? getPreset(loadActivePresetId()).activeBySide
    // "search" is no longer a panel (now a spotlight action) — sanitize stale state.
    const fix = (v: PanelId | null, fallback: PanelId): PanelId | null =>
      (v as string) === "search" ? fallback : v
    return { left: fix(saved.left, "files"), right: fix(saved.right, "info") }
  })

  React.useEffect(() => { saveButtons(activityButtons) }, [activityButtons])
  React.useEffect(() => { saveActiveBySide(activeBySide) }, [activeBySide])
  React.useEffect(() => { saveActivePresetId(activePresetId) }, [activePresetId])

  // Live refs so the stable callbacks below can diff without re-creating.
  const presetIdRef = React.useRef(activePresetId)
  React.useEffect(() => { presetIdRef.current = activePresetId }, [activePresetId])
  const presetsRef = React.useRef(presets)
  React.useEffect(() => { presetsRef.current = presets }, [presets])

  const resolve = React.useCallback(
    (id: string | null | undefined): Preset =>
      presetsRef.current.find(p => p.id === id) ?? getPreset(id),
    [],
  )

  // Apply a resolved preset to live state, running the module lifecycle diff.
  const applyPreset = React.useCallback((next: Preset, ctx: ModuleContext) => {
    const prev = resolve(presetIdRef.current)
    if (prev.id === next.id) return
    runModuleLifecycle(prev.activeModules, next.activeModules, ctx)
    setActivePresetId(next.id)
    setActivityButtons(visibleLayout(next))
    setActiveBySide(next.activeBySide)
  }, [resolve])

  const switchPreset = React.useCallback(
    (id: string, ctx: ModuleContext) => applyPreset(resolve(id), ctx),
    [applyPreset, resolve],
  )

  const importPreset = React.useCallback(
    (text: string, ctx: ModuleContext): ImportResult => {
      const parsed = parsePresetFile(text)
      if (!parsed) return { ok: false, error: "Не удалось разобрать файл пресета" }

      // Never clobber a built-in id.
      let preset = parsed
      if (BUILTIN_PRESETS.some(p => p.id === preset.id)) {
        preset = { ...preset, id: `${preset.id}-${Date.now()}` }
      }
      setUserPresets(prev => {
        const next = [...prev.filter(p => p.id !== preset.id), preset]
        saveUserPresets(next)
        presetsRef.current = [...BUILTIN_PRESETS, ...next]
        return next
      })
      applyPreset(preset, ctx)
      return { ok: true }
    },
    [applyPreset],
  )

  const exportPreset = React.useCallback((id: string): string | null => {
    const preset = presetsRef.current.find(p => p.id === id)
    return preset ? serializePreset(preset) : null
  }, [])

  return {
    activityButtons,
    setActivityButtons,
    activeBySide,
    setActiveBySide,
    activePresetId,
    presets,
    switchPreset,
    importPreset,
    exportPreset,
  }
}
