import * as React from "react"
import { errorType, logger } from "@/lib/logger"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { adoptAsyncDisposer } from "@/lib/async-disposable"
import { OPEN_RESTORED_VAULT_EVENT } from "../backup/backup-navigation"
import { isTauri, openVault } from "@/lib/storage"
import { useVaultStore } from "../use-vault-store"

type VaultRecord = ReturnType<typeof useVaultStore.getState>["vaults"][number]

type UseVaultActionsParams = {
  loadVault: (path: string | null) => Promise<void>
  setVaults: ReturnType<typeof useVaultStore.getState>["setVaults"]
  vault: string | null
  vaults: VaultRecord[]
  onRequestProfileSelection?: (path: string) => void
  onOpenRestored?: () => void
}

/** Keeps workspace-picker mutations at the vault boundary. */
export function useVaultActions({
  loadVault,
  setVaults,
  vault,
  vaults,
  onRequestProfileSelection,
  onOpenRestored,
}: UseVaultActionsParams) {
  const handleRenameVault = React.useCallback(
    (id: string, name: string) => {
      setVaults(vaults.map((record) => (record.id === id ? { ...record, name } : record)))
    },
    [setVaults, vaults],
  )

  const handleDeleteVault = React.useCallback(
    async (id: string) => {
      const record = useVaultStore.getState().vaults.find((record) => record.id === id)
      if (!record) return
      if (useVaultStore.getState().vault === record.path) {
        await loadVault(null)
        // A failed save or canceled close leaves the vault attached and open.
        if (useVaultStore.getState().vault !== null) return
      }
      setVaults((current) =>
        current.map((record) => (record.id === id ? { ...record, detached: true } : record)),
      )
    },
    [loadVault, setVaults],
  )

  const handleMoveVault = React.useCallback(
    async (id: string) => {
      const path = await openVault()
      if (!path) return
      setVaults(
        vaults.map((record) =>
          record.id === id
            ? { ...record, path, name: path.replace(/\\/g, "/").split("/").pop() ?? record.name }
            : record,
        ),
      )
      const target = vaults.find((record) => record.id === id)
      if (target && vault === target.path) await loadVault(path)
    },
    [loadVault, setVaults, vault, vaults],
  )

  const openRestoredVault = React.useCallback(
    async (path: string) => {
      if (!path) return
      onOpenRestored?.()
      if (isTauri()) {
        const window = getCurrentWindow()
        void window
          .show()
          .then(() => window.setFocus())
          .catch((error: unknown) =>
            logger.warn("backup.focus_failed", { errorType: errorType(error) }),
          )
      }
      const known = useVaultStore.getState().vaults.some((record) => record.path === path)
      if (!known && onRequestProfileSelection) onRequestProfileSelection(path)
      else await loadVault(path)
    },
    [loadVault, onRequestProfileSelection, onOpenRestored],
  )

  const openRestoredRef = React.useRef(openRestoredVault)
  openRestoredRef.current = openRestoredVault
  React.useEffect(() => {
    if (!isTauri() || getCurrentWindow().label !== "main") return
    return adoptAsyncDisposer(
      listen<{ path: string }>(OPEN_RESTORED_VAULT_EVENT, (event) => {
        if (typeof event.payload?.path === "string")
          void openRestoredRef
            .current(event.payload.path)
            .catch((error: unknown) =>
              logger.warn("backup.open_failed", { errorType: errorType(error) }),
            )
      }),
    )
  }, [])

  const handleOpenVault = React.useCallback(async () => {
    const path = await openVault()
    if (!path) return
    const isKnown = vaults.some((v) => v.path === path)
    if (!isKnown && onRequestProfileSelection) {
      onRequestProfileSelection(path)
    } else {
      await loadVault(path)
    }
  }, [loadVault, onRequestProfileSelection, vaults])

  return { handleDeleteVault, handleMoveVault, handleOpenVault, handleRenameVault }
}
