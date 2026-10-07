import * as React from "react"
import type { SavedView } from "./use-saved-view"
import { applySettingsPatch, parseViewSettings, type SettingsPatch } from "./view-config"

/**
 * The settings of a view that lives in a note block rather than in the database.
 * Same shape as a saved view, so the editors and layouts cannot tell them apart,
 * but a change goes to the owner as a new config and nowhere else.
 */
export function useLocalView(
  config: Record<string, unknown>,
  onConfigChange: (next: Record<string, unknown>) => void,
): SavedView {
  const latest = React.useRef(config)
  latest.current = config
  const notify = React.useRef(onConfigChange)
  notify.current = onConfigChange

  const settings = React.useMemo(() => parseViewSettings(JSON.stringify(config)), [config])
  const update = React.useCallback((patch: SettingsPatch) => {
    const next = JSON.parse(applySettingsPatch(JSON.stringify(latest.current), patch)) as Record<
      string,
      unknown
    >
    // Two changes in one tick build on each other instead of the old config.
    latest.current = next
    notify.current(next)
  }, [])
  const flush = React.useCallback(async () => true, [])

  return React.useMemo(
    () => ({ settings, ready: true, error: null, update, flush }),
    [settings, update, flush],
  )
}
