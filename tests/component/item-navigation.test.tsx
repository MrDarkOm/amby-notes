// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { useDocumentLoading } from "@/components/workspace/file-actions/use-document-loading"
import { AutosaveCoordinator } from "@/components/workspace/autosave/autosave-coordinator"
import type { MarkdownAutosavePayload } from "@/components/workspace/file-actions/types"
import { useDocStore } from "@/components/workspace/use-doc-store"
import { useTabsStore } from "@/components/workspace/use-tabs-store"
import { useVaultStore } from "@/components/workspace/use-vault-store"
import { getNoteMetadata, getNoteProperties, readNote } from "@/lib/storage"
import { discardRecoveryDraft, readRecoveryDraft } from "@/lib/recovery-drafts"
import { useNoteNoticesStore } from "@/components/workspace/note-notices/use-note-notices-store"

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  readNote: vi.fn(),
  getNoteMetadata: vi.fn(),
  getNoteProperties: vi.fn(),
}))
vi.mock("@/lib/recovery-drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recovery-drafts")>()),
  readRecoveryDraft: vi.fn(),
  discardRecoveryDraft: vi.fn(async () => {}),
}))

const note = { content: "Body", source: "Body", revision: "r1" }
function params(): Parameters<typeof useDocumentLoading>[0] {
  return {
    vault: "/vault",
    backendGeneration: 1,
    windowLabel: "main",
    treeItems: [
      { id: "one", path: "/vault/One.md", name: "One", type: "file" },
      { id: "two", path: "/vault/Two.md", name: "Two", type: "file" },
      { id: "folder", path: "/vault/Folder", name: "Folder", type: "folder", children: [] },
      {
        id: "canvas:/vault/Board.canvas",
        path: "/vault/Board.canvas",
        name: "Board",
        type: "canvas",
      },
    ],
    refreshTree: vi.fn(async () => []),
    loadCanvas: vi.fn(async () => {}),
    setPendingRenameId: vi.fn(),
    autosave: new AutosaveCoordinator<MarkdownAutosavePayload>({ save: async () => {} }),
    autosaveKey: (documentId) => ({ generation: 1, kind: "markdown", documentId }),
    handleApplyMutation: vi.fn(),
    handleContentChange: vi.fn(),
    releaseUnusedDocumentBuffers: vi.fn(async () => {}),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useTabsStore.setState({ tabs: [], activeTabKey: "", secondaryTabKey: null })
  useDocStore.getState().clearDocs()
  useVaultStore.setState({ vault: "/vault", backendGeneration: 1 })
  vi.mocked(readNote).mockResolvedValue(note)
  vi.mocked(getNoteMetadata).mockResolvedValue({
    word_count: 1,
  })
  vi.mocked(getNoteProperties).mockResolvedValue({
    hasFrontmatter: false,
    properties: [],
    parseError: null,
    customProperties: [],
  })
  vi.mocked(readRecoveryDraft).mockResolvedValue(null)
  useNoteNoticesStore.setState(useNoteNoticesStore.getInitialState())
})
afterEach(cleanup)

describe("an unsaved draft found when a note is opened", () => {
  const draft = { content: "Draft after a crash", savedAt: 1, documentKind: "markdown" as const }

  it("opens the note as it is on disk and offers the draft in its notices, without a dialog", async () => {
    vi.mocked(readRecoveryDraft).mockResolvedValue(draft)
    const { result } = renderHook(() => useDocumentLoading(params()))
    await act(() => result.current.handleSelect("one"))
    expect(useDocStore.getState().openDocs.one.content).toBe("Body")
    expect(useNoteNoticesStore.getState().draftOffers.one).toBeTruthy()
    expect(useDocStore.getState().unsavedFileIds.has("one")).toBe(false)
    expect(discardRecoveryDraft).not.toHaveBeenCalled()
  })

  it("puts the draft into the note and queues a save when the person restores it", async () => {
    vi.mocked(readRecoveryDraft).mockResolvedValue(draft)
    const options = params()
    const enqueue = vi.spyOn(options.autosave, "enqueueImmediate")
    const { result } = renderHook(() => useDocumentLoading(options))
    await act(() => result.current.handleSelect("one"))
    act(() => useNoteNoticesStore.getState().draftOffers.one!.accept())
    expect(useDocStore.getState().openDocs.one.content).toBe("Draft after a crash")
    expect(useDocStore.getState().unsavedFileIds.has("one")).toBe(true)
    expect(useNoteNoticesStore.getState().draftOffers.one).toBeUndefined()
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "one" }),
      expect.objectContaining({ content: "Draft after a crash", expectedRevision: "r1" }),
    )
    expect(discardRecoveryDraft).not.toHaveBeenCalled()
  })

  it("drops the draft from the journal when the person declines it", async () => {
    vi.mocked(readRecoveryDraft).mockResolvedValue(draft)
    const { result } = renderHook(() => useDocumentLoading(params()))
    await act(() => result.current.handleSelect("one"))
    await act(async () => useNoteNoticesStore.getState().draftOffers.one!.reject())
    expect(useDocStore.getState().openDocs.one.content).toBe("Body")
    expect(useNoteNoticesStore.getState().draftOffers.one).toBeUndefined()
    expect(discardRecoveryDraft).toHaveBeenCalled()
  })
})

describe("item navigation", () => {
  it("uses one tab for notes, folders and Canvas, and retains an unsaved note buffer", async () => {
    const options = params()
    const { result } = renderHook(() => useDocumentLoading(options))
    await act(() => result.current.handleSelect("one"))
    const key = useTabsStore.getState().activeTabKey
    useDocStore.getState().patchDoc("one", { content: "Unsaved changes" })
    useDocStore.getState().markUnsaved("one")
    await act(() => result.current.handleSelect("folder"))
    expect(useTabsStore.getState().tabs[0].kind).toBe("folder")
    await act(() => result.current.handleSelect("canvas:/vault/Board.canvas"))
    expect(options.loadCanvas).toHaveBeenCalledWith("/vault/Board.canvas")
    expect(useTabsStore.getState().tabs[0].kind).toBe("canvas")
    await act(() => result.current.handleSelect("two"))
    expect(useTabsStore.getState().tabs).toHaveLength(1)
    expect(useTabsStore.getState().activeTabKey).toBe(key)
    expect(useTabsStore.getState().tabs[0].history).toEqual([
      "one",
      "folder",
      "/vault/Board.canvas",
      "two",
    ])
    await act(() => result.current.handleSelect("one"))
    expect(useDocStore.getState().openDocs.one.content).toBe("Unsaved changes")
    expect(useDocStore.getState().unsavedFileIds.has("one")).toBe(true)
  })

  it("opens a second Canvas only explicitly and activates the already open note", async () => {
    const { result } = renderHook(() => useDocumentLoading(params()))
    await act(() => result.current.handleSelect("one"))
    const firstKey = useTabsStore.getState().activeTabKey
    await act(() => result.current.handleOpenInNewTab("canvas:/vault/Board.canvas"))
    expect(useTabsStore.getState().tabs).toHaveLength(2)
    await act(() => result.current.handleSelect("one"))
    expect(useTabsStore.getState().activeTabKey).toBe(firstKey)
    expect(useTabsStore.getState().tabs).toHaveLength(2)
    await act(() => result.current.handleSelect("canvas:/vault/Board.canvas"))
    expect(useTabsStore.getState().tabs).toHaveLength(2)
    expect(
      useTabsStore.getState().tabs.find((tab) => tab.key === useTabsStore.getState().activeTabKey)
        ?.kind,
    ).toBe("canvas")
  })

  it("ignores a slow note load after a newer folder selection", async () => {
    let resolve!: (value: typeof note) => void
    vi.mocked(readNote).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const { result } = renderHook(() => useDocumentLoading(params()))
    let pending!: Promise<void>
    act(() => {
      pending = result.current.handleSelect("one")
    })
    await act(() => result.current.handleSelect("folder"))
    await act(async () => {
      resolve(note)
      await pending
    })
    expect(useTabsStore.getState().tabs).toHaveLength(1)
    expect(useTabsStore.getState().tabs[0]).toMatchObject({ kind: "folder", fileId: "folder" })
  })

  it("does not replace the active folder if loading a note fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const { result } = renderHook(() => useDocumentLoading(params()))
    await act(() => result.current.handleSelect("folder"))
    const tabs = useTabsStore.getState().tabs
    vi.mocked(readNote).mockRejectedValueOnce(new Error("read failed"))
    await act(() => result.current.handleSelect("one"))
    expect(useTabsStore.getState().tabs).toBe(tabs)
    error.mockRestore()
  })

  it("loads folder and Canvas history without reading them as Markdown notes", async () => {
    const options = params()
    const { result } = renderHook(() => useDocumentLoading(options))
    await act(() => result.current.navigateToFile("folder"))
    await act(() => result.current.navigateToFile("/vault/Board.canvas"))
    expect(readNote).not.toHaveBeenCalled()
    expect(options.loadCanvas).toHaveBeenCalledWith("/vault/Board.canvas")
    expect(useTabsStore.getState().tabs).toEqual([])
  })
})
