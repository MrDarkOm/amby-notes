import * as React from "react"
import { listen } from "@tauri-apps/api/event"
import type { CliOpenNote } from "@/lib/bindings"
import { isTauri, takeCliOpen } from "@/lib/storage"
import { errorType, logger } from "@/lib/logger"
import { useVaultStore } from "../use-vault-store"

export function useCliOpenRequests(
  windowLabel: string,
  startupResolved: boolean,
  loadVault: (path: string) => Promise<void>,
  openPath: (path: string) => void,
) {
  const [target, setTarget] = React.useState<CliOpenNote | null>(null)
  const switching = useVaultStore((state) => state.switching)
  const navigate = React.useEffectEvent(async (request: CliOpenNote) => {
    await loadVault(request.vault)
    if (useVaultStore.getState().vault === request.vault) setTarget(request)
  })
  const openTarget = React.useEffectEvent((request: CliOpenNote) => {
    if (useVaultStore.getState().vault === request.vault) openPath(request.path)
    setTarget(null)
  })

  React.useEffect(() => {
    if (target) openTarget(target)
  }, [target])

  React.useEffect(() => {
    if (!isTauri() || windowLabel !== "main" || !startupResolved || switching || target) return
    let disposed = false
    let busy = false
    let runAgain = false
    let stop: (() => void) | undefined
    const pull = async () => {
      if (disposed) return
      if (busy) {
        runAgain = true
        return
      }
      busy = true
      try {
        const request = await takeCliOpen()
        if (request) {
          await navigate(request)
          // After the target renders, the refreshed effect will drain the queue.
          if (useVaultStore.getState().vault === request.vault) return
          runAgain = true
        }
      } catch (error) {
        logger.warn("vault.cli_open_failed", { errorType: errorType(error) })
      } finally {
        busy = false
      }
      if (runAgain) {
        runAgain = false
        void pull()
      }
    }
    void listen("amby:cli-open", () => void pull())
      .then((unlisten) => {
        if (disposed) unlisten()
        else {
          stop = unlisten
          void pull()
        }
      })
      .catch((error: unknown) =>
        logger.warn("vault.cli_open_failed", { errorType: errorType(error) }),
      )
    return () => {
      disposed = true
      stop?.()
    }
  }, [startupResolved, switching, target, windowLabel])
}
