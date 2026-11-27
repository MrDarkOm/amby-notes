// "Open the note" in the notification centre shows the tab the note already has, by its id, whether or not its
// file is still in the tree (a deleted file is not).
import { beforeEach, describe, expect, it } from "vitest"
import { useTabsStore, type Tab } from "../use-tabs-store"
import { activateNoteTab } from "./activate-note-tab"

const tab = (key: string, fileId: string): Tab => ({
  key,
  kind: "document",
  fileId,
  title: fileId,
  history: [],
  historyIndex: 0,
})

beforeEach(() => {
  useTabsStore.setState(useTabsStore.getInitialState())
  useTabsStore.getState().setTabs([tab("a", "note-a"), tab("b", "note-b")])
  useTabsStore.getState().setActiveTabKey("a")
})

describe("activateNoteTab", () => {
  it("makes the tab of the note active and says it did", () => {
    expect(activateNoteTab("note-b")).toBe(true)
    expect(useTabsStore.getState().activeTabKey).toBe("b")
  })

  it("does nothing and says so when the note has no tab", () => {
    expect(activateNoteTab("note-c")).toBe(false)
    expect(useTabsStore.getState().activeTabKey).toBe("a")
  })

  it("finds a tab in the other pane of a split", () => {
    const pane = useTabsStore.getState().splitPane("horizontal", { tabKey: "b", moveTab: true })
    expect(pane).not.toBeNull()
    useTabsStore.getState().focusPane(useTabsStore.getState().activePaneId)
    expect(activateNoteTab("note-b")).toBe(true)
    expect(useTabsStore.getState().activeTabKey).toBe("b")
  })
})
