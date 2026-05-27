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
  getPreset,
  loadActivePresetId,
  saveActivePresetId,
  visibleLayout,
} from "./presets"

export interface UsePresets {
  activityButtons: ActivityButton[]
  setActivityButtons: React.Dispatch<React.SetStateAction<ActivityButton[]>>
  activeBySide: Record<Side, PanelId | null>
  setActiveBySide: React.Dispatch<React.SetStateAction<Record<Side, PanelId | null>>>
  activePresetId: string
  /** Hot-swap to another preset: run module lifecycle, then apply its layout. */
  switchPreset: (id: string, ctx: ModuleContext) => void
}

/**
 * Owns the activity-bar / panel state and ties it to the active preset. The
 * working layout (a user's drag-reordering) persists in localStorage and takes
 * precedence over the preset's default layout on load, so customizations stick.
 */
export function usePresets(): UsePresets {
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

  // Track the live preset id so switchPreset can diff modules without nesting
  // side effects inside a state updater.
  const presetIdRef = React.useRef(activePresetId)
  React.useEffect(() => { presetIdRef.current = activePresetId }, [activePresetId])

  const switchPreset = React.useCallback((id: string, ctx: ModuleContext) => {
    const prevPreset = getPreset(presetIdRef.current)
    const nextPreset = getPreset(id)
    if (prevPreset.id === nextPreset.id) return
    runModuleLifecycle(prevPreset.activeModules, nextPreset.activeModules, ctx)
    setActivePresetId(nextPreset.id)
    setActivityButtons(visibleLayout(nextPreset))
    setActiveBySide(nextPreset.activeBySide)
  }, [])

  return {
    activityButtons,
    setActivityButtons,
    activeBySide,
    setActiveBySide,
    activePresetId,
    switchPreset,
  }
}
