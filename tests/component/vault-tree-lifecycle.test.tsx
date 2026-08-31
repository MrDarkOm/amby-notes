// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { useVaultData } from "@/components/workspace/use-vault-data"
import { useVaultStore } from "@/components/workspace/use-vault-store"
import { useDocStore } from "@/components/workspace/use-doc-store"
import { useTabsStore } from "@/components/workspace/use-tabs-store"
import { useViewStateStore } from "@/components/workspace/use-view-state-store"
import { useSettingsStore } from "@/components/workspace/use-settings-store"
import {
  loadSession,
  loadWorkspaces,
  saveSession,
  saveWorkspaces,
  type SessionFile,
} from "@/components/workspace/app-config"
import { isTauri, loadActiveVaultData, loadVaultData, type TreeItem } from "@/lib/storage"

const currentWindow = vi.hoisted(() => ({
  label: "main",
  onCloseRequested: async () => () => {},
}))

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  isTauri: vi.fn(() => false),
  loadVaultData: vi.fn(),
  loadActiveVaultData: vi.fn(),
  readFile: vi.fn(async () => ""),
  getLinkGraph: vi.fn(async () => ({ nodes: [], edges: [] })),
  startVaultWatcher: vi.fn(async () => {}),
  stopVaultWatcher: vi.fn(async () => {}),
}))
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}))
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => currentWindow,
}))
vi.mock("@/components/workspace/app-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/workspace/app-config")>()),
  loadSession: vi.fn(),
  loadWorkspaces: vi.fn(),
  saveSession: vi.fn(async () => {}),
  saveWorkspaces: vi.fn(async () => {}),
}))

const tree: TreeItem[] = [
  {
    id: "folder",
    path: "/vault/Folder",
    name: "Folder",
    type: "folder",
    children: [{ id: "note", path: "/vault/Folder/Note.md", name: "Note", type: "file" }],
  },
]
const loaded = {
  vaultPath: "/vault",
  generation: 7,
  tree,
  notes: [],
  sync: { inserted: 0, updated: 0, deleted: 0, warnings: [], pathToId: {} },
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState({}, "", "/")
  currentWindow.label = "main"
  vi.mocked(isTauri).mockReturnValue(false)
  useVaultStore.setState(useVaultStore.getInitialState())
  useDocStore.getState().clearDocs()
  useTabsStore.setState({ tabs: [], activeTabKey: "", secondaryTabKey: null })
  useViewStateStore
    .getState()
    .hydrateFromSession({ icons: {}, favorites: [], viewModes: {}, lockedFileIds: [] })
  useSettingsStore.setState({ ...useSettingsStore.getInitialState(), hydrated: true })
  vi.mocked(loadWorkspaces).mockResolvedValue({
    schemaVersion: 1,
    recent: [],
    lastOpened: "/vault",
  })
  vi.mocked(loadSession).mockResolvedValue({
    schemaVersion: 1,
    tabs: [],
    activeFileId: "",
    favorites: [],
    locked: [],
    icons: {},
    viewModes: {},
    nestedNotesPlacements: {},
  })
  vi.mocked(loadVaultData).mockResolvedValue(loaded)
  vi.mocked(loadActiveVaultData).mockResolvedValue(loaded)
})
afterEach(() => {
  cleanup()
  window.history.replaceState({}, "", "/")
})

describe("vault tree component lifecycle", () => {
  it("restores the active tree on remount without replacing live documents or view state", async () => {
    const first = renderHook(() => useVaultData())
    await waitFor(() => expect(first.result.current.treeItems).toEqual(tree))
    act(() => {
      useDocStore.getState().setDoc("note", {
        id: "note",
        path: "/vault/Folder/Note.md",
        title: "Note",
        content: "Unsaved text",
        created: "",
        modified: "",
        wordCount: 2,
      })
      useDocStore.getState().markUnsaved("note")
      useTabsStore.getState().openItem({ kind: "document", fileId: "note", title: "Note" })
      useViewStateStore.getState().toggleTreeItem("folder")
    })
    const tabs = useTabsStore.getState().tabs
    first.unmount()
    // The persisted last-opened path can lag behind the live workspace.
    vi.mocked(loadWorkspaces).mockResolvedValue({
      schemaVersion: 1,
      recent: [],
      lastOpened: "/stale-vault",
    })

    const second = renderHook(() => useVaultData())
    await waitFor(() => expect(second.result.current.treeItems).toEqual(tree))
    expect(useTabsStore.getState().tabs).toBe(tabs)
    expect(useDocStore.getState().openDocs.note.content).toBe("Unsaved text")
    expect(useDocStore.getState().unsavedFileIds.has("note")).toBe(true)
    expect(useViewStateStore.getState().closedTreeIds.has("folder")).toBe(true)
    expect(loadVaultData).toHaveBeenCalledTimes(1)
    expect(loadSession).toHaveBeenCalledTimes(1)
    expect(loadActiveVaultData).toHaveBeenCalledTimes(1)

    act(() => useViewStateStore.getState().toggleFavorite("note"))
    await waitFor(() =>
      expect(saveSession).toHaveBeenCalledWith(expect.objectContaining({ favorites: ["note"] })),
    )
  })

  it("reloads the existing desktop vault without reactivating it or restoring a session", async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    useVaultStore.setState({ vault: "/vault", backendGeneration: 7 })
    const view = renderHook(() => useVaultData())
    await waitFor(() => expect(view.result.current.treeItems).toEqual(tree))
    expect(loadActiveVaultData).toHaveBeenCalledTimes(1)
    expect(loadVaultData).not.toHaveBeenCalled()
    expect(loadSession).not.toHaveBeenCalled()
    expect(useVaultStore.getState().backendGeneration).toBe(7)
  })

  it("keeps the loaded tree if refreshing the same vault fails, and permits a retry", async () => {
    const view = renderHook(() => useVaultData())
    await waitFor(() => expect(view.result.current.treeItems).toEqual(tree))
    vi.mocked(loadActiveVaultData).mockRejectedValueOnce(new Error("temporarily unavailable"))
    await act(() => view.result.current.loadVault("/vault"))
    expect(view.result.current.treeItems).toEqual(tree)
    const updated = [
      ...tree,
      { id: "new-note", path: "/vault/New.md", name: "New", type: "file" as const },
    ]
    vi.mocked(loadActiveVaultData).mockResolvedValueOnce({ ...loaded, tree: updated })
    await act(() => view.result.current.loadVault("/vault"))
    expect(view.result.current.treeItems).toEqual(updated)
  })
})

describe("note window session isolation", () => {
  const session: SessionFile = {
    schemaVersion: 1,
    tabs: [
      { fileId: "other", title: "Other" },
      { fileId: "note", title: "Note" },
    ],
    activeFileId: "other",
    favorites: ["note"],
    locked: ["note"],
    icons: { note: "📓" },
    viewModes: { note: "source" },
    nestedNotesPlacements: {},
    closedTreeIds: ["folder"],
  }
  const windowTree: TreeItem[] = [
    ...tree,
    { id: "other", name: "Other", path: "/vault/Other.md", type: "file" },
  ]

  beforeEach(() => {
    vi.mocked(loadSession).mockResolvedValue(session)
    vi.mocked(loadActiveVaultData).mockResolvedValue({ ...loaded, tree: windowTree })
    vi.mocked(loadVaultData).mockResolvedValue({ ...loaded, tree: windowTree })
  })

  it.each([
    { desktop: true, restoreSession: true },
    { desktop: true, restoreSession: false },
    { desktop: false, restoreSession: true },
  ])(
    "opens only the requested note after delayed hydration ($desktop, $restoreSession)",
    async ({ desktop, restoreSession }) => {
      vi.mocked(isTauri).mockReturnValue(desktop)
      currentWindow.label = "note-test"
      window.history.replaceState({}, "", "/?ambyFile=note")
      const prefs = useSettingsStore.getState().prefs
      useSettingsStore.setState({
        prefs: { ...prefs, startup: { ...prefs.startup, restoreSession } },
      })
      let finishSession!: (value: SessionFile) => void
      vi.mocked(loadSession).mockReturnValueOnce(
        new Promise((resolve) => {
          finishSession = resolve
        }),
      )

      const view = renderHook(() => useVaultData())
      await waitFor(() => expect(loadSession).toHaveBeenCalled())
      expect(useTabsStore.getState().tabs).toEqual([])
      await act(async () => finishSession(session))

      const tabs = useTabsStore.getState().tabs
      expect(tabs).toEqual([
        expect.objectContaining({ kind: "document", fileId: "note", title: "Note" }),
      ])
      expect(useTabsStore.getState().activeTabKey).toBe(tabs[0].key)
      expect(useViewStateStore.getState().iconOverrides.note).toBe("📓")
      expect(useViewStateStore.getState().favorites.has("note")).toBe(true)
      expect(useViewStateStore.getState().closedTreeIds.has("folder")).toBe(true)
      expect(view.result.current.treeItems).toEqual(windowTree)
      if (desktop) expect(loadVaultData).not.toHaveBeenCalled()

      // A watcher refresh and rerender must not append or replace the launch tab.
      await act(() => view.result.current.refreshTree())
      expect(useTabsStore.getState().tabs).toHaveLength(1)
      expect(useTabsStore.getState().activeTabKey).toBe(tabs[0].key)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 450))
      })
      expect(saveSession).not.toHaveBeenCalled()
      expect(saveWorkspaces).not.toHaveBeenCalled()
    },
  )

  it("does not fall back to the main session when the requested note is missing", async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    currentWindow.label = "note-missing"
    window.history.replaceState({}, "", "/?ambyFile=missing")
    const view = renderHook(() => useVaultData())
    await waitFor(() => expect(view.result.current.treeItems).toEqual(windowTree))
    expect(useViewStateStore.getState().favorites.has("note")).toBe(true)
    expect(useTabsStore.getState().tabs).toEqual([])
  })

  it("still restores the saved tabs and active selection in the main workspace", async () => {
    renderHook(() => useVaultData())
    await waitFor(() => expect(useTabsStore.getState().tabs).toHaveLength(2))
    const { tabs, activeTabKey } = useTabsStore.getState()
    expect(tabs.map((tab) => tab.fileId)).toEqual(["other", "note"])
    expect(tabs.find((tab) => tab.key === activeTabKey)?.fileId).toBe("other")
  })
})
