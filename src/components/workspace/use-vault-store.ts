import { create } from "zustand"
import type { VaultRecord } from "./workspace-picker"

type Updater<T> = T | ((prev: T) => T)

function resolve<T>(updater: Updater<T>, prev: T): T {
  return typeof updater === "function" ? (updater as (p: T) => T)(prev) : updater
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
 * The store has no I/O: `vaults` is hydrated from the global `workspaces.json`
 * by the Workspace orchestrator, which also owns persistence (app-config.ts).
 */
export const useVaultStore = create<VaultStore>((set) => ({
  vault: null,
  vaults: [],
  setVault: (updater) => set((s) => ({ vault: resolve(updater, s.vault) })),
  setVaults: (updater) => set((s) => ({ vaults: resolve(updater, s.vaults) })),
}))
