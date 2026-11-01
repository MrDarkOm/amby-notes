import * as React from "react"
import i18n from "@/lib/i18n"
import type { ActivityButton, PanelId, Side } from "./panel-registry"
import {
  BASE_DEF_IDS,
  DEFAULT_MODULE_AVAILABILITY,
  availableModuleIds,
  contributedDefIds,
  findModule,
  isModuleAvailable,
  type ModuleContext,
  type ModuleAvailability,
} from "./modules"
import { transitionModuleLifecycle } from "./module-lifecycle"
import {
  BUILTIN_PRESETS,
  DEFAULT_PRESET_ID,
  getPreset,
  STANDARD_PRESET,
  parsePresetFile,
  presetFingerprint,
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
  saveWorkspaceActivePreset,
  saveWorkspaceConfigPatch,
  type LayoutConfig,
  type PanelScope,
} from "./app-config"
import {
  toCanonicalModuleId,
  toShortModuleId,
  moduleHost,
  getInstalledModuleIds,
  isModuleInstalled,
  STANDARD_MODULES,
} from "@/lib/modules"

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
  /** Modules enabled for the current layout. */
  activeModules: string[]
  /** Built-in + user presets, for the switcher. */
  presets: Preset[]
  /** Whether the active layout is shared globally or per-workspace. */
  panelScope: PanelScope
  setPanelScope: (scope: PanelScope) => void
  /** Enable or disable one built-in module in the current layout. */
  setModuleEnabled: (id: string, enabled: boolean, ctx: ModuleContext) => Promise<boolean>
  /** The settings window chose this preset: make it the running one without changing modules. */
  adoptPreset: (id: string) => Promise<void>
  /** Hot-swap to another preset: run module lifecycle, then apply its layout. */
  switchPreset: (id: string, ctx: ModuleContext) => Promise<boolean>
  /** Import a preset from its JSON text, store it, and switch to it. */
  importPreset: (text: string, ctx: ModuleContext) => ImportResult
  /** Serialize a preset to shareable JSON, or null if unknown. */
  exportPreset: (id: string) => string | null
  /** The running modules or dock differ from what the active preset stores. */
  modified: boolean
  /** The active preset is the person's own, so changes can be saved into it. */
  canSaveActive: boolean
  /** Store the running modules and dock as a new preset of the vault and make it the active one. */
  savePresetAs: (label: string) => void
  /** Store the running modules and dock into the active preset of the person's own. */
  saveActivePreset: () => void
  /** Return the modules and dock to what the active preset stores. */
  resetActivePreset: (ctx: ModuleContext) => Promise<boolean>
}

const sanitizeSide = (saved: Record<Side, PanelId | null>): Record<Side, PanelId | null> => {
  // "search" is no longer a panel (now a spotlight action) — sanitize stale state.
  const fix = (v: PanelId | null, fallback: PanelId): PanelId | null =>
    (v as string) === "search" ? fallback : v
  return { left: fix(saved.left, "files"), right: fix(saved.right, "info") }
}

/**
 * Union a persisted button layout with the preset's default buttons for active
 * modules, appending any that are missing. This is what makes a newly-added
 * module's button (e.g. AI) show up for users whose saved layout predates it —
 * while staying an ordinary, draggable activity-bar button they can move.
 */
const uniqueButtons = (buttons: ActivityButton[]): ActivityButton[] => {
  const seen = new Set<string>()
  return buttons.filter((button) => {
    if (seen.has(button.defId)) return false
    seen.add(button.defId)
    return true
  })
}

const mergeMissingButtons = (
  saved: ActivityButton[],
  preset: Preset,
  activeModules = preset.activeModules,
): ActivityButton[] => {
  const uniqueSaved = uniqueButtons(saved)
  const have = new Set(uniqueSaved.map((b) => b.defId))
  const missing = visibleLayout({ ...preset, activeModules }).filter((b) => !have.has(b.defId))
  if (missing.length === 0) return uniqueSaved
  const maxOrder: Record<string, number> = {}
  for (const b of uniqueSaved) maxOrder[b.side] = Math.max(maxOrder[b.side] ?? -1, b.order)
  return [
    ...uniqueSaved,
    ...missing.map((b) => {
      const order = (maxOrder[b.side] ?? -1) + 1
      maxOrder[b.side] = order
      return { ...b, side: b.side, order }
    }),
  ]
}

/**
 * Owns the activity-bar / panel state and ties it to the active preset.
 *
 * Persistence is tiered (app-config.ts): the `panelScope` toggle routes the
 * working layout between the global `settings.json` and the current vault's
 * `workspace.json`, while user-created presets always live per-vault. State is
 * hydrated asynchronously and re-hydrated whenever the vault or scope changes.
 */
export function usePresets(
  vault: string | null,
  experimental: ModuleAvailability = DEFAULT_MODULE_AVAILABILITY,
): UsePresets {
  const hasVault = !!vault
  const availableIds = React.useMemo(() => availableModuleIds(experimental), [experimental])

  const [panelScope, setPanelScopeState] = React.useState<PanelScope>("global")
  const [userPresets, setUserPresets] = React.useState<Preset[]>([])
  const presets = React.useMemo(() => [...BUILTIN_PRESETS, ...userPresets], [userPresets])

  const [activePresetId, setActivePresetId] = React.useState<string>(() => getPreset(null).id)
  const [activeModules, setActiveModules] = React.useState<string[]>(
    () => getPreset(null).activeModules,
  )
  const [activityButtons, setActivityButtons] = React.useState<ActivityButton[]>(() =>
    visibleLayout(getPreset(null)),
  )
  const [activeBySide, setActiveBySide] = React.useState<Record<Side, PanelId | null>>(() =>
    sanitizeSide(getPreset(null).activeBySide),
  )

  // Live refs so the stable callbacks below can diff without re-creating.
  const presetIdRef = React.useRef(activePresetId)
  React.useEffect(() => {
    presetIdRef.current = activePresetId
  }, [activePresetId])
  const activeModulesRef = React.useRef(activeModules)
  React.useEffect(() => {
    activeModulesRef.current = activeModules
  }, [activeModules])
  const presetsRef = React.useRef(presets)
  React.useEffect(() => {
    presetsRef.current = presets
  }, [presets])
  const buttonsRef = React.useRef(activityButtons)
  React.useEffect(() => {
    buttonsRef.current = activityButtons
  }, [activityButtons])
  const activeBySideRef = React.useRef(activeBySide)
  React.useEffect(() => {
    activeBySideRef.current = activeBySide
  }, [activeBySide])

  // Suppress persistence until the current (scope, vault) finishes hydrating, so
  // an async load never races a save that would clobber the file with stale state.
  const hydratedRef = React.useRef(false)

  // One-time: read the panelScope toggle from the global settings.
  React.useEffect(() => {
    let cancelled = false
    loadSettings().then((s) => {
      if (!cancelled) setPanelScopeState(s.panelScope)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Hydrate presets + layout for the current vault and scope. Declared BEFORE the
  // save effect so it can clear `hydratedRef` synchronously and block that save.
  React.useEffect(() => {
    let cancelled = false
    hydratedRef.current = false
    ;(async () => {
      const wsConfig = hasVault ? await loadWorkspaceConfig() : null
      const userP = wsConfig?.customPresets ?? []
      const layout = await loadLayout(panelScope, hasVault)
      if (cancelled) return
      const all = [...BUILTIN_PRESETS, ...userP]
      // The vault's file is where the settings window records the choice and where this hook
      // mirrors it, so it wins over the global layout, which may still name an older preset.
      const fromVault = wsConfig?.layout?.activePresetId
      const activeId =
        (fromVault && all.some((p) => p.id === fromVault) ? fromVault : null) ??
        layout.activePresetId ??
        fromVault ??
        DEFAULT_PRESET_ID
      const preset = all.find((p) => p.id === activeId) ?? getPreset(activeId)
      const rawStored =
        activeId === "standard"
          ? STANDARD_MODULES.map(toShortModuleId)
          : activeId === "minimal" || activeId === "simple"
            ? []
            : (wsConfig?.enabledModules ??
              (Array.isArray(layout.activeModules) ? layout.activeModules : preset.activeModules))
      const installedSet = await getInstalledModuleIds()
      const storedModules = rawStored
        .filter((id) => installedSet.has(toCanonicalModuleId(id)))
        .map((id) => (id.startsWith("amby.") ? id.slice(5) : id))
        .filter((id): id is string => typeof id === "string" && availableIds.includes(id))
      setUserPresets(userP)
      presetsRef.current = all
      setActivePresetId(activeId)
      activeModulesRef.current = storedModules
      setActiveModules(storedModules)
      setActivityButtons(
        layout.buttons
          ? mergeMissingButtons(layout.buttons, preset, storedModules)
          : visibleLayout({ ...preset, activeModules: storedModules }),
      )
      setActiveBySide(sanitizeSide(layout.activeBySide ?? preset.activeBySide))
      await moduleHost.syncWithWorkspace(storedModules, vault)
      hydratedRef.current = true
    })()
    return () => {
      cancelled = true
    }
  }, [availableIds, vault, panelScope, hasVault])

  // Persist the working layout to whichever tier panelScope selects, and keep enabledModules in workspace.json.
  React.useEffect(() => {
    if (!hydratedRef.current) return
    saveLayout(panelScope, hasVault, {
      activePresetId,
      activeModules,
      buttons: activityButtons,
      activeBySide,
    } satisfies LayoutConfig)
    if (hasVault) {
      void saveWorkspaceActivePreset(activePresetId, activeModules.map(toCanonicalModuleId))
    }
  }, [activePresetId, activeModules, activityButtons, activeBySide, panelScope, hasVault])

  const setPanelScope = React.useCallback((scope: PanelScope) => {
    setPanelScopeState(scope)
    saveSettingsPatch({ panelScope: scope })
  }, [])

  const resolve = React.useCallback(
    (id: string | null | undefined): Preset =>
      presetsRef.current.find((p) => p.id === id) ?? getPreset(id),
    [],
  )

  // A former version treated refresh as the sync module's action. Restore every
  // core button in existing layouts that may have been saved while it was off.
  React.useEffect(() => {
    setActivityButtons((current) => {
      const uniqueCurrent = uniqueButtons(current)
      const have = new Set(uniqueCurrent.map((button) => button.defId))
      const preset = { ...resolve(presetIdRef.current), activeModules: activeModulesRef.current }
      const missing = visibleLayout(preset).filter(
        (button) => BASE_DEF_IDS.has(button.defId) && !have.has(button.defId),
      )
      return missing.length === 0 && uniqueCurrent.length === current.length
        ? current
        : [...uniqueCurrent, ...missing]
    })
  }, [resolve, setActivityButtons])

  // Apply a resolved preset to live state, running the module lifecycle diff.
  const applyPreset = React.useCallback(
    async (next: Preset, ctx: ModuleContext, force = false): Promise<boolean> => {
      const installedSet = await getInstalledModuleIds()
      const supportedNext = {
        ...next,
        activeModules: next.activeModules
          .filter((id) => installedSet.has(toCanonicalModuleId(id)))
          .filter((id) => isModuleAvailable(id, experimental)),
      }
      const prev = { ...resolve(presetIdRef.current), activeModules: activeModulesRef.current }
      if (
        !force &&
        prev.id === supportedNext.id &&
        prev.activeModules.every((id) => supportedNext.activeModules.includes(id)) &&
        prev.activeModules.length === supportedNext.activeModules.length
      )
        return true
      const transition = await transitionModuleLifecycle(
        prev.activeModules,
        supportedNext.activeModules,
        ctx,
      )
      if (!transition.ok) {
        console.error("Failed to flush module before deactivation", transition.error)
        return false
      }
      // A preset made in the settings window keeps only its modules; it must not empty the docks,
      // so it takes the standard dock (limited to its modules) and the standard open panels.
      const keepsDock = supportedNext.layout.length > 0
      setActivePresetId(supportedNext.id)
      activeModulesRef.current = supportedNext.activeModules
      setActiveModules(supportedNext.activeModules)
      setActivityButtons(
        visibleLayout(
          keepsDock ? supportedNext : { ...supportedNext, layout: STANDARD_PRESET.layout },
        ),
      )
      setActiveBySide(keepsDock ? supportedNext.activeBySide : STANDARD_PRESET.activeBySide)
      if (hasVault) {
        saveWorkspaceConfigPatch({
          enabledModules: supportedNext.activeModules.map(toCanonicalModuleId),
        })
      }
      await moduleHost.syncWithWorkspace(supportedNext.activeModules, ctx.vault)
      return true
    },
    [experimental, hasVault, resolve],
  )

  const switchPreset = React.useCallback(
    (id: string, ctx: ModuleContext) => applyPreset(resolve(id), ctx),
    [applyPreset, resolve],
  )

  const setModuleEnabled = React.useCallback(
    async (id: string, enabled: boolean, ctx: ModuleContext): Promise<boolean> => {
      const module = findModule(id)
      if (!module || (enabled && !isModuleAvailable(id, experimental))) return false
      if (enabled && !(await isModuleInstalled(id))) {
        console.warn(`Module "${id}" is not installed and cannot be enabled.`)
        return false
      }
      const prevModules = activeModulesRef.current
      const wasEnabled = prevModules.includes(id)
      if (wasEnabled === enabled) return true

      const nextModules = enabled
        ? [...prevModules, id]
        : prevModules.filter((moduleId) => moduleId !== id)
      const transition = await transitionModuleLifecycle(prevModules, nextModules, ctx)
      if (!transition.ok) {
        console.error("Failed to flush module before deactivation", transition.error)
        return false
      }
      const moduleDefIds = new Set([...(module.panels ?? []), ...(module.actions ?? [])])
      const nextPreset = { ...resolve(presetIdRef.current), activeModules: nextModules }
      activeModulesRef.current = nextModules
      setActiveModules(nextModules)
      if (hasVault) {
        saveWorkspaceConfigPatch({
          enabledModules: nextModules.map(toCanonicalModuleId),
        })
      }
      await moduleHost.syncWithWorkspace(nextModules, ctx.vault)
      setActivityButtons((current) => {
        if (!enabled) return current.filter((button) => !moduleDefIds.has(button.defId))

        const existing = new Set(current.map((button) => button.defId))
        const orderBySide: Record<string, number> = {}
        for (const button of current)
          orderBySide[button.side] = Math.max(orderBySide[button.side] ?? -1, button.order)
        const additions = visibleLayout(nextPreset)
          .filter((button) => moduleDefIds.has(button.defId) && !existing.has(button.defId))
          .map((button) => {
            const order = (orderBySide[button.side] ?? -1) + 1
            orderBySide[button.side] = order
            return { ...button, order }
          })
        return [...current, ...additions]
      })
      const allowed = contributedDefIds(nextModules)
      setActiveBySide((current) => ({
        left: current.left && allowed.has(current.left) ? current.left : null,
        right: current.right && allowed.has(current.right) ? current.right : null,
      }))
      return true
    },
    [experimental, hasVault, resolve],
  )

  // The settings window chose a preset (or changed one of the user's own): take it as the running
  // one, with the vault's current list of presets, which only that window may have changed.
  const adoptPreset = React.useCallback(
    async (id: string) => {
      if (hasVault) {
        const userP = (await loadWorkspaceConfig()).customPresets
        presetsRef.current = [...BUILTIN_PRESETS, ...userP]
        setUserPresets(userP)
      }
      presetIdRef.current = id
      setActivePresetId(id)
    },
    [hasVault],
  )

  const importPreset = React.useCallback(
    (text: string, ctx: ModuleContext): ImportResult => {
      const parsed = parsePresetFile(text)
      if (!parsed) return { ok: false, error: i18n.t("presets.parseError") }

      // Never clobber a built-in id.
      let preset = parsed
      if (BUILTIN_PRESETS.some((p) => p.id === preset.id)) {
        preset = { ...preset, id: `${preset.id}-${Date.now()}` }
      }
      setUserPresets((prev) => {
        const next = [...prev.filter((p) => p.id !== preset.id), preset]
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
    const preset = presetsRef.current.find((p) => p.id === id)
    return preset ? serializePreset(preset) : null
  }, [])

  const activePreset = React.useMemo(
    () => presets.find((preset) => preset.id === activePresetId) ?? getPreset(activePresetId),
    [activePresetId, presets],
  )
  const modified = React.useMemo(() => {
    const stored = activePreset.activeModules
      .map(toShortModuleId)
      .filter((id) => availableIds.includes(id))
    // A preset made by the settings window keeps only its modules, so its dock is not compared.
    const storedButtons =
      activePreset.layout.length > 0
        ? visibleLayout({ ...activePreset, activeModules: activeModules })
        : activityButtons
    return (
      presetFingerprint(stored, storedButtons) !== presetFingerprint(activeModules, activityButtons)
    )
  }, [activePreset, activeModules, activityButtons, availableIds])
  const canSaveActive = !activePreset.builtin && !activePreset.locked

  const storeUserPresets = React.useCallback((next: Preset[]) => {
    presetsRef.current = [...BUILTIN_PRESETS, ...next]
    setUserPresets(next)
    saveWorkspaceConfigPatch({ customPresets: next })
  }, [])

  const savePresetAs = React.useCallback(
    (label: string) => {
      const preset: Preset = {
        id: `custom-${Date.now()}`,
        label: label.trim(),
        builtin: false,
        locked: false,
        activeModules: activeModulesRef.current.map(toShortModuleId),
        layout: buttonsRef.current,
        activeBySide: activeBySideRef.current,
      }
      storeUserPresets([...presetsRef.current.filter((p) => !p.builtin), preset])
      presetIdRef.current = preset.id
      setActivePresetId(preset.id)
    },
    [storeUserPresets],
  )

  const saveActivePreset = React.useCallback(() => {
    const id = presetIdRef.current
    const target = presetsRef.current.find((preset) => preset.id === id)
    if (!target || target.builtin || target.locked) return
    storeUserPresets(
      presetsRef.current
        .filter((preset) => !preset.builtin)
        .map((preset) =>
          preset.id === id
            ? {
                ...preset,
                activeModules: activeModulesRef.current.map(toShortModuleId),
                layout: buttonsRef.current,
                activeBySide: activeBySideRef.current,
              }
            : preset,
        ),
    )
  }, [storeUserPresets])

  const resetActivePreset = React.useCallback(
    (ctx: ModuleContext) => applyPreset(resolve(presetIdRef.current), ctx, true),
    [applyPreset, resolve],
  )

  return {
    modified,
    canSaveActive,
    savePresetAs,
    saveActivePreset,
    resetActivePreset,
    activityButtons,
    setActivityButtons,
    activeBySide,
    setActiveBySide,
    activePresetId,
    activeModules,
    presets,
    panelScope,
    setPanelScope,
    setModuleEnabled,
    switchPreset,
    adoptPreset,
    importPreset,
    exportPreset,
  }
}
