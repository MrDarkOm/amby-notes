import { create } from "zustand"
import type { VaultRecord } from "./workspace-picker"

type Updater<T> = T | ((prev: T) => T)

function resolve<T>(updater: Updater<T>, prev: T): T {
  return typeof updater === "function" ? (updater as (p: T) => T)(prev) : updater
}

function loadVaults(): VaultRecord[] {
  try {
    return JSON.parse(localStorage.getItem("amby:vaults") ?? "[]")
  } catch {
    return []
  }
}

interface VaultStore {
  /** Absolute path of the currently open vault, or null. */
  vault: string | null
  /** Known vaults (the workspace picker list). */
  vaults: VaultRecord[]
  setVault: (updater: Updater<string | null>) => void
  setVaults: (updater: Updater<VaultRecord[]>) => void
}

/**
 * Current vault + known-vaults list. Setters mirror setState (value or updater).
 * Persistence of the `vaults` list stays with the caller (saveVaults) so the
 * store has no I/O beyond seeding from localStorage.
 */
export const useVaultStore = create<VaultStore>((set) => ({
  vault: null,
  vaults: loadVaults(),
  setVault: (updater) => set((s) => ({ vault: resolve(updater, s.vault) })),
  setVaults: (updater) => set((s) => ({ vaults: resolve(updater, s.vaults) })),
}))
