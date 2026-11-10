import * as React from "react"
import { logger, errorType } from "@/lib/logger"
import { resolveSyncPort, type DeletedOnServer } from "@/lib/sync/sync-port"

/** What the panel knows about the server: is sync on, and the list of deleted files (И9а, И13). */
export interface ArchiveServer {
  /** Sync of the vault is on (enabled and linked). The cloud button exists only then. */
  syncOn: boolean
  /** The list as the server part answered; `null` until it arrives. */
  list: DeletedOnServer | null
  /** Asks for the list again (after a restore). */
  reload: () => Promise<void>
}

/**
 * Follows sync of the vault and asks for the server list once when it is on: the cloud marks of the
 * local entries (И11а) need it even while the trash shows. The status is followed, so the panel can
 * return to the trash when sync goes off (И9а).
 */
export function useArchiveServer(onList?: (list: DeletedOnServer) => void): ArchiveServer {
  const port = React.useMemo(() => resolveSyncPort(), [])
  const [syncOn, setSyncOn] = React.useState(false)
  const [list, setList] = React.useState<DeletedOnServer | null>(null)
  const mounted = React.useRef(true)
  const request = React.useRef(0)

  const reload = React.useCallback(async () => {
    const sequence = ++request.current
    let next: DeletedOnServer
    try {
      next = await port.deletedFiles()
    } catch (cause) {
      // Not an error for the person (И13): the same calm line as without a connection.
      logger.warn("archive.server_list_failed", { errorType: errorType(cause) })
      next = {
        available: false,
        reason: "offline",
        files: [],
        truncated: false,
        trashOnServer: [],
      }
    }
    if (mounted.current && sequence === request.current) {
      setList(next)
      onList?.(next)
    }
  }, [port, onList])

  React.useEffect(() => {
    mounted.current = true
    let cancelled = false
    let unlisten: (() => void) | null = null
    const requests = request
    port
      .vaultStatus()
      .then((status) => {
        if (!cancelled) setSyncOn(status.enabled && status.linked)
      })
      .catch(() => {
        if (!cancelled) setSyncOn(false)
      })
    port
      .onVaultStatus((status) => {
        if (!cancelled) setSyncOn(status.enabled && status.linked)
      })
      .then((stop) => {
        if (cancelled) stop()
        else unlisten = stop
      })
      .catch(() => {})
    return () => {
      cancelled = true
      mounted.current = false
      requests.current++
      unlisten?.()
    }
  }, [port])

  React.useEffect(() => {
    if (syncOn) void reload()
    else setList(null)
  }, [syncOn, reload])

  return { syncOn, list, reload }
}
