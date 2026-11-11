// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { useVaultData } from "@/components/workspace/use-vault-data"
import {
  beginLocalTreeMutation,
  recordLocalTreePaths,
} from "@/components/workspace/watcher-tree-reconciliation"
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
import {
  isTauri,
  loadActiveVaultData,
  loadVaultData,
  readNote,
  listArchive,
  writeNote,
  writeFile,
  getNoteProperties,
  refreshVaultPaths,
  type TreeItem,
} from "@/lib/storage"
import { listen } from "@tauri-apps/api/event"

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
  readNote: vi.fn(),
  listArchive: vi.fn(async () => []),
  writeNote: vi.fn(),
  writeFile: vi.fn(),
  getNoteProperties: vi.fn(),
  refreshVaultPaths: vi.fn(async () => null),
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

// A super note: the folder "Note/" holds "Note.md", its canvas, its sketch and the views of its database.
const tree: TreeItem[] = [
  {
    id: "note",
    path: "/vault/Note/Note.md",
    name: "Note",
    type: "file",
    children: [
      {
        id: "canvas:/vault/Note/Note.canvas",
        path: "/vault/Note/Note.canvas",
        name: "Note",
        type: "canvas",
      },
    ],
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
  vi.mocked(listen)
    .mockReset()
    .mockResolvedValue(() => {})
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

describe("a whole super note deleted on another computer while its note is open (К15)", () => {
  it.each([
    ["clean", false, false],
    ["dirty", true, false],
    ["clean, patched tree", false, true],
    ["dirty, patched tree", true, true],
  ])("keeps the tab and the text of a %s note and marks it deleted", async (_n, dirty, patched) => {
    const listeners = new Map<string, (event: { payload: unknown }) => void>()
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      listeners.set(name, handler as (event: { payload: unknown }) => void)
      return () => {
        listeners.delete(name)
      }
    })
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(refreshVaultPaths).mockResolvedValue(
      patched
        ? {
            generation: 7,
            patch: {
              ops: [{ kind: "remove", parentPath: "/vault", paths: ["/vault/Note/Note.md"] }],
            },
          }
        : null,
    )
    vi.mocked(readNote).mockRejectedValue(new Error("gone"))
    useVaultStore.setState({ vault: "/vault", backendGeneration: 7 })
    const view = renderHook(() => useVaultData())
    await waitFor(() => expect(view.result.current.treeItems).toEqual(tree))
    act(() => {
      useDocStore.getState().setDoc("note", {
        id: "note",
        path: "/vault/Note/Note.md",
        title: "Note",
        content: "open text",
        source: "open text",
        revision: "r1",
        created: "",
        modified: "",
        wordCount: 2,
      })
      if (dirty) useDocStore.getState().markUnsaved("note")
      useTabsStore.getState().openItem({ kind: "document", fileId: "note", title: "Note" })
    })
    vi.mocked(loadActiveVaultData).mockResolvedValue({ ...loaded, tree: [] })
    await waitFor(() => expect(listeners.has("vault-file-changed")).toBe(true))
    act(() =>
      listeners.get("vault-file-changed")!({ payload: { kind: "remove", path: "/vault/Note" } }),
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(useDocStore.getState().openDocs.note?.content).toBe("open text")
    expect(useDocStore.getState().openDocs.note?.externallyDeleted).toBe(true)
    expect(useTabsStore.getState().tabs.some((tab) => tab.fileId === "note")).toBe(true)
    expect(useDocStore.getState().externalConflicts.note?.externalContent).toBeNull()
  })
})

function captureListeners() {
  const listeners = new Map<string, (event: { payload: unknown }) => void>()
  vi.mocked(listen).mockImplementation(async (name, handler) => {
    listeners.set(name, handler as (event: { payload: unknown }) => void)
    return () => {
      listeners.delete(name)
    }
  })
  return listeners
}

const noteDoc = (path: string) => ({
  id: "note",
  path,
  title: "Note",
  content: "open text",
  source: "open text",
  revision: "r1",
  created: "",
  modified: "",
  wordCount: 2,
})

describe("a whole super note deleted elsewhere: the database and canvas tabs of the note (К15)", () => {
  // A tab opened on the database layer of a super note holds the note's own text as well; a folder
  // deleted on another computer must not drop it, dirty or not.
  it.each([
    ["clean", false],
    ["dirty", true],
  ])("keeps a %s database tab with its text and marks it deleted", async (_n, dirty) => {
    const listeners = captureListeners()
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(refreshVaultPaths).mockResolvedValue(null)
    vi.mocked(readNote).mockRejectedValue(new Error("gone"))
    useVaultStore.setState({ vault: "/vault", backendGeneration: 7 })
    const view = renderHook(() => useVaultData())
    await waitFor(() => expect(view.result.current.treeItems).toEqual(tree))
    const id = "database:/vault/Note/ambd.json"
    act(() => {
      const doc = { ...noteDoc("/vault/Note/ambd.json"), id, noteId: "note" }
      useDocStore.getState().setDoc(id, doc)
      if (dirty) useDocStore.getState().markUnsaved(id)
      useTabsStore.getState().openItem({ kind: "database", fileId: id, title: "Note" })
    })
    vi.mocked(loadActiveVaultData).mockResolvedValue({ ...loaded, tree: [] })
    await waitFor(() => expect(listeners.has("vault-file-changed")).toBe(true))
    act(() =>
      listeners.get("vault-file-changed")!({ payload: { kind: "remove", path: "/vault/Note" } }),
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(useDocStore.getState().openDocs[id]?.content).toBe("open text")
    expect(useDocStore.getState().openDocs[id]?.externallyDeleted).toBe(true)
    expect(useTabsStore.getState().tabs.some((tab) => tab.fileId === id)).toBe(true)
    expect(useDocStore.getState().externalConflicts[id]?.externalContent).toBeNull()
    expect(writeNote).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })
})

describe("a note that turned up at another path later (К14)", () => {
  async function setup(dirty: boolean) {
    const listeners = captureListeners()
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(refreshVaultPaths).mockResolvedValue(null)
    vi.mocked(readNote).mockRejectedValue(new Error("gone"))
    const flat: TreeItem[] = [{ id: "note", path: "/vault/Note.md", name: "Note", type: "file" }]
    vi.mocked(loadActiveVaultData).mockResolvedValue({ ...loaded, tree: flat })
    vi.mocked(loadVaultData).mockResolvedValue({ ...loaded, tree: flat })
    useVaultStore.setState({ vault: "/vault", backendGeneration: 7 })
    const view = renderHook(() => useVaultData())
    await waitFor(() => expect(view.result.current.treeItems).toEqual(flat))
    act(() => {
      useDocStore.getState().setDoc("note", noteDoc("/vault/Note.md"))
      if (dirty) useDocStore.getState().markUnsaved("note")
      useTabsStore.getState().openItem({ kind: "document", fileId: "note", title: "Note" })
    })
    await waitFor(() => expect(listeners.has("vault-file-changed")).toBe(true))
    const fire = async (path: string) => {
      act(() => listeners.get("vault-file-changed")!({ payload: { kind: "remove", path } }))
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    // First refresh: the old path is gone and the new one is not there yet.
    vi.mocked(loadActiveVaultData).mockResolvedValue({ ...loaded, tree: [] })
    await fire("/vault/Note.md")
    expect(useDocStore.getState().openDocs.note?.externallyDeleted).toBe(true)
    return { fire }
  }

  it.each([
    ["clean", false],
    ["dirty", true],
  ])("follows the note and drops the deletion card (%s)", async (_n, dirty) => {
    const { fire } = await setup(dirty)
    const moved: TreeItem[] = [
      { id: "note", path: "/vault/Note/Note.md", name: "Note", type: "file" },
    ]
    vi.mocked(loadActiveVaultData).mockResolvedValue({ ...loaded, tree: moved })
    vi.mocked(readNote).mockResolvedValue({
      content: "open text",
      source: "open text",
      revision: "r2",
    } as never)
    await fire("/vault/Note/ambd.json")
    const doc = useDocStore.getState().openDocs.note
    expect(doc?.path).toBe("/vault/Note/Note.md")
    expect(doc?.externallyDeleted).toBeFalsy()
    expect(doc?.content).toBe("open text")
    expect(useDocStore.getState().externalConflicts.note).toBeUndefined()
    expect(useTabsStore.getState().tabs.some((tab) => tab.fileId === "note")).toBe(true)
    expect(writeNote).not.toHaveBeenCalled()
  })

  it("keeps the card when the note turned up in the archive (К13)", async () => {
    const { fire } = await setup(false)
    const archived: TreeItem[] = [
      { id: "note", path: "/vault/.amby/archive/Note.md", name: "Note", type: "file" },
    ]
    vi.mocked(loadActiveVaultData).mockResolvedValue({ ...loaded, tree: archived })
    await fire("/vault/Note/ambd.json")
    const doc = useDocStore.getState().openDocs.note
    expect(doc?.path).toBe("/vault/Note.md")
    expect(doc?.externallyDeleted).toBe(true)
    expect(useTabsStore.getState().tabs.some((tab) => tab.fileId === "note")).toBe(true)
  })

  it("keeps a differing text as a conflict, never overwrites it", async () => {
    const { fire } = await setup(true)
    const moved: TreeItem[] = [
      { id: "note", path: "/vault/Note/Note.md", name: "Note", type: "file" },
    ]
    vi.mocked(loadActiveVaultData).mockResolvedValue({ ...loaded, tree: moved })
    vi.mocked(readNote).mockResolvedValue({
      content: "text from the other computer",
      source: "text from the other computer",
      revision: "r2",
    } as never)
    await fire("/vault/Note/ambd.json")
    const doc = useDocStore.getState().openDocs.note
    expect(doc?.content).toBe("open text")
    expect(useDocStore.getState().externalConflicts.note?.externalContent).toBe(
      "text from the other computer",
    )
    expect(writeNote).not.toHaveBeenCalled()
  })
})
