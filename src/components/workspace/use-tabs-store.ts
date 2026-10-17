import { create } from "zustand"
import { newTabKey } from "./workspace-tree-utils"
import { logger } from "@/lib/logger"

export type TabKind =
  "document" | "folder" | "graph" | "canvas" | "database" | "sketch" | "creative"

/** The link graph is a page of its own: it has no file, so tabs and history name it by this id. */
export const GRAPH_TAB_FILE_ID = "__graph__"

export interface Tab {
  key: string
  kind: TabKind
  fileId: string
  title: string
  history: string[]
  historyIndex: number
}

export type TabTarget = Pick<Tab, "fileId" | "title"> & {
  kind: Exclude<TabKind, "creative">
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
  setActiveTabKey: (updater) =>
    set((s) => {
      const nextKey = resolve(updater, s.activeTabKey)
      if (nextKey !== s.activeTabKey) {
        const nextTab = s.tabs.find((t) => t.key === nextKey)
        logger.info("tab.switch", {
          from: s.activeTabKey || undefined,
          to: nextKey,
          title: nextTab?.title,
          fileId: nextTab?.fileId,
          kind: nextTab?.kind,
        })
      }
      return { activeTabKey: nextKey }
    }),
  setSecondaryTabKey: (updater) =>
    set((s) => ({ secondaryTabKey: resolve(updater, s.secondaryTabKey) })),
  openItem: (target, inNewTab = false) => {
    logger.info("tab.open_item", {
      kind: target.kind,
      fileId: target.fileId,
      title: target.title,
      inNewTab,
    })
    return set((state) => {
      const active = state.tabs.find((tab) => tab.key === state.activeTabKey)
      const matches = (tab: Tab) =>
        (tab.kind === target.kind && tab.fileId === target.fileId) ||
        (tab.fileId.replace(/^(database|canvas|sketch|creative):/u, "") ===
          target.fileId.replace(/^(database|canvas|sketch|creative):/u, "") &&
          tab.fileId.length > 0 &&
          target.fileId.length > 0 &&
          (tab.kind === target.kind ||
            ((tab.kind === "document" || tab.kind === "database") &&
              (target.kind === "document" || target.kind === "database"))))
      if (!inNewTab) {
        const existing = active && matches(active) ? active : state.tabs.find(matches)
        if (existing) {
          if (existing.key !== state.activeTabKey) {
            logger.info("tab.switch", {
              from: state.activeTabKey || undefined,
              to: existing.key,
              title: existing.title,
              fileId: existing.fileId,
              kind: target.kind,
            })
          }
          const needsUpdate = existing.kind !== target.kind || existing.title !== target.title
          return {
            ...(needsUpdate
              ? {
                  tabs: state.tabs.map((t) =>
                    t.key === existing.key ? { ...t, kind: target.kind, title: target.title } : t,
                  ),
                }
              : {}),
            activeTabKey: existing.key,
          }
        }
        if (active) {
          const history = active.history.length
            ? active.history.slice(0, active.historyIndex + 1)
            : active.kind === "database" ||
                active.kind === "canvas" ||
                active.kind === "sketch" ||
                active.kind === "creative"
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
    })
  },
  openOrActivateSingletonTab: (tab) => {
    logger.info("tab.open_singleton", {
      kind: tab.kind,
      fileId: tab.fileId,
      title: tab.title,
    })
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
