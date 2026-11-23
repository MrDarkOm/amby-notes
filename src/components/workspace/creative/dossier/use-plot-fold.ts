import { useSyncExternalStore } from "react"
import { readWorkshopPrefs, writeWorkshopPrefs } from "../creative-scope-storage"

const subscribers = new Set<() => void>()

function subscribe(listener: () => void) {
  subscribers.add(listener)
  window.addEventListener("storage", listener)
  return () => {
    subscribers.delete(listener)
    window.removeEventListener("storage", listener)
  }
}

export function usePlotFold(vaultPath: string | undefined) {
  const folded = useSyncExternalStore(subscribe, () =>
    Boolean(vaultPath && readWorkshopPrefs(vaultPath).plotFolded === true),
  )
  const toggle = () => {
    if (!vaultPath) return
    writeWorkshopPrefs(vaultPath, { plotFolded: !folded })
    subscribers.forEach((listener) => listener())
  }
  return { folded, toggle }
}
