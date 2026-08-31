import { create } from "zustand"
import { newTabKey } from "./workspace-tree-utils"

export type TabKind = "document" | "folder" | "graph" | "canvas"

export interface Tab {
  key: string
  kind: TabKind
  fileId: string
  title: string
  history: string[]
  historyIndex: number
}

export type TabTarget = Pick<Tab, "fileId" | "title"> & {
  kind: Exclude<TabKind, "graph">
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
  openOrActivateSingletonTab: (tab: Tab) => string
  /** Ordinary navigation reuses an open tab or replaces the active one. */
  openItem: (target: TabTarget, inNewTab?: boolean) => void
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
  openItem: (target, inNewTab = false) =>
    set((state) => {
      const active = state.tabs.find((tab) => tab.key === state.activeTabKey)
      const matches = (tab: Tab) => tab.kind === target.kind && tab.fileId === target.fileId
      if (!inNewTab) {
        const existing = active && matches(active) ? active : state.tabs.find(matches)
        if (existing) return { activeTabKey: existing.key }
        if (active) {
          const history = active.history.length
            ? active.history.slice(0, active.historyIndex + 1)
            : active.kind === "graph"
              ? []
              : [active.fileId]
          history.push(target.fileId)
          return {
            tabs: state.tabs.map((tab) =>
              tab.key === active.key
                ? { ...tab, ...target, history, historyIndex: history.length - 1 }
                : tab,
            ),
            secondaryTabKey:
              state.secondaryTabKey === active.key && target.kind !== "document"
                ? null
                : state.secondaryTabKey,
          }
        }
      }
      const tab: Tab = {
        ...target,
        key: newTabKey(),
        history: [target.fileId],
        historyIndex: 0,
      }
      return { tabs: [...state.tabs, tab], activeTabKey: tab.key }
    }),
  openOrActivateSingletonTab: (tab) => {
    let activeKey = tab.key
    set((state) => {
      const existing = state.tabs.find(
        (candidate) => candidate.kind === tab.kind && candidate.fileId === tab.fileId,
      )
      if (existing) {
        activeKey = existing.key
        return { activeTabKey: existing.key }
      }
      return { tabs: [...state.tabs, tab], activeTabKey: tab.key }
    })
    return activeKey
  },
}))
