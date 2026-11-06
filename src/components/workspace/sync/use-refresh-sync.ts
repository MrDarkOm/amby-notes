import * as React from "react"
import {
  resolveSyncPort,
  SyncPortError,
  unavailableSyncPort,
  type SyncPort,
  type VaultSyncStatus,
} from "@/lib/sync/sync-port"
import { useVaultStore } from "../use-vault-store"
import { syncInactiveReason, type SyncAccountProbe, type SyncFixAction } from "./sync-inactive"

const codeOf = (error: unknown): string => (error instanceof SyncPortError ? error.code : "unknown")

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
  // The account, read (without a dialog of the key store) while the vault does not sync: it tells
  // "not signed in" from "not set up here".
  const [account, setAccount] = React.useState<SyncAccountProbe>({ status: null, errorCode: null })
  const [fixBusy, setFixBusy] = React.useState(false)
  const [fixError, setFixError] = React.useState<unknown>(null)

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
      setFixError(null)
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

  const current = snapshot?.generation === generation ? snapshot.status : null
  const resting = current !== null && !current.enabled
  // Every status received while the vault rests reads the account again: signing in or out
  // elsewhere is announced as a new status of the vault (commands/sync.rs `resume_open_vault`).
  React.useEffect(() => {
    if (!resting) return
    let alive = true
    port
      .status()
      .then((status) => alive && setAccount({ status, errorCode: null }))
      .catch((error: unknown) => alive && setAccount({ status: null, errorCode: codeOf(error) }))
    return () => {
      alive = false
    }
  }, [port, resting, snapshot])

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
  const state = error ? "problem" : refreshSyncState(current)
  const inactive = vault
    ? syncInactiveReason({
        status: current,
        account,
        failureCode: error ? codeOf(error) : null,
        available: port !== unavailableSyncPort,
      })
    : null

  /** The action of the menu of an inactive button (`settings` is opened by the dock itself). */
  const fix = async (action: Exclude<SyncFixAction, "settings">): Promise<void> => {
    if (action === "refresh") return refresh()
    if (working.current || !vault || useVaultStore.getState().switching) return
    working.current = true
    setFixBusy(true)
    setFixError(null)
    try {
      if (action === "resume") {
        // The link belongs to this connection: the application resumes its own space and ignores
        // the target (the same call as "Switch on again" of the settings).
        const status = await port.enableVault({ kind: "new", name: "" }, false)
        if (useVaultStore.getState().generation === generation) setSnapshot({ generation, status })
      } else if (action === "reconnect") {
        // An explicit action: the key store may ask the person. When the device is signed in the
        // application starts the sync of the open vault again and announces the new status.
        const status = await port.status(true)
        setAccount({ status, errorCode: null })
      } else {
        await port.runNow()
      }
    } catch (caught) {
      if (action === "reconnect") setAccount({ status: null, errorCode: codeOf(caught) })
      setFixError(caught)
    } finally {
      working.current = false
      setFixBusy(false)
    }
  }

  return {
    refresh,
    state: vault ? state : ("local" as const),
    busy,
    error,
    inactive,
    fix,
    fixBusy,
    fixError,
  }
}

/** What the dock gets from [`useRefreshSync`]. */
export type RefreshSync = ReturnType<typeof useRefreshSync>
