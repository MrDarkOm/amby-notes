import * as React from "react"
import type { DatabaseViewSummary } from "@/lib/storage"
import { useLegacyHiddenPropertiesMigration } from "./legacy-hidden-properties"
import { useSavedView, type SavedView } from "./use-saved-view"
import {
  fieldKey,
  fieldRefFromKey,
  flatConditions,
  toQueryFilter,
  toQuerySorts,
} from "./view-config"

/**
 * What a view's settings turn into for the UI and the query: hidden fields,
 * filter, sorts, table layout. It works on any source of settings: a saved view
 * of the database, or the copy that belongs to a block in a note.
 */
export function useViewSettingsDerived({
  savedView,
  viewId,
}: {
  savedView: SavedView
  viewId: string | null
}) {
  const { settings: viewSettings, update: updateViewSettings } = savedView

  const activeHiddenPropertyIds = React.useMemo(
    () => new Set<string>(viewSettings.hidden),
    [viewSettings.hidden],
  )
  const setViewHiddenPropertyIds = React.useCallback(
    (
      targetViewId: string,
      ids: Set<string> | string[] | ((current: Set<string>) => Set<string>),
    ) => {
      if (targetViewId !== viewId) return
      const current = new Set(viewSettings.hidden)
      const next = new Set(typeof ids === "function" ? ids(current) : ids)
      // An unchanged list must not become a new settings object: the table's
      // clean-up effect reports its list on every pass and would loop.
      if (next.size === current.size && [...next].every((id) => current.has(id))) return
      updateViewSettings({ hidden: Array.from(next) })
    },
    [viewId, updateViewSettings, viewSettings.hidden],
  )
  const togglePropertyVisibility = React.useCallback(
    (propertyId: string) => {
      if (!viewId) return
      setViewHiddenPropertyIds(viewId, (current) => {
        const next = new Set(current)
        if (next.has(propertyId)) next.delete(propertyId)
        else next.add(propertyId)
        return next
      })
    },
    [viewId, setViewHiddenPropertyIds],
  )

  const savedConditions = React.useMemo(
    () => flatConditions(viewSettings.filter),
    [viewSettings.filter],
  )
  const sortValue = React.useMemo(() => {
    const first = viewSettings.sorts[0]
    const key = first ? fieldKey(first.field) : null
    return first && key ? { key, direction: first.direction } : null
  }, [viewSettings.sorts])
  const setSortValue = React.useCallback<
    React.Dispatch<React.SetStateAction<{ key: string; direction: "asc" | "desc" } | null>>
  >(
    (next) => {
      const value = typeof next === "function" ? next(sortValue) : next
      updateViewSettings({
        sorts: value
          ? [{ field: fieldRefFromKey(value.key), direction: value.direction, nulls: "last" }]
          : [],
      })
    },
    [sortValue, updateViewSettings],
  )
  const tableSavedSettings = React.useMemo(
    () => ({
      widths: viewSettings.widths,
      wrapped: viewSettings.wrapped,
      frozenKey: viewSettings.frozenKey,
    }),
    [viewSettings.frozenKey, viewSettings.widths, viewSettings.wrapped],
  )
  const filterCount = savedConditions === null ? 1 : savedConditions.length
  const filteredFieldKeys = React.useMemo(
    () =>
      new Set(
        (savedConditions ?? [])
          .map((condition) => fieldKey(condition.field))
          .filter((key): key is string => key !== null),
      ),
    [savedConditions],
  )
  const queryFilter = React.useMemo(() => toQueryFilter(viewSettings.filter), [viewSettings.filter])
  const querySorts = React.useMemo(() => toQuerySorts(viewSettings.sorts), [viewSettings.sorts])
  // A sort overrides the hand-placed order; the list stays in the view for when it is removed.
  const queryManualOrder = React.useMemo(
    () =>
      viewSettings.sorts.length === 0 && viewSettings.manualOrder.length > 0
        ? viewSettings.manualOrder
        : undefined,
    [viewSettings.manualOrder, viewSettings.sorts.length],
  )
  return {
    viewSettings,
    updateViewSettings,
    activeHiddenPropertyIds,
    setViewHiddenPropertyIds,
    togglePropertyVisibility,
    savedConditions,
    filterCount,
    filteredFieldKeys,
    sortValue,
    setSortValue,
    tableSavedSettings,
    queryFilter,
    querySorts,
    queryManualOrder,
  }
}

/**
 * The saved settings of the active view and everything the workspace derives
 * from them: hidden fields, filter, sorts, the table layout and the query inputs.
 */
export function useViewQueryState({
  databaseId,
  vaultGeneration,
  activeView,
  isDatabaseLocked,
  onCatalogChanged,
}: {
  databaseId: string
  vaultGeneration: number | null
  activeView: DatabaseViewSummary | undefined
  isDatabaseLocked: boolean
  onCatalogChanged?: () => void | Promise<void>
}) {
  const savedView = useSavedView({
    databaseId,
    vaultGeneration,
    view: activeView ? { viewId: activeView.viewId, revision: activeView.revision } : null,
    persist: !isDatabaseLocked,
    onSaved: () => onCatalogChanged?.(),
  })
  const derived = useViewSettingsDerived({ savedView, viewId: activeView?.viewId ?? null })
  useLegacyHiddenPropertiesMigration({
    databaseId,
    viewId: activeView?.viewId ?? null,
    savedView,
    persisted: !isDatabaseLocked,
  })
  return { savedView, ...derived }
}
