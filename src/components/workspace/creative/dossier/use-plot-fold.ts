import { useSyncExternalStore } from "react"
import {
  readWorkshopPrefs,
  subscribeWorkshopPrefs,
  writeWorkshopPrefs,
} from "../creative-scope-storage"

export function usePlotFold(vaultPath: string | undefined) {
  const folded = useSyncExternalStore(subscribeWorkshopPrefs, () =>
    Boolean(vaultPath && readWorkshopPrefs(vaultPath).plotFolded === true),
  )
  const toggle = () => {
    if (!vaultPath) return
    writeWorkshopPrefs(vaultPath, { plotFolded: !folded })
  }
  return { folded, toggle }
}
