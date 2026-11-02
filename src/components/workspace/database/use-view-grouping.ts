import type { ViewSettings } from "./view-config"
import type { SavedView } from "./use-saved-view"
import type { DatabaseSummary } from "@/lib/storage"
import type { DatabaseViewSummary } from "@/lib/storage"
import * as React from "react"

import { type DatabaseFieldRef } from "@/lib/storage"

interface UseViewGroupingParams {
  database: DatabaseSummary | undefined
  activeHiddenPropertyIds: Set<string>
  savedView: SavedView
  viewSettings: ViewSettings
  selectedView: DatabaseViewSummary | undefined
}

export function useViewGrouping({
  database,
  activeHiddenPropertyIds,
  savedView,
  viewSettings,
  selectedView,
}: UseViewGroupingParams) {
  // Cards (board, list, gallery) show the properties the view shows; every view has its own list.
  const cardFieldIds = React.useMemo(
    () =>
      database
        ? database.properties
            .filter((property) => !activeHiddenPropertyIds.has(property.propertyId))
            .map((property) => property.propertyId)
        : null,
    [activeHiddenPropertyIds, database],
  )

  // The saved setting is the newest word on grouping; the catalog summary catches up after a save.
  const groupField = React.useMemo<DatabaseFieldRef | null>(() => {
    if (savedView.ready) {
      return viewSettings.groupBy ? { kind: "property", propertyId: viewSettings.groupBy } : null
    }
    return selectedView?.groupField ?? null
  }, [savedView.ready, selectedView?.groupField, viewSettings.groupBy])
  const groupDisplay = React.useMemo(
    () => ({
      sort: viewSettings.groupSort,
      order: viewSettings.groupOrder,
      hidden: viewSettings.hiddenGroups,
      hideEmpty: viewSettings.hideEmptyGroups,
    }),
    [
      viewSettings.groupSort,
      viewSettings.groupOrder,
      viewSettings.hiddenGroups,
      viewSettings.hideEmptyGroups,
    ],
  )
  // Board columns and gallery groups both need a Select or Status property to group by.
  const groupingLayout = selectedView?.layout === "board" || selectedView?.layout === "gallery"
  const boardGroupProperty = React.useMemo(() => {
    const group = groupField
    if (!groupingLayout || !group || group.kind !== "property") return null
    const property = database?.properties.find(
      (candidate) => candidate.propertyId === group.propertyId,
    )
    return property && (property.propertyType === "select" || property.propertyType === "status")
      ? property
      : null
  }, [database?.properties, groupField, groupingLayout])

  const chartCategory = React.useMemo(() => {
    const property = database?.properties.find(
      (candidate) => candidate.propertyType === "select" || candidate.propertyType === "status",
    )
    return property ? { kind: "property" as const, propertyId: property.propertyId } : undefined
  }, [database?.properties])

  return { cardFieldIds, groupField, groupDisplay, boardGroupProperty, chartCategory }
}
