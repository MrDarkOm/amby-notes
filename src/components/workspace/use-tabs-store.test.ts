import { beforeEach, describe, expect, it } from "vitest"

import { useTabsStore, type Tab } from "./use-tabs-store"

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
