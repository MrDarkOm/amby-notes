import * as React from "react"
import type { ActivityButton, PanelId, Side } from "./panel-registry"
import { runModuleLifecycle, type ModuleContext } from "./modules"
import {
  BUILTIN_PRESETS,
  getPreset,
  parsePresetFile,
  serializePreset,
  visibleLayout,
  type Preset,
} from "./presets"
import {
  loadLayout,
  loadSettings,
  loadWorkspaceConfig,
  saveLayout,
  saveSettingsPatch,
  saveWorkspaceConfigPatch,
  type LayoutConfig,
  type PanelScope,
} from "./app-config"

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
  /** Whether the active layout is shared globally or per-workspace. */
  panelScope: PanelScope
  setPanelScope: (scope: PanelScope) => void
  /** Hot-swap to another preset: run module lifecycle, then apply its layout. */
  switchPreset: (id: string, ctx: ModuleContext) => void
  /** Import a preset from its JSON text, store it, and switch to it. */
  importPreset: (text: string, ctx: ModuleContext) => ImportResult
  /** Serialize a preset to shareable JSON, or null if unknown. */
  exportPreset: (id: string) => string | null
}

const sanitizeSide = (
  saved: Record<Side, PanelId | null>,
): Record<Side, PanelId | null> => {
  // "search" is no longer a panel (now a spotlight action) — sanitize stale state.
  const fix = (v: PanelId | null, fallback: PanelId): PanelId | null =>
    (v as string) === "search" ? fallback : v
  return { left: fix(saved.left, "files"), right: fix(saved.right, "info") }
}

/**
 * Owns the activity-bar / panel state and ties it to the active preset.
 *
 * Persistence is tiered (app-config.ts): the `panelScope` toggle routes the
 * working layout between the global `settings.json` and the current vault's
 * `workspace.json`, while user-created presets always live per-vault. State is
 * hydrated asynchronously and re-hydrated whenever the vault or scope changes.
 */
export function usePresets(vault: string | null): UsePresets {
  const hasVault = !!vault

  const [panelScope, setPanelScopeState] = React.useState<PanelScope>("global")
  const [userPresets, setUserPresets] = React.useState<Preset[]>([])
  const presets = React.useMemo(() => [...BUILTIN_PRESETS, ...userPresets], [userPresets])

  const [activePresetId, setActivePresetId] = React.useState<string>(() => getPreset(null).id)
  const [activityButtons, setActivityButtons] = React.useState<ActivityButton[]>(
    () => visibleLayout(getPreset(null)),
  )
  const [activeBySide, setActiveBySide] = React.useState<Record<Side, PanelId | null>>(
    () => sanitizeSide(getPreset(null).activeBySide),
  )

  // Live refs so the stable callbacks below can diff without re-creating.
  const presetIdRef = React.useRef(activePresetId)
  React.useEffect(() => { presetIdRef.current = activePresetId }, [activePresetId])
  const presetsRef = React.useRef(presets)
  React.useEffect(() => { presetsRef.current = presets }, [presets])

  // Suppress persistence until the current (scope, vault) finishes hydrating, so
  // an async load never races a save that would clobber the file with stale state.
  const hydratedRef = React.useRef(false)

  // One-time: read the panelScope toggle from the global settings.
  React.useEffect(() => {
    let cancelled = false
    loadSettings().then(s => { if (!cancelled) setPanelScopeState(s.panelScope) })
    return () => { cancelled = true }
  }, [])

  // Hydrate presets + layout for the current vault and scope. Declared BEFORE the
  // save effect so it can clear `hydratedRef` synchronously and block that save.
  React.useEffect(() => {
    let cancelled = false
    hydratedRef.current = false
    ;(async () => {
      const userP = hasVault ? (await loadWorkspaceConfig()).customPresets : []
      const layout = await loadLayout(panelScope, hasVault)
      if (cancelled) return
      const all = [...BUILTIN_PRESETS, ...userP]
      const preset = all.find(p => p.id === layout.activePresetId) ?? getPreset(layout.activePresetId)
      setUserPresets(userP)
      presetsRef.current = all
      setActivePresetId(layout.activePresetId ?? preset.id)
      setActivityButtons(layout.buttons ?? visibleLayout(preset))
      setActiveBySide(sanitizeSide(layout.activeBySide ?? preset.activeBySide))
      hydratedRef.current = true
    })()
    return () => { cancelled = true }
  }, [vault, panelScope, hasVault])

  // Persist the working layout to whichever tier panelScope selects.
  React.useEffect(() => {
    if (!hydratedRef.current) return
    saveLayout(panelScope, hasVault, {
      activePresetId,
      buttons: activityButtons,
      activeBySide,
    } satisfies LayoutConfig)
  }, [activePresetId, activityButtons, activeBySide, panelScope, hasVault])

  const setPanelScope = React.useCallback((scope: PanelScope) => {
    setPanelScopeState(scope)
    saveSettingsPatch({ panelScope: scope })
  }, [])

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
        saveWorkspaceConfigPatch({ customPresets: next })
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
    panelScope,
    setPanelScope,
    switchPreset,
    importPreset,
    exportPreset,
  }
}
