import * as React from "react"
import { resolveSyncPort, type SyncPort, type VaultSyncStatus } from "@/lib/sync/sync-port"
import { useVaultStore } from "../use-vault-store"

export type RefreshSyncState = "checking" | "local" | "pending" | "running" | "synced" | "problem"

export function refreshSyncState(status: VaultSyncStatus | null): RefreshSyncState {
  if (!status) return "checking"
  if (
    status.errorCode ||
    status.stop ||
    status.needsUpdate ||
    status.outgoingPaused ||
    status.itemErrors > 0 ||
    status.conflicts.length > 0 ||
    status.unsynced.length > 0 ||
    status.phase === "waiting" ||
    status.phase === "stopped"
  )
    return "problem"
  if (!status.enabled) return "local"
  if (status.phase === "running") return "running"
  return status.lastSyncMs === null ? "pending" : "synced"
}

/** One refresh action for every dock: reload local files, then request a sync pass. */
export function useRefreshSync(reload: () => Promise<void>, port: SyncPort = resolveSyncPort()) {
  const generation = useVaultStore((s) => s.generation)
  const vault = useVaultStore((s) => s.vault)
  const [snapshot, setSnapshot] = React.useState<{
    generation: number
    status: VaultSyncStatus
  } | null>(null)
  const [failure, setFailure] = React.useState<{ generation: number; error: unknown } | null>(null)
  const [busy, setBusy] = React.useState(false)
  const working = React.useRef(false)

  React.useEffect(() => {
    let alive = true
    let received = false
    let unlisten: (() => void) | undefined
    setFailure(null)
    setSnapshot(null)
    if (!vault) return
    const take = (status: VaultSyncStatus) => {
      if (!alive) return
      received = true
      setSnapshot({ generation, status })
      setFailure(null)
    }
    void port
      .onVaultStatus(take)
      .then((off) => {
        if (alive) unlisten = off
        else off()
      })
      .catch((error: unknown) => {
        if (alive) setFailure({ generation, error })
      })
    void port
      .vaultStatus()
      .then((status) => {
        if (!received) take(status)
      })
      .catch((error: unknown) => {
        if (alive) setFailure({ generation, error })
      })
    return () => {
      alive = false
      unlisten?.()
    }
  }, [port, vault, generation])

  const refresh = async () => {
    if (working.current || !vault || useVaultStore.getState().switching) return
    working.current = true
    setBusy(true)
    setFailure(null)
    try {
      await reload()
      if (useVaultStore.getState().generation !== generation || useVaultStore.getState().switching)
        return
      const status = await port.vaultStatus()
      if (useVaultStore.getState().generation !== generation || useVaultStore.getState().switching)
        return
      setSnapshot({ generation, status })
      if (status.enabled && status.phase !== "running") await port.runNow()
    } catch (error) {
      if (useVaultStore.getState().generation === generation) setFailure({ generation, error })
    } finally {
      working.current = false
      setBusy(false)
    }
  }
  const error = failure?.generation === generation ? failure.error : null
  const state = error
    ? "problem"
    : refreshSyncState(snapshot?.generation === generation ? snapshot.status : null)
  return { refresh, state: vault ? state : ("local" as const), busy, error }
}
