import * as React from "react"
import {
  readWorkshopPrefs,
  subscribeWorkshopPrefs,
  workshopPrefsSnapshot,
  writeWorkshopPrefs,
} from "../creative-scope-storage"
import type { DeskItem } from "./desk-layout-model"

export function useDeskLayout(vaultPath: string | null, storyId: string | null) {
  const snapshot = React.useSyncExternalStore(subscribeWorkshopPrefs, workshopPrefsSnapshot)
  const [local, setLocal] = React.useState<DeskItem[]>()
  const prefs = React.useMemo(
    () => (vaultPath ? readWorkshopPrefs(vaultPath, snapshot) : {}),
    [vaultPath, snapshot],
  )
  const layout = storyId
    ? (prefs.deskLayoutsByStory?.[storyId] ?? prefs.deskLayout ?? local)
    : undefined

  const change = (next: DeskItem[]) => {
    if (!vaultPath || !storyId) {
      setLocal(next)
      return
    }
    const current = readWorkshopPrefs(vaultPath).deskLayoutsByStory
    writeWorkshopPrefs(vaultPath, { deskLayoutsByStory: { ...current, [storyId]: next } })
  }

  const applyToAll = (next: DeskItem[]) => {
    if (vaultPath) writeWorkshopPrefs(vaultPath, { deskLayout: next, deskLayoutsByStory: {} })
  }
  return { layout, change, applyToAll: vaultPath ? applyToAll : undefined }
}
