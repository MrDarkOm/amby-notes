import { beforeEach, describe, expect, it, vi } from "vitest"
import { logger } from "@/lib/logger"
import { readNote } from "@/lib/storage"
import { registerAutosaveLifecycle } from "./autosave/autosave-lifecycle"
import { reloadOpenNotes } from "./reload-open-notes"
import { useDocStore, type Document } from "./use-doc-store"
import { useVaultStore } from "./use-vault-store"

vi.mock("@/lib/storage", () => ({ readNote: vi.fn() }))
vi.mock("@/lib/logger", async (original) => ({
  ...(await original<typeof import("@/lib/logger")>()),
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

type Note = Awaited<ReturnType<typeof readNote>>

function doc(id: string, content: string, extra: Partial<Document> = {}): Document {
  return {
    id,
    title: id,
    content,
    created: "",
    modified: "",
    wordCount: 1,
    path: `/vault/${id}.md`,
    source: content,
    revision: `${id}-rev1`,
    ...extra,
  }
}

function disk(id: string, content: string): Note {
  return { content, revision: `${id}-rev2`, source: content } as unknown as Note
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe("reloadOpenNotes (SAVE-06)", () => {
  beforeEach(() => {
    vi.mocked(readNote).mockReset()
    vi.mocked(logger.warn).mockReset()
    useVaultStore.setState({ generation: 1 })
    useDocStore.setState({
      openDocs: {},
      unsavedFileIds: new Set(),
      externalConflicts: {},
      activeConflictDialogFileId: null,
    })
  })

  it("replaces a clean buffer with the text on disk", async () => {
    useDocStore.getState().setDoc("a", doc("a", "old"))
    vi.mocked(readNote).mockResolvedValue(disk("a", "new"))

    await reloadOpenNotes("/vault")

    expect(useDocStore.getState().openDocs.a?.content).toBe("new")
    expect(useDocStore.getState().externalConflicts).toEqual({})
  })

  it("does not replace a note the user began editing while another was being read", async () => {
    useDocStore.getState().setDoc("a", doc("a", "a-old"))
    useDocStore.getState().setDoc("b", doc("b", "b-old"))
    const firstRead = deferred<Note>()
    vi.mocked(readNote).mockImplementation((_vault, id) =>
      id === "a" ? firstRead.promise : Promise.resolve(disk("b", "b-disk")),
    )

    const running = reloadOpenNotes("/vault")
    // The user types in B while A is still being read.
    useDocStore.getState().patchDoc("b", { content: "b-typed" })
    useDocStore.getState().markUnsaved("b")
    firstRead.resolve(disk("a", "a-disk"))
    await running

    expect(useDocStore.getState().openDocs.a?.content).toBe("a-disk")
    expect(useDocStore.getState().openDocs.b?.content).toBe("b-typed")
    expect(useDocStore.getState().unsavedFileIds.has("b")).toBe(true)
    expect(useDocStore.getState().externalConflicts.b?.externalContent).toBe("b-disk")
  })

  it("does not replace a note edited while its own read was in flight", async () => {
    useDocStore.getState().setDoc("a", doc("a", "a-old"))
    const read = deferred<Note>()
    vi.mocked(readNote).mockReturnValue(read.promise)

    const running = reloadOpenNotes("/vault")
    useDocStore.getState().patchDoc("a", { content: "a-typed" })
    useDocStore.getState().markUnsaved("a")
    read.resolve(disk("a", "a-disk"))
    await running

    expect(useDocStore.getState().openDocs.a?.content).toBe("a-typed")
    expect(useDocStore.getState().externalConflicts.a?.externalContent).toBe("a-disk")
  })

  it("treats a queued autosave as unsaved even when the store flag is clean", async () => {
    useDocStore.getState().setDoc("a", doc("a", "a-old"))
    const dispose = registerAutosaveLifecycle({
      generation: 1,
      flush: async () => {},
      cancel: () => {},
      hasDirtyBuffers: () => true,
      inspect: () => [
        {
          key: { generation: 1, kind: "markdown", documentId: "a" },
          dirty: true,
          scheduled: true,
          inFlight: false,
          paused: false,
        } as never,
      ],
    })
    vi.mocked(readNote).mockResolvedValue(disk("a", "a-disk"))

    await reloadOpenNotes("/vault")
    dispose()

    expect(useDocStore.getState().openDocs.a?.content).toBe("a-old")
    expect(useDocStore.getState().externalConflicts.a?.externalContent).toBe("a-disk")
  })

  it("reads a container layer by its noteId, not by the buffer id", async () => {
    useDocStore.getState().setDoc("layer-id", doc("layer-id", "old", { noteId: "note-id" }))
    vi.mocked(readNote).mockResolvedValue(disk("layer-id", "new"))

    await reloadOpenNotes("/vault")

    expect(readNote).toHaveBeenCalledWith("/vault", "note-id")
    expect(useDocStore.getState().openDocs["layer-id"]?.content).toBe("new")
  })

  it("logs a failed read with an event code and keeps the buffer", async () => {
    useDocStore.getState().setDoc("a", doc("a", "old"))
    vi.mocked(readNote).mockRejectedValue(new Error("boom"))

    await reloadOpenNotes("/vault")

    expect(logger.warn).toHaveBeenCalledWith(
      "refresh_vault.open_document_reload_failed",
      expect.any(Object),
    )
    expect(useDocStore.getState().openDocs.a?.content).toBe("old")
  })
})
