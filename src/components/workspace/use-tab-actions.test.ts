import { beforeEach, describe, expect, it } from "vitest"
import { collectDocumentBufferUsage } from "./document-buffer-lifecycle"
import { useTabActions } from "./use-tab-actions"
import { creativeFileId, creativeTabTarget } from "./creative/creative-history"
import { useProjectStore } from "./creative/project-store"
import { catalog, storySummary, workshopSummary } from "./creative/project-fixtures.test-support"
import i18n from "@/lib/i18n"
import { GRAPH_TAB_FILE_ID, useTabsStore, type Tab } from "./use-tabs-store"
import type { TreeItem } from "./sidebar-tree"

const tab = (key: string, fileId: string): Tab => ({
  key,
  kind: "document",
  fileId,
  title: fileId,
  history: [fileId],
  historyIndex: 0,
})

describe("useTabActions buffer ownership", () => {
  beforeEach(() => {
    useTabsStore.setState({ tabs: [], activeTabKey: "", secondaryTabKey: null })
  })

  it("re-evaluates usage after closing a tab and clears a closed secondary pane", async () => {
    const tabs = [tab("first", "one"), tab("second", "two")]
    useTabsStore.setState({ tabs, activeTabKey: "first", secondaryTabKey: "second" })
    let usageAfterClose: ReturnType<typeof collectDocumentBufferUsage> = new Map()
    const actions = useTabActions({
      activeTab: tabs[0],
      activeTabKey: "first",
      secondaryTabKey: "second",
      tabs,
      treeItems: [],
      canGoBack: false,
      canGoForward: false,
      navigateToFile: async () => {},
      onTabUsageChanged: () => {
        const state = useTabsStore.getState()
        usageAfterClose = collectDocumentBufferUsage(
          state.tabs,
          state.activeTabKey,
          state.secondaryTabKey,
        )
      },
    })

    actions.handleTabClose("second")

    expect(useTabsStore.getState()).toMatchObject({
      activeTabKey: "first",
      secondaryTabKey: null,
      tabs: [tabs[0]],
    })
    expect(usageAfterClose.has("two")).toBe(false)
  })

  it("selects a different note for split instead of a duplicate tab", async () => {
    const tabs = [tab("active", "note"), tab("duplicate", "note"), tab("other", "other")]
    useTabsStore.setState({ tabs, activeTabKey: "active", secondaryTabKey: null })
    const actions = useTabActions({
      activeTab: tabs[0],
      activeTabKey: "active",
      secondaryTabKey: null,
      tabs,
      treeItems: [],
      canGoBack: false,
      canGoForward: false,
      navigateToFile: async () => {},
    })

    actions.toggleSplit()

    expect(useTabsStore.getState().secondaryTabKey).toBe("other")
  })

  it("restores the correct view type while going back and forward through mixed history", async () => {
    const treeItems: TreeItem[] = [
      { id: "note", path: "/vault/Note.md", name: "Note", type: "file" },
      { id: "folder", path: "/vault/Folder", name: "Folder", type: "folder", children: [] },
      {
        id: "canvas:/vault/Board.canvas",
        path: "/vault/Board.canvas",
        name: "Board",
        type: "canvas",
      },
    ]
    const history = ["note", "folder", "/vault/Board.canvas"]
    useTabsStore.setState({
      tabs: [
        {
          key: "active",
          kind: "canvas",
          fileId: history[2],
          title: "Board",
          history,
          historyIndex: 2,
        },
      ],
      activeTabKey: "active",
    })
    const loaded: string[] = []
    function useHistoryActions() {
      const state = useTabsStore.getState()
      return useTabActions({
        ...state,
        activeTab: state.tabs[0],
        treeItems,
        canGoBack: state.tabs[0].historyIndex > 0,
        canGoForward: state.tabs[0].historyIndex < 2,
        navigateToFile: async (id) => {
          loaded.push(id)
        },
      })
    }
    await useHistoryActions().handleBack()
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      kind: "folder",
      fileId: "folder",
      title: "Folder",
    })
    await useHistoryActions().handleBack()
    expect(useTabsStore.getState().tabs[0]).toMatchObject({ kind: "document", fileId: "note" })
    await useHistoryActions().handleForward()
    await useHistoryActions().handleForward()
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      kind: "canvas",
      fileId: history[2],
      title: "Board",
    })
    expect(useTabsStore.getState().tabs).toHaveLength(1)
    expect(loaded).toEqual(["folder", "note", "folder", history[2]])
  })

  it("goes back and forward when a header hands its click event in place of a tab key", async () => {
    const treeItems: TreeItem[] = [
      { id: "first", path: "/vault/First.md", name: "First", type: "file" },
      { id: "second", path: "/vault/Second.md", name: "Second", type: "file" },
    ]
    useTabsStore.setState({
      tabs: [{ ...tab("active", "second"), history: ["first", "second"], historyIndex: 1 }],
      activeTabKey: "active",
    })
    function useHistoryActions() {
      const state = useTabsStore.getState()
      return useTabActions({
        ...state,
        activeTab: state.tabs[0],
        treeItems,
        canGoBack: state.tabs[0].historyIndex > 0,
        canGoForward: state.tabs[0].historyIndex < state.tabs[0].history.length - 1,
        navigateToFile: async () => undefined,
      })
    }
    // `onClick={onBack}` passes the event: the active tab must still go back.
    const click = { type: "click" } as unknown as string
    await useHistoryActions().handleBack(click)
    expect(useTabsStore.getState().tabs[0]).toMatchObject({ fileId: "first", historyIndex: 0 })
    await useHistoryActions().handleForward(click)
    expect(useTabsStore.getState().tabs[0]).toMatchObject({ fileId: "second", historyIndex: 1 })
  })

  it("turns the tab back only once the earlier note is read, so no empty page shows", async () => {
    const treeItems: TreeItem[] = [
      { id: "first", path: "/vault/First.md", name: "First", type: "file" },
      { id: "second", path: "/vault/Second.md", name: "Second", type: "file" },
    ]
    useTabsStore.setState({
      tabs: [{ ...tab("active", "second"), history: ["first", "second"], historyIndex: 1 }],
      activeTabKey: "active",
    })
    let finishRead = () => {}
    const state = useTabsStore.getState()
    const pending = useTabActions({
      ...state,
      activeTab: state.tabs[0],
      treeItems,
      canGoBack: true,
      canGoForward: false,
      navigateToFile: () =>
        new Promise<void>((resolve) => {
          finishRead = resolve
        }),
    }).handleBack()
    expect(useTabsStore.getState().tabs[0]).toMatchObject({ fileId: "second", historyIndex: 1 })
    finishRead()
    await pending
    expect(useTabsStore.getState().tabs[0]).toMatchObject({ fileId: "first", historyIndex: 0 })
  })

  it("passes through the link graph: note → graph → note and back again", async () => {
    const treeItems: TreeItem[] = [
      { id: "first", path: "/vault/First.md", name: "First", type: "file" },
      { id: "second", path: "/vault/Second.md", name: "Second", type: "file" },
    ]
    useTabsStore.setState({ tabs: [tab("active", "first")], activeTabKey: "active" })
    const { openItem } = useTabsStore.getState()
    openItem({ kind: "graph", fileId: GRAPH_TAB_FILE_ID, title: "Graph" })
    openItem({ kind: "document", fileId: "second", title: "Second" })
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      history: ["first", GRAPH_TAB_FILE_ID, "second"],
      historyIndex: 2,
    })

    const loaded: string[] = []
    function useHistoryActions() {
      const state = useTabsStore.getState()
      const active = state.tabs[0]
      return useTabActions({
        ...state,
        activeTab: active,
        treeItems,
        canGoBack: active.historyIndex > 0,
        canGoForward: active.historyIndex < active.history.length - 1,
        navigateToFile: async (id) => {
          loaded.push(id)
        },
      })
    }
    await useHistoryActions().handleBack()
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      kind: "graph",
      fileId: GRAPH_TAB_FILE_ID,
      historyIndex: 1,
    })
    await useHistoryActions().handleBack()
    expect(useTabsStore.getState().tabs[0]).toMatchObject({ kind: "document", fileId: "first" })
    await useHistoryActions().handleForward()
    expect(useTabsStore.getState().tabs[0]).toMatchObject({ kind: "graph" })
    await useHistoryActions().handleForward()
    expect(useTabsStore.getState().tabs[0]).toMatchObject({ kind: "document", fileId: "second" })
    expect(useTabsStore.getState().tabs).toHaveLength(1)
    // The graph has no file to load.
    expect(loaded).toEqual(["first", "second"])
  })
})

describe("workshop pages in the tab history", () => {
  const treeItems: TreeItem[] = [{ id: "note", path: "/vault/Note.md", name: "Note", type: "file" }]
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    useTabsStore.setState({ tabs: [], activeTabKey: "", secondaryTabKey: null })
    useProjectStore.getState().setCatalog(
      catalog([
        workshopSummary("w1", {
          name: "Мастерская",
          stories: [storySummary("hills", { name: "Холмы", workshopId: "w1" })],
        }),
      ]),
    )
  })

  const target = (projectId: string, sectionId?: string) =>
    creativeTabTarget(useProjectStore.getState().catalog, i18n.t, projectId, sectionId)

  function stepper() {
    const loaded: string[] = []
    const useActions = () => {
      const state = useTabsStore.getState()
      const active = state.tabs[0]
      return useTabActions({
        ...state,
        activeTab: active,
        treeItems,
        canGoBack: active.historyIndex > 0,
        canGoForward: active.historyIndex < active.history.length - 1,
        navigateToFile: async (id) => {
          loaded.push(id)
        },
      })
    }
    return { loaded, useActions }
  }

  it("walks workshop → story → section → note in one tab, and back through every step", async () => {
    const { openItem } = useTabsStore.getState()
    openItem(target("w1"))
    openItem(target("hills"))
    // A section tab is a step of the history and never jumps to another tab.
    openItem(target("hills", "characters"), false, { inPlace: true })
    openItem({ kind: "document", fileId: "note", title: "Note" })
    const tab = useTabsStore.getState().tabs
    expect(tab).toHaveLength(1)
    expect(tab[0]).toMatchObject({
      history: ["creative:w1", "creative:hills", "creative:hills#characters", "note"],
      historyIndex: 3,
      kind: "document",
    })

    const { useActions, loaded } = stepper()
    await useActions().handleBack()
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      kind: "creative",
      fileId: "creative:hills#characters",
      title: "Холмы",
    })
    await useActions().handleBack()
    expect(useTabsStore.getState().tabs[0]).toMatchObject({ fileId: "creative:hills" })
    await useActions().handleBack()
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      fileId: "creative:w1",
      title: "Мастерская",
      historyIndex: 0,
    })
    await useActions().handleForward()
    await useActions().handleForward()
    await useActions().handleForward()
    expect(useTabsStore.getState().tabs[0]).toMatchObject({ kind: "document", fileId: "note" })
    // Only the note has a file to load; a workshop page has none.
    expect(loaded).toEqual(["note"])
    expect(useTabsStore.getState().tabs).toHaveLength(1)
  })

  it("keeps a section step in the active tab although another tab shows that section", async () => {
    const { openItem } = useTabsStore.getState()
    openItem(target("hills", "notes"))
    openItem(target("hills"), true)
    const [first, second] = useTabsStore.getState().tabs
    expect(useTabsStore.getState().activeTabKey).toBe(second.key)
    openItem(target("hills", "notes"), false, { inPlace: true })
    const tabs = useTabsStore.getState().tabs
    expect(tabs).toHaveLength(2)
    expect(useTabsStore.getState().activeTabKey).toBe(second.key)
    expect(tabs[1].history).toEqual(["creative:hills", "creative:hills#notes"])
    expect(tabs[0]).toEqual(first)
  })

  it("does not repeat a page the tab shows already", async () => {
    const { openItem } = useTabsStore.getState()
    openItem(target("hills", "notes"))
    openItem(target("hills", "notes"), false, { inPlace: true })
    expect(useTabsStore.getState().tabs[0].history).toEqual(["creative:hills#notes"])
  })

  it("opens a tab of an earlier version, which has the overview entry and no history", async () => {
    // What every tab of an earlier version holds: `creative:<project>`, no history to step through.
    useTabsStore.setState({
      tabs: [
        {
          key: "old",
          kind: "creative",
          fileId: "creative:hills",
          title: "Холмы",
          history: [],
          historyIndex: 0,
        },
      ],
      activeTabKey: "old",
    })
    const { openItem } = useTabsStore.getState()
    openItem(target("hills", "characters"), false, { inPlace: true })
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      fileId: creativeFileId("hills", "characters"),
      history: ["creative:hills", "creative:hills#characters"],
      historyIndex: 1,
    })
    stepper().useActions().handleBack()
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      kind: "creative",
      fileId: "creative:hills",
      historyIndex: 0,
    })
  })

  it("steps back from a note opened on a page of an earlier version", async () => {
    useTabsStore.setState({
      tabs: [
        {
          key: "old",
          kind: "creative",
          fileId: "creative:w1",
          title: "Мастерская",
          history: [],
          historyIndex: 0,
        },
      ],
      activeTabKey: "old",
    })
    useTabsStore.getState().openItem({ kind: "document", fileId: "note", title: "Note" })
    expect(useTabsStore.getState().tabs[0].history).toEqual(["creative:w1", "note"])
    stepper().useActions().handleBack()
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      kind: "creative",
      fileId: "creative:w1",
    })
  })
})
