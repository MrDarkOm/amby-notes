import { create } from "zustand"
import { newTabKey } from "./workspace-tree-utils"
import { logger } from "@/lib/logger"
import {
  createInitialPaneLeaf,
  DEFAULT_PANE_ID,
  findPaneLeaf,
  findPaneLeafByTabKey,
  listPaneLeaves,
  newPaneId,
  reconcilePaneTree,
  removePaneLeaf,
  splitPaneLeaf,
  updatePaneLeaf,
  updateSplitRatio,
  type PaneNode,
  type SplitDirection,
} from "./split-tree"

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
  kind: TabKind
}

/** How `openItem` treats the tabs that are already open. */
export interface OpenItemOptions {
  /**
   * Steps the active tab to the target even where another tab of the pane shows it already: a
   * step within a page (a workshop section) must not jump to a different tab.
   */
  inPlace?: boolean
}

type Updater<T> = T | ((prev: T) => T)

function resolve<T>(updater: Updater<T>, prev: T): T {
  return typeof updater === "function" ? (updater as (p: T) => T)(prev) : updater
}

export interface SplitPaneOptions {
  paneId?: string
  tabKey?: string
  target?: TabTarget
  placement?: "before" | "after"
  /** When true, moves `tabKey` out of its origin pane if that pane has multiple tabs. */
  moveTab?: boolean
}

interface TabsStore {
  tabs: Tab[]
  activeTabKey: string
  /** Legacy 2-pane key preserved for compatibility; multi-pane splits live in `rootPane`. */
  secondaryTabKey: string | null
  rootPane: PaneNode
  activePaneId: string
  setTabs: (updater: Updater<Tab[]>) => void
  setActiveTabKey: (updater: Updater<string>) => void
  setSecondaryTabKey: (updater: Updater<string | null>) => void
  openOrActivateSingletonTab: (tab: Tab) => string
  /** Ordinary navigation reuses an open tab in the active pane or replaces the active one. */
  openItem: (target: TabTarget, inNewTab?: boolean, options?: OpenItemOptions) => void
  focusPane: (paneId: string) => void
  selectTabInPane: (paneId: string, tabKey: string) => void
  splitPane: (direction: SplitDirection, options?: SplitPaneOptions) => string | null
  moveTabToPane: (tabKey: string, targetPaneId: string, targetIndex?: number) => void
  closeOtherTabsInPane: (paneId: string, keepTabKey: string) => void
  closePane: (paneId: string) => void
  setSplitRatio: (splitId: string, ratio: number) => void
  unsplitAll: () => void
}

/**
 * Moves `tabKey` inside the flat tab list so it sits where it does in `paneKeys`: just before
 * the pane tab that follows it, or just after the one that precedes it. The header lists tabs
 * in this flat order (a pane shows the subset it holds), so a reorder inside a pane has to
 * reach it too, not only the pane's own key list.
 */
function placeTabLike(tabs: Tab[], tabKey: string, paneKeys: readonly string[]): Tab[] {
  const moving = tabs.find((tab) => tab.key === tabKey)
  const at = paneKeys.indexOf(tabKey)
  if (!moving || at === -1) return tabs
  const rest = tabs.filter((tab) => tab.key !== tabKey)
  const nextKey = paneKeys[at + 1]
  const prevKey = paneKeys[at - 1]
  let index: number
  if (nextKey !== undefined) index = rest.findIndex((tab) => tab.key === nextKey)
  else if (prevKey !== undefined) index = rest.findIndex((tab) => tab.key === prevKey) + 1
  else return tabs
  if (index < 0) return tabs
  const next = [...rest.slice(0, index), moving, ...rest.slice(index)]
  return next.every((tab, i) => tab === tabs[i]) ? tabs : next
}

function matchesTarget(tab: Tab, target: TabTarget): boolean {
  return (
    (tab.kind === target.kind && tab.fileId === target.fileId) ||
    (tab.fileId.replace(/^(database|canvas|sketch|creative):/u, "") ===
      target.fileId.replace(/^(database|canvas|sketch|creative):/u, "") &&
      tab.fileId.length > 0 &&
      target.fileId.length > 0 &&
      (tab.kind === target.kind ||
        ((tab.kind === "document" || tab.kind === "database") &&
          (target.kind === "document" || target.kind === "database"))))
  )
}

/**
 * Holds the open tabs, the active tab, and the recursive split-pane layout tree.
 * Setters accept a value or an updater fn, mirroring React's setState so existing
 * call sites work unchanged while the state lives outside the Workspace component.
 */
export const useTabsStore = create<TabsStore>((set) => ({
  tabs: [],
  activeTabKey: "",
  secondaryTabKey: null,
  rootPane: createInitialPaneLeaf([], "", DEFAULT_PANE_ID),
  activePaneId: DEFAULT_PANE_ID,

  setTabs: (updater) =>
    set((s) => {
      const tabs = resolve(updater, s.tabs)
      const reconciled = reconcilePaneTree(
        s.rootPane,
        tabs.map((t) => t.key),
        s.activePaneId,
        s.activeTabKey,
      )
      return {
        tabs,
        ...reconciled,
      }
    }),

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
      if (!nextKey) {
        return { activeTabKey: "" }
      }
      const currentLeaf = findPaneLeaf(s.rootPane, s.activePaneId)
      const targetLeaf =
        currentLeaf && currentLeaf.tabKeys.includes(nextKey)
          ? currentLeaf
          : findPaneLeafByTabKey(s.rootPane, nextKey)
      if (!targetLeaf) {
        return { activeTabKey: nextKey }
      }
      const rootPane = updatePaneLeaf(s.rootPane, targetLeaf.id, (leaf) => ({
        ...leaf,
        activeTabKey: nextKey,
      }))
      return {
        activeTabKey: nextKey,
        activePaneId: targetLeaf.id,
        rootPane,
      }
    }),

  setSecondaryTabKey: (updater) =>
    set((s) => ({ secondaryTabKey: resolve(updater, s.secondaryTabKey) })),

  focusPane: (paneId) =>
    set((s) => {
      const leaf = findPaneLeaf(s.rootPane, paneId)
      if (!leaf) return {}
      const nextActiveKey = leaf.activeTabKey || leaf.tabKeys[leaf.tabKeys.length - 1] || ""
      if (s.activePaneId === paneId && s.activeTabKey === nextActiveKey) return {}
      return {
        activePaneId: paneId,
        activeTabKey: nextActiveKey,
      }
    }),

  selectTabInPane: (paneId, tabKey) =>
    set((s) => {
      const leaf = findPaneLeaf(s.rootPane, paneId)
      if (!leaf || !leaf.tabKeys.includes(tabKey)) return {}
      if (tabKey !== s.activeTabKey) {
        const nextTab = s.tabs.find((t) => t.key === tabKey)
        logger.info("tab.switch", {
          from: s.activeTabKey || undefined,
          to: tabKey,
          title: nextTab?.title,
          fileId: nextTab?.fileId,
          kind: nextTab?.kind,
        })
      }
      const rootPane = updatePaneLeaf(s.rootPane, paneId, (l) => ({
        ...l,
        activeTabKey: tabKey,
      }))
      return {
        rootPane,
        activePaneId: paneId,
        activeTabKey: tabKey,
      }
    }),

  openItem: (target, inNewTab = false, options) => {
    logger.info("tab.open_item", {
      kind: target.kind,
      fileId: target.fileId,
      title: target.title,
      inNewTab,
    })
    return set((state) => {
      const leaves = listPaneLeaves(state.rootPane)
      const activeLeaf =
        findPaneLeaf(state.rootPane, state.activePaneId) ??
        findPaneLeafByTabKey(state.rootPane, state.activeTabKey) ??
        leaves[0]
      const activePaneTabKeySet = new Set(activeLeaf?.tabKeys ?? [])
      const activePaneTabs =
        leaves.length > 1
          ? state.tabs.filter((tab) => activePaneTabKeySet.has(tab.key))
          : state.tabs
      const effectiveActiveKey = activeLeaf?.activeTabKey || state.activeTabKey
      const active =
        activePaneTabs.find((tab) => tab.key === effectiveActiveKey) ??
        state.tabs.find((tab) => tab.key === state.activeTabKey)

      if (!inNewTab) {
        const existing =
          active && matchesTarget(active, target)
            ? active
            : options?.inPlace
              ? undefined
              : activePaneTabs.find((t) => matchesTarget(t, target))
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
          const nextTabs = needsUpdate
            ? state.tabs.map((t) =>
                t.key === existing.key ? { ...t, kind: target.kind, title: target.title } : t,
              )
            : state.tabs
          const containingLeaf =
            activeLeaf && activeLeaf.tabKeys.includes(existing.key)
              ? activeLeaf
              : findPaneLeafByTabKey(state.rootPane, existing.key)
          const rootPane = containingLeaf
            ? updatePaneLeaf(state.rootPane, containingLeaf.id, (l) => ({
                ...l,
                activeTabKey: existing.key,
              }))
            : state.rootPane
          return {
            ...(needsUpdate ? { tabs: nextTabs } : {}),
            activeTabKey: existing.key,
            activePaneId: containingLeaf?.id ?? state.activePaneId,
            rootPane,
          }
        }
        if (active) {
          const history = active.history.length
            ? active.history.slice(0, active.historyIndex + 1)
            : active.kind === "database" || active.kind === "canvas" || active.kind === "sketch"
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
      const nextTabs = [...state.tabs, tab]
      const targetLeafId = activeLeaf?.id ?? DEFAULT_PANE_ID
      const rootPane = findPaneLeaf(state.rootPane, targetLeafId)
        ? updatePaneLeaf(state.rootPane, targetLeafId, (l) => ({
            ...l,
            tabKeys: [...l.tabKeys, tab.key],
            activeTabKey: tab.key,
          }))
        : createInitialPaneLeaf([tab.key], tab.key, targetLeafId)
      return {
        tabs: nextTabs,
        activeTabKey: tab.key,
        activePaneId: targetLeafId,
        rootPane,
      }
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
        const leaf = findPaneLeafByTabKey(state.rootPane, existing.key)
        const rootPane = leaf
          ? updatePaneLeaf(state.rootPane, leaf.id, (l) => ({
              ...l,
              activeTabKey: existing.key,
            }))
          : state.rootPane
        return {
          activeTabKey: existing.key,
          activePaneId: leaf?.id ?? state.activePaneId,
          rootPane,
        }
      }
      const nextTabs = [...state.tabs, tab]
      const targetLeaf =
        findPaneLeaf(state.rootPane, state.activePaneId) ?? listPaneLeaves(state.rootPane)[0]
      const targetLeafId = targetLeaf?.id ?? DEFAULT_PANE_ID
      const rootPane = targetLeaf
        ? updatePaneLeaf(state.rootPane, targetLeafId, (l) => ({
            ...l,
            tabKeys: [...l.tabKeys, tab.key],
            activeTabKey: tab.key,
          }))
        : createInitialPaneLeaf([tab.key], tab.key, targetLeafId)
      return {
        tabs: nextTabs,
        activeTabKey: tab.key,
        activePaneId: targetLeafId,
        rootPane,
      }
    })
    return activeKey
  },

  splitPane: (direction, options) => {
    let createdPaneId: string | null = null
    set((state) => {
      const leaves = listPaneLeaves(state.rootPane)
      const targetLeaf =
        (options?.paneId ? findPaneLeaf(state.rootPane, options.paneId) : null) ??
        findPaneLeaf(state.rootPane, state.activePaneId) ??
        leaves[0]
      if (!targetLeaf) return {}
      const placement = options?.placement ?? "after"

      // Case 1: Opening a specific TabTarget into a new split pane
      if (options?.target) {
        const newTab: Tab = {
          ...options.target,
          key: newTabKey(),
          history: [options.target.fileId],
          historyIndex: 0,
        }
        // If the entire workspace had no open tabs yet, open inside the existing pane.
        if (state.tabs.length === 0) {
          createdPaneId = targetLeaf.id
          return {
            tabs: [newTab],
            activeTabKey: newTab.key,
            activePaneId: targetLeaf.id,
            rootPane: createInitialPaneLeaf([newTab.key], newTab.key, targetLeaf.id),
          }
        }
        const newLeafId = newPaneId("pane")
        createdPaneId = newLeafId
        const newLeaf = createInitialPaneLeaf([newTab.key], newTab.key, newLeafId)
        const rootPane = splitPaneLeaf(state.rootPane, targetLeaf.id, direction, placement, newLeaf)
        return {
          tabs: [...state.tabs, newTab],
          activeTabKey: newTab.key,
          activePaneId: newLeafId,
          rootPane,
        }
      }

      const sourceTabKey =
        options?.tabKey || targetLeaf.activeTabKey || state.activeTabKey || state.tabs[0]?.key
      const sourceTab = state.tabs.find((t) => t.key === sourceTabKey)
      if (!sourceTab) return {}

      const originLeaf = findPaneLeafByTabKey(state.rootPane, sourceTab.key) ?? targetLeaf
      const canMoveExistingTab =
        Boolean(options?.moveTab) &&
        (originLeaf.tabKeys.length > 1 || (originLeaf.id !== targetLeaf.id && leaves.length > 1))

      if (canMoveExistingTab) {
        const newLeafId = newPaneId("pane")
        createdPaneId = newLeafId
        const newLeaf = createInitialPaneLeaf([sourceTab.key], sourceTab.key, newLeafId)

        let treeWithoutMovedTab: PaneNode = state.rootPane
        if (originLeaf.tabKeys.length > 1) {
          const remainingKeys = originLeaf.tabKeys.filter((k) => k !== sourceTab.key)
          const nextOriginActive =
            originLeaf.activeTabKey === sourceTab.key
              ? (remainingKeys[remainingKeys.length - 1] ?? "")
              : originLeaf.activeTabKey
          treeWithoutMovedTab = updatePaneLeaf(state.rootPane, originLeaf.id, (l) => ({
            ...l,
            tabKeys: remainingKeys,
            activeTabKey: nextOriginActive,
          }))
        } else if (originLeaf.id !== targetLeaf.id) {
          treeWithoutMovedTab = removePaneLeaf(state.rootPane, originLeaf.id)
        }

        const rootPane = splitPaneLeaf(
          treeWithoutMovedTab,
          targetLeaf.id,
          direction,
          placement,
          newLeaf,
        )
        return {
          rootPane,
          activePaneId: newLeafId,
          activeTabKey: sourceTab.key,
        }
      }

      // Default: clone the tab into the new split pane so both panes remain populated
      const clonedTab: Tab = {
        ...sourceTab,
        key: newTabKey(),
        history: [...sourceTab.history],
      }
      const newLeafId = newPaneId("pane")
      createdPaneId = newLeafId
      const newLeaf = createInitialPaneLeaf([clonedTab.key], clonedTab.key, newLeafId)
      const rootPane = splitPaneLeaf(state.rootPane, targetLeaf.id, direction, placement, newLeaf)
      return {
        tabs: [...state.tabs, clonedTab],
        activeTabKey: clonedTab.key,
        activePaneId: newLeafId,
        rootPane,
      }
    })
    return createdPaneId
  },

  moveTabToPane: (tabKey, targetPaneId, targetIndex) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.key === tabKey)
      const targetLeaf = findPaneLeaf(state.rootPane, targetPaneId)
      const originLeaf = findPaneLeafByTabKey(state.rootPane, tabKey)
      if (!tab || !targetLeaf || !originLeaf) return {}

      if (originLeaf.id === targetLeaf.id) {
        if (targetIndex === undefined) {
          return {
            activePaneId: targetPaneId,
            activeTabKey: tabKey,
            rootPane: updatePaneLeaf(state.rootPane, targetPaneId, (l) => ({
              ...l,
              activeTabKey: tabKey,
            })),
          }
        }
        // `targetIndex` is a slot among the tabs as they are now, the moved one included; once it
        // is lifted out, every slot after its old place is one lower.
        const filtered = originLeaf.tabKeys.filter((k) => k !== tabKey)
        const from = originLeaf.tabKeys.indexOf(tabKey)
        const slot = from !== -1 && from < targetIndex ? targetIndex - 1 : targetIndex
        const clampedIdx = Math.max(0, Math.min(filtered.length, slot))
        filtered.splice(clampedIdx, 0, tabKey)
        return {
          activePaneId: targetPaneId,
          activeTabKey: tabKey,
          tabs: placeTabLike(state.tabs, tabKey, filtered),
          rootPane: updatePaneLeaf(state.rootPane, targetPaneId, (l) => ({
            ...l,
            tabKeys: filtered,
            activeTabKey: tabKey,
          })),
        }
      }

      let nextRoot: PaneNode
      if (originLeaf.tabKeys.length <= 1) {
        nextRoot = removePaneLeaf(state.rootPane, originLeaf.id)
      } else {
        const remaining = originLeaf.tabKeys.filter((k) => k !== tabKey)
        const nextOriginActive =
          originLeaf.activeTabKey === tabKey
            ? (remaining[remaining.length - 1] ?? "")
            : originLeaf.activeTabKey
        nextRoot = updatePaneLeaf(state.rootPane, originLeaf.id, (l) => ({
          ...l,
          tabKeys: remaining,
          activeTabKey: nextOriginActive,
        }))
      }

      let targetKeys: string[] = []
      nextRoot = updatePaneLeaf(nextRoot, targetPaneId, (l) => {
        const without = l.tabKeys.filter((k) => k !== tabKey)
        if (targetIndex !== undefined) {
          const idx = Math.max(0, Math.min(without.length, targetIndex))
          without.splice(idx, 0, tabKey)
        } else {
          without.push(tabKey)
        }
        targetKeys = without
        return {
          ...l,
          tabKeys: without,
          activeTabKey: tabKey,
        }
      })

      return {
        tabs: placeTabLike(state.tabs, tabKey, targetKeys),
        rootPane: nextRoot,
        activePaneId: targetPaneId,
        activeTabKey: tabKey,
      }
    }),

  closeOtherTabsInPane: (paneId, keepTabKey) =>
    set((state) => {
      const leaf = findPaneLeaf(state.rootPane, paneId)
      if (!leaf || !leaf.tabKeys.includes(keepTabKey)) return {}
      const toRemove = new Set(leaf.tabKeys.filter((k) => k !== keepTabKey))
      if (toRemove.size === 0) return {}
      const tabs = state.tabs.filter((t) => !toRemove.has(t.key))
      const rootPane = updatePaneLeaf(state.rootPane, paneId, (l) => ({
        ...l,
        tabKeys: [keepTabKey],
        activeTabKey: keepTabKey,
      }))
      return {
        tabs,
        rootPane,
        activePaneId: paneId,
        activeTabKey: keepTabKey,
      }
    }),

  closePane: (paneId) =>
    set((state) => {
      const leaves = listPaneLeaves(state.rootPane)
      const leaf = findPaneLeaf(state.rootPane, paneId)
      if (!leaf) return {}
      if (leaves.length <= 1) {
        return {
          tabs: [],
          activeTabKey: "",
          secondaryTabKey: null,
          rootPane: createInitialPaneLeaf([], "", DEFAULT_PANE_ID),
          activePaneId: DEFAULT_PANE_ID,
        }
      }
      const removeKeys = new Set(leaf.tabKeys)
      const tabs = state.tabs.filter((t) => !removeKeys.has(t.key))
      const prunedRoot = removePaneLeaf(state.rootPane, paneId)
      const reconciled = reconcilePaneTree(
        prunedRoot,
        tabs.map((t) => t.key),
        state.activePaneId === paneId ? "" : state.activePaneId,
      )
      return {
        tabs,
        ...reconciled,
      }
    }),

  setSplitRatio: (splitId, ratio) =>
    set((state) => ({
      rootPane: updateSplitRatio(state.rootPane, splitId, ratio),
    })),

  unsplitAll: () =>
    set((state) => {
      const allKeys = state.tabs.map((t) => t.key)
      const rootPane = createInitialPaneLeaf(allKeys, state.activeTabKey, DEFAULT_PANE_ID)
      return {
        rootPane,
        activePaneId: DEFAULT_PANE_ID,
        secondaryTabKey: null,
      }
    }),
}))

// Ensure direct `useTabsStore.setState({ tabs, activeTabKey })` calls in tests
// and legacy helpers keep `rootPane` reconciled automatically.
const rawSetState = useTabsStore.setState.bind(useTabsStore)
useTabsStore.setState = ((updater, replace) => {
  rawSetState((current) => {
    const patch = typeof updater === "function" ? updater(current) : updater
    const merged = replace ? (patch as TabsStore) : { ...current, ...patch }
    const hasExplicitRootPane = patch !== null && typeof patch === "object" && "rootPane" in patch
    const touchesTabsOrActive =
      patch !== null && typeof patch === "object" && ("tabs" in patch || "activeTabKey" in patch)
    if (!hasExplicitRootPane && touchesTabsOrActive) {
      const resetTree =
        "tabs" in patch &&
        (!("activePaneId" in patch) || merged.tabs.length === 0) &&
        listPaneLeaves(current.rootPane).length > 1 &&
        merged.tabs.length <= 1
      const baseRoot = resetTree
        ? createInitialPaneLeaf([], "", DEFAULT_PANE_ID)
        : (merged.rootPane ?? createInitialPaneLeaf([], "", DEFAULT_PANE_ID))
      const reconciled = reconcilePaneTree(
        baseRoot,
        merged.tabs.map((t) => t.key),
        merged.activePaneId ?? DEFAULT_PANE_ID,
        merged.activeTabKey,
      )
      return {
        ...merged,
        ...reconciled,
      }
    }
    return merged
  }, true)
}) as typeof useTabsStore.setState
