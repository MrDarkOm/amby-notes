import { create } from "zustand"

export type TabKind = "document" | "graph" | "canvas"

export interface Tab {
  key: string
  kind: TabKind
  fileId: string
  title: string
  history: string[]
  historyIndex: number
}

type Updater<T> = T | ((prev: T) => T)

function resolve<T>(updater: Updater<T>, prev: T): T {
  return typeof updater === "function" ? (updater as (p: T) => T)(prev) : updater
}

interface TabsStore {
  tabs: Tab[]
  activeTabKey: string
  /** When set, the editor splits and this document tab renders in a second pane. */
  secondaryTabKey: string | null
  setTabs: (updater: Updater<Tab[]>) => void
  setActiveTabKey: (updater: Updater<string>) => void
  setSecondaryTabKey: (updater: Updater<string | null>) => void
}

/**
 * Holds the open tabs, the active tab, and the split (secondary) tab. Setters
 * accept a value or an updater fn, mirroring React's setState so existing call
 * sites work unchanged while the state lives outside the Workspace component.
 */
export const useTabsStore = create<TabsStore>((set) => ({
  tabs: [],
  activeTabKey: "",
  secondaryTabKey: null,
  setTabs: (updater) => set((s) => ({ tabs: resolve(updater, s.tabs) })),
  setActiveTabKey: (updater) => set((s) => ({ activeTabKey: resolve(updater, s.activeTabKey) })),
  setSecondaryTabKey: (updater) =>
    set((s) => ({ secondaryTabKey: resolve(updater, s.secondaryTabKey) })),
}))
