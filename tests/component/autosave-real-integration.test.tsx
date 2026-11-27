// @vitest-environment happy-dom
//
// SAVE-13: the save paths run for real, only the storage port is fake.
//
// Real: `useMarkdownAutosave` (coordinator, queue, conflict pause), `useVaultData` (the watcher
// callback that reloads or turns into a conflict, the window-close handler, `loadVault(null)`),
// `reloadOpenNotes`, the autosave lifecycle, `useDocStore` / `useVaultStore` / `useTabsStore`, and
// the recovery journal (localStorage in the browser adapter).
// Fake: the storage port (`readNote` / `writeNote` / `getNoteProperties` ...) as an in-memory disk with
// compare-and-swap revisions and gates that hold a read or a write in flight, the Tauri `listen`
// bridge (to deliver watcher events) and the Tauri window (to deliver a close request). No renderer
// and no editor is faked: the editor only calls `handleContentChange`, which the tests call directly,
// because ProseMirror serialization is not what this suite is about.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { useVaultData } from "@/components/workspace/use-vault-data"
import { useMarkdownAutosave } from "@/components/workspace/file-actions/use-markdown-autosave"
import { reloadOpenNotes } from "@/components/workspace/reload-open-notes"
import { useVaultStore } from "@/components/workspace/use-vault-store"
import { useDocStore, type Document } from "@/components/workspace/use-doc-store"
import { useTabsStore } from "@/components/workspace/use-tabs-store"
import { useViewStateStore } from "@/components/workspace/use-view-state-store"
import { useSettingsStore } from "@/components/workspace/use-settings-store"
import { loadSession, loadWorkspaces } from "@/components/workspace/app-config"
import {
  getNoteProperties,
  isTauri,
  loadActiveVaultData,
  loadVaultData,
  NoteRevisionConflictError,
  readNote,
  refreshVaultPaths,
  writeNote,
  type TreeItem,
} from "@/lib/storage"
import { listen } from "@tauri-apps/api/event"

const currentWindow = vi.hoisted(() => ({
  label: "main",
  closeHandler: null as null | ((event: { preventDefault(): void }) => Promise<void>),
  onCloseRequested: async (handler: (event: { preventDefault(): void }) => Promise<void>) => {
    currentWindow.closeHandler = handler
    return () => {}
  },
  destroy: vi.fn(async () => {}),
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

const tree: TreeItem[] = [{ id: "note", path: "/vault/Note.md", name: "Note", type: "file" }]
const loaded = {
  vaultPath: "/vault",
  generation: 7,
  tree,
  notes: [],
  sync: { inserted: 0, updated: 0, deleted: 0, warnings: [], pathToId: {} },
}

interface Gate {
  started: Promise<void>
  release: () => void
}

/** In-memory disk behind the storage port: compare-and-swap writes, held reads/writes, a write log. */
class FakeDisk {
  content = "saved"
  revision = "r1"
  private counter = 1
  writeLog: Array<{ content: string; expectedRevision: string }> = []
  maxConcurrentWrites = 0
  private activeWrites = 0
  private writeGates: Array<{ signal: () => void; wait: Promise<void> }> = []
  private readGates: Array<{ signal: () => void; wait: Promise<void> }> = []

  private gate(queue: FakeDisk["writeGates"]): Gate {
    let signal!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => (signal = resolve))
    const wait = new Promise<void>((resolve) => (release = resolve))
    queue.push({ signal, wait })
    return { started, release }
  }

  /** The next write stops after it has started, before it reaches the disk. */
  holdNextWrite(): Gate {
    return this.gate(this.writeGates)
  }

  holdNextRead(): Gate {
    return this.gate(this.readGates)
  }

  /** Another program changed the file. */
  externalEdit(content: string): string {
    this.content = content
    this.revision = `r${++this.counter}`
    return this.revision
  }

  readonly read = async () => {
    const gate = this.readGates.shift()
    // The text is read when the read starts, as a real read would.
    const snapshot = { content: this.content, source: this.content, revision: this.revision }
    if (gate) {
      gate.signal()
      await gate.wait
    }
    return snapshot
  }

  readonly write = async (
    _vault: string,
    _noteId: string,
    content: string,
    _generation: number | null,
    expectedRevision: string,
  ) => {
    this.writeLog.push({ content, expectedRevision })
    this.maxConcurrentWrites = Math.max(this.maxConcurrentWrites, ++this.activeWrites)
    try {
      const gate = this.writeGates.shift()
      if (gate) {
        gate.signal()
        await gate.wait
      }
      if (expectedRevision !== this.revision) throw new NoteRevisionConflictError(this.revision)
      this.content = content
      this.revision = `r${++this.counter}`
      return {
        path: "/vault/Note.md",
        revision: this.revision,
        indexState: "healthy" as const,
        warnings: [],
      }
    } finally {
      this.activeWrites -= 1
    }
  }
}

function noteDocument(overrides: Partial<Document> = {}): Document {
  return {
    id: "note",
    title: "Note",
    path: "/vault/Note.md",
    content: "saved",
    source: "saved",
    revision: "r1",
    created: "",
    modified: "",
    wordCount: 1,
    ...overrides,
  }
}

let disk: FakeDisk
let listeners: Map<string, (event: { payload: unknown }) => void>

const key = () => ({
  generation: useVaultStore.getState().generation,
  kind: "markdown" as const,
  documentId: "note",
})

/** The two real owners of the save paths in one renderer: the vault data hook and the autosave hook. */
function useWorkspace() {
  const data = useVaultData()
  const generation = useVaultStore((state) => state.generation)
  const backendGeneration = useVaultStore((state) => state.backendGeneration)
  const markdown = useMarkdownAutosave({
    vault: "/vault",
    autosaveGeneration: generation,
    backendGeneration: backendGeneration ?? 7,
    windowLabel: "main",
    applyMutationResult: vi.fn(),
  })
  return { data, markdown }
}

async function mountWorkspace(autosaveMs: number) {
  const initial = useSettingsStore.getInitialState()
  useSettingsStore.setState({
    ...initial,
    hydrated: true,
    prefs: { ...initial.prefs, editor: { ...initial.prefs.editor, autosaveMs } },
  })
  useVaultStore.setState({ vault: "/vault", backendGeneration: 7 })
  const view = renderHook(() => useWorkspace())
  await waitFor(() => expect(view.result.current.data.treeItems).toEqual(tree))
  await waitFor(() => expect(listeners.has("vault-file-changed")).toBe(true))
  act(() => useDocStore.getState().setDoc("note", noteDocument()))
  useTabsStore.setState({
    tabs: [{ key: "note", kind: "document", fileId: "note", title: "Note" }] as never,
    activeTabKey: "note",
  })
  return view
}

const type = (view: Awaited<ReturnType<typeof mountWorkspace>>, text: string) =>
  act(() => view.result.current.markdown.handleContentChange("note", text))

/** A change reported by the file watcher; the hook debounces it for 300 ms. */
const watcherReports = () =>
  act(() =>
    listeners.get("vault-file-changed")!({
      payload: { kind: "modify", path: "/vault/Note.md" },
    }),
  )

beforeEach(() => {
  vi.clearAllMocks()
  disk = new FakeDisk()
  listeners = new Map()
  currentWindow.label = "main"
  currentWindow.closeHandler = null
  window.localStorage.clear()
  window.history.replaceState({}, "", "/")
  vi.mocked(listen)
    .mockReset()
    .mockImplementation(async (name, handler) => {
      listeners.set(name as string, handler as (event: { payload: unknown }) => void)
      return () => {
        listeners.delete(name as string)
      }
    })
  vi.mocked(isTauri).mockReturnValue(true)
  vi.mocked(refreshVaultPaths).mockResolvedValue(null)
  vi.mocked(readNote).mockImplementation(disk.read as never)
  vi.mocked(writeNote).mockImplementation(disk.write as never)
  vi.mocked(getNoteProperties).mockResolvedValue({
    hasFrontmatter: false,
    properties: [],
    customProperties: [],
  })
  useVaultStore.setState(useVaultStore.getInitialState())
  useDocStore.getState().clearDocs()
  useTabsStore.setState({ tabs: [], activeTabKey: "" })
  useViewStateStore
    .getState()
    .hydrateFromSession({ icons: {}, favorites: [], viewModes: {}, lockedFileIds: [] })
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

describe("autosave with the real hooks and a fake storage port", () => {
  describe("typing during an external change of the file (watcher)", () => {
    it("keeps text typed before the change as a conflict and writes nothing over it", async () => {
      const view = await mountWorkspace(60_000)
      type(view, "local text")
      disk.externalEdit("edited elsewhere")
      watcherReports()

      await waitFor(() =>
        expect(useDocStore.getState().externalConflicts.note?.externalContent).toBe(
          "edited elsewhere",
        ),
      )
      expect(useDocStore.getState().openDocs.note.content).toBe("local text")
      expect(useDocStore.getState().unsavedFileIds.has("note")).toBe(true)
      // The scheduled save is paused by the conflict: it must not overwrite the other program.
      await view.result.current.markdown.autosave.flush(key()).catch(() => undefined)
      expect(disk.writeLog).toEqual([])
      expect(disk.content).toBe("edited elsewhere")
    })

    it("keeps text typed while the watcher is reading the file", async () => {
      const view = await mountWorkspace(60_000)
      disk.externalEdit("edited elsewhere")
      const read = disk.holdNextRead()
      watcherReports()
      await read.started
      type(view, "typed during the read")
      read.release()

      await waitFor(() =>
        expect(useDocStore.getState().externalConflicts.note?.localContent).toBe(
          "typed during the read",
        ),
      )
      expect(useDocStore.getState().openDocs.note.content).toBe("typed during the read")
      expect(useDocStore.getState().openDocs.note.revision).toBe("r1")
      expect(disk.writeLog).toEqual([])
    })

    // SAVE-03: type, save, type and undo back to the saved text. The store flag looks clean, but the
    // next save is queued; an external change must be a conflict, not a reload under that save.
    it("does not take an external change as clean while an equal-text save is queued", async () => {
      const view = await mountWorkspace(60_000)
      type(view, "X")
      const hold = disk.holdNextWrite()
      let saving!: Promise<void>
      act(() => {
        saving = view.result.current.markdown.autosave.flush(key())
      })
      await hold.started
      type(view, "Y")
      type(view, "X")
      await act(async () => {
        hold.release()
        await saving
      })
      expect(disk.content).toBe("X")
      expect(useDocStore.getState().unsavedFileIds.has("note")).toBe(true)

      disk.externalEdit("edited elsewhere")
      watcherReports()
      await waitFor(() => expect(useDocStore.getState().externalConflicts.note).toBeDefined())
      expect(useDocStore.getState().openDocs.note.content).toBe("X")
      expect(disk.content).toBe("edited elsewhere")
    })
  })

  describe("typing during reloadOpenNotes (refreshLocalVault)", () => {
    it("does not replace text typed while another read is pending", async () => {
      const view = await mountWorkspace(60_000)
      disk.externalEdit("pulled by sync")
      const read = disk.holdNextRead()
      const reloading = reloadOpenNotes("/vault")
      await read.started
      type(view, "typed during the reload")
      await act(async () => {
        read.release()
        await reloading
      })

      expect(useDocStore.getState().openDocs.note.content).toBe("typed during the reload")
      expect(useDocStore.getState().externalConflicts.note).toMatchObject({
        localContent: "typed during the reload",
        externalContent: "pulled by sync",
      })
      expect(disk.writeLog).toEqual([])
    })

    it("reloads a clean note and leaves it clean", async () => {
      await mountWorkspace(60_000)
      disk.externalEdit("pulled by sync")
      await act(() => reloadOpenNotes("/vault"))
      expect(useDocStore.getState().openDocs.note).toMatchObject({
        content: "pulled by sync",
        revision: disk.revision,
      })
      expect(useDocStore.getState().externalConflicts.note).toBeUndefined()
    })
  })

  describe("closing with a dirty buffer and a write in flight", () => {
    async function dirtyWithWriteInFlight() {
      const view = await mountWorkspace(60_000)
      type(view, "first")
      const hold = disk.holdNextWrite()
      let saving!: Promise<void>
      act(() => {
        saving = view.result.current.markdown.autosave.flush(key())
      })
      await hold.started
      type(view, "second, typed while the first is being written")
      return { view, hold, saving }
    }

    it("the window close request waits and the last edit is on disk before the window is destroyed", async () => {
      const { hold } = await dirtyWithWriteInFlight()
      let diskAtDestroy = ""
      currentWindow.destroy.mockImplementationOnce(async () => {
        diskAtDestroy = disk.content
      })
      await waitFor(() => expect(currentWindow.closeHandler).not.toBeNull())
      const closing = currentWindow.closeHandler!({ preventDefault: () => {} })
      await act(async () => {
        hold.release()
        await closing
      })

      expect(currentWindow.destroy).toHaveBeenCalledOnce()
      expect(diskAtDestroy).toBe("second, typed while the first is being written")
    })

    it("closing the workspace (loadVault(null)) saves the last edit before the buffers are cleared", async () => {
      const { view, hold } = await dirtyWithWriteInFlight()
      let closing!: Promise<void>
      act(() => {
        closing = view.result.current.data.loadVault(null)
      })
      await act(async () => {
        hold.release()
        await closing
      })

      expect(disk.content).toBe("second, typed while the first is being written")
      expect(useDocStore.getState().openDocs).toEqual({})
      expect(useVaultStore.getState().vault).toBeNull()
    })

    it("a closed tab does not drop the buffer that still has an unsaved edit", async () => {
      const { view, hold, saving } = await dirtyWithWriteInFlight()
      act(() => useTabsStore.setState({ tabs: [], activeTabKey: "" }))
      await act(() => view.result.current.markdown.releaseUnusedDocumentBuffers())
      expect(useDocStore.getState().openDocs.note?.content).toBe(
        "second, typed while the first is being written",
      )
      await act(async () => {
        hold.release()
        await saving
        await view.result.current.markdown.autosave.flush(key())
      })
      expect(disk.content).toBe("second, typed while the first is being written")
    })
  })

  describe("several quick edits and a slow write", () => {
    it("serializes the writes, chains the revision and leaves the last text on disk", async () => {
      const view = await mountWorkspace(20)
      const hold = disk.holdNextWrite()
      type(view, "v1")
      await hold.started
      type(view, "v2")
      type(view, "v3")
      type(view, "v4")
      await act(async () => {
        hold.release()
        await view.result.current.markdown.autosave.flush(key())
      })
      await waitFor(() => expect(useDocStore.getState().unsavedFileIds.has("note")).toBe(false))

      expect(disk.content).toBe("v4")
      expect(disk.maxConcurrentWrites).toBe(1)
      expect(disk.writeLog.at(-1)).toEqual({ content: "v4", expectedRevision: "r2" })
      expect(disk.writeLog[0]).toEqual({ content: "v1", expectedRevision: "r1" })
      expect(useDocStore.getState().externalConflicts.note).toBeUndefined()
      expect(useDocStore.getState().openDocs.note).toMatchObject({
        content: "v4",
        revision: disk.revision,
      })
    })
  })
})
