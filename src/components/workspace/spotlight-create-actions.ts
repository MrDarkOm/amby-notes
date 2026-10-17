import type { TFunction } from "i18next"
import { Database, FolderPlus, LayoutGrid, PenLine } from "lucide-react"
import type { SpotlightCreateAction } from "./sidebar-search"

interface SpotlightCreateOptions {
  t: TFunction
  databasesEnabled: boolean
  canvasEnabled: boolean
  sketchEnabled: boolean
  onNewFolder: () => void
  onNewDatabase: () => void
  onNewCanvas: () => void
  onNewSketch: () => void
}

/**
 * What the Create button offers besides a note, as icons for the Spotlight window. What a
 * switched-off module would create is not offered at all.
 */
export function spotlightCreateActions({
  t,
  databasesEnabled,
  canvasEnabled,
  sketchEnabled,
  onNewFolder,
  onNewDatabase,
  onNewCanvas,
  onNewSketch,
}: SpotlightCreateOptions): SpotlightCreateAction[] {
  const actions: SpotlightCreateAction[] = [
    { id: "folder", label: t("newItem.folder"), icon: FolderPlus, run: onNewFolder },
  ]
  if (databasesEnabled) {
    actions.push({
      id: "database",
      label: t("newItem.database"),
      icon: Database,
      run: onNewDatabase,
    })
  }
  if (canvasEnabled) {
    actions.push({ id: "canvas", label: t("newItem.canvas"), icon: LayoutGrid, run: onNewCanvas })
  }
  if (sketchEnabled) {
    actions.push({ id: "sketch", label: t("newItem.sketch"), icon: PenLine, run: onNewSketch })
  }
  return actions
}
