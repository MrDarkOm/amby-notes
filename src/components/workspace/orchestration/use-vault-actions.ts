import * as React from "react"
import { openVault } from "@/lib/storage"
import { useVaultStore } from "../use-vault-store"

type VaultRecord = ReturnType<typeof useVaultStore.getState>["vaults"][number]

type UseVaultActionsParams = {
  loadVault: (path: string) => Promise<void>
  setVaults: (vaults: VaultRecord[]) => void
  vault: string | null
  vaults: VaultRecord[]
  onRequestProfileSelection?: (path: string) => void
}

/** Keeps workspace-picker mutations at the vault boundary. */
export function useVaultActions({
  loadVault,
  setVaults,
  vault,
  vaults,
  onRequestProfileSelection,
}: UseVaultActionsParams) {
  const handleRenameVault = React.useCallback(
    (id: string, name: string) => {
      setVaults(vaults.map((record) => (record.id === id ? { ...record, name } : record)))
    },
    [setVaults, vaults],
  )

  const handleDeleteVault = React.useCallback(
    (id: string) => {
      setVaults(vaults.filter((record) => record.id !== id))
    },
    [setVaults, vaults],
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
