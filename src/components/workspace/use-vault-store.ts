import { create } from "zustand"
import type { VaultRecord } from "./workspace-picker"

type Updater<T> = T | ((prev: T) => T)

function resolve<T>(updater: Updater<T>, prev: T): T {
  return typeof updater === "function" ? (updater as (p: T) => T)(prev) : updater
}

interface VaultStore {
  /** Absolute path of the currently open vault, or null. */
  vault: string | null
  /** Blocks new property intents while the active backend context is changing. */
  switching: boolean
  /** Increments only after a vault activation has succeeded. */
  generation: number
  /** Backend generation that binds IPC writes to the active vault context. */
  backendGeneration: number | null
  /** Known vaults, including detached entries kept in recent history. */
  vaults: VaultRecord[]
  setVault: (updater: Updater<string | null>) => void
  setBackendGeneration: (generation: number | null) => void
  setVaults: (updater: Updater<VaultRecord[]>) => void
}

/**
 * Current vault + known-vaults list. Setters mirror setState (value or updater).
 * The store has no I/O: `vaults` is hydrated from the global `workspaces.json`
 * by the Workspace orchestrator, which also owns persistence (app-config.ts).
 */
export const useVaultStore = create<VaultStore>((set) => ({
  vault: null,
  switching: false,
  generation: 1,
  backendGeneration: null,
  vaults: [],
  setVault: (updater) =>
    set((s) => {
      const vault = resolve(updater, s.vault)
      return vault === s.vault ? {} : { vault, generation: s.generation + 1 }
    }),
  setBackendGeneration: (backendGeneration) => set({ backendGeneration }),
  setVaults: (updater) => set((s) => ({ vaults: resolve(updater, s.vaults) })),
}))
