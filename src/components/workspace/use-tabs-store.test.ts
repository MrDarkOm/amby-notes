import { beforeEach, describe, expect, it } from "vitest"

import { useTabsStore, type Tab, type TabTarget } from "./use-tabs-store"

function canvasTab(key: string): Tab {
  return {
    key,
    kind: "canvas",
    fileId: "/vault/board.canvas",
    title: "board",
    history: [],
    historyIndex: 0,
  }
}

describe("useTabsStore singleton tabs", () => {
  beforeEach(() => {
    useTabsStore.setState({ tabs: [], activeTabKey: "", secondaryTabKey: null })
  })

  it("atomically opens one Canvas tab across repeated calls", () => {
    const store = useTabsStore.getState()

    expect(store.openOrActivateSingletonTab(canvasTab("first"))).toBe("first")
    expect(store.openOrActivateSingletonTab(canvasTab("second"))).toBe("first")

    expect(useTabsStore.getState()).toMatchObject({
      activeTabKey: "first",
      tabs: [canvasTab("first")],
    })
  })
})

const targets: TabTarget[] = [
  { kind: "document", fileId: "note-id", title: "Note" },
  { kind: "folder", fileId: "folder:/vault/folder", title: "Folder" },
  { kind: "canvas", fileId: "/vault/board.canvas", title: "Board" },
]

describe("ordinary item navigation", () => {
  beforeEach(() => useTabsStore.setState({ tabs: [], activeTabKey: "", secondaryTabKey: null }))

  it.each(targets)("replaces an active $kind tab with any other item type", (initial) => {
    const { openItem } = useTabsStore.getState()
    openItem(initial)
    const key = useTabsStore.getState().activeTabKey
    for (const target of targets.filter((item) => item.kind !== initial.kind)) {
      openItem(target)
      expect(useTabsStore.getState().tabs).toHaveLength(1)
      expect(useTabsStore.getState().tabs[0]).toMatchObject({ ...target, key })
      expect(useTabsStore.getState().activeTabKey).toBe(key)
    }
  })

  it.each(targets)(
    "activates the existing $kind tab without changing either tab's history",
    (target) => {
      const { openItem } = useTabsStore.getState()
      openItem(target)
      const existingKey = useTabsStore.getState().activeTabKey
      openItem({ kind: "document", fileId: "other", title: "Other" }, true)
      const originalTabs = useTabsStore.getState().tabs
      openItem(target)
      openItem(target)
      expect(useTabsStore.getState().tabs).toBe(originalTabs)
      expect(useTabsStore.getState().activeTabKey).toBe(existingKey)
    },
  )

  it.each(targets)("opens an extra $kind tab only when explicitly requested", (target) => {
    const { openItem } = useTabsStore.getState()
    openItem(target)
    openItem(target, true)
    const secondKey = useTabsStore.getState().activeTabKey
    expect(useTabsStore.getState().tabs).toHaveLength(2)
    openItem(target)
    expect(useTabsStore.getState().tabs).toHaveLength(2)
    expect(useTabsStore.getState().activeTabKey).toBe(secondKey)
  })

  it("drops forward history when navigating to a different item", () => {
    const { openItem } = useTabsStore.getState()
    openItem(targets[0])
    openItem(targets[1])
    useTabsStore.getState().setTabs((tabs) => [{ ...tabs[0], ...targets[0], historyIndex: 0 }])
    openItem(targets[2])
    expect(useTabsStore.getState().tabs[0].history).toEqual([targets[0].fileId, targets[2].fileId])
    expect(useTabsStore.getState().tabs[0].historyIndex).toBe(1)
  })

  it("reuses a graph tab when a graph node is selected", () => {
    useTabsStore.setState({
      tabs: [
        {
          key: "graph",
          kind: "graph",
          fileId: "__graph__",
          title: "Graph",
          history: [],
          historyIndex: 0,
        },
      ],
      activeTabKey: "graph",
    })
    useTabsStore.getState().openItem(targets[0])
    expect(useTabsStore.getState().tabs).toEqual([
      { ...targets[0], key: "graph", history: [targets[0].fileId], historyIndex: 0 },
    ])
  })
})
