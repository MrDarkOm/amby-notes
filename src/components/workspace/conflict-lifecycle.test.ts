import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useDocStore } from "./use-doc-store"
import { planMutation, applyTreePatch } from "./workspace-mutations"
import {
  saveRecoveryDraft,
  readRecoveryDraft,
  discardRecoveryDraft,
  remapRecoveryDraft,
} from "@/lib/recovery-drafts"
import {
  AutosaveCoordinator,
  type AutosaveKey,
  type AutosaveSnapshot,
} from "./autosave/autosave-coordinator"
import type { FsMutationResult } from "@/lib/storage"

const markdownKey = (documentId: string, generation = 1): AutosaveKey => ({
  generation,
  kind: "markdown",
  documentId,
})

interface MarkdownAutosavePayload {
  fileId: string
  path: string
  content: string
  backendGeneration: number | null
}

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
    clear: () => values.clear(),
  })
  useDocStore.setState({ openDocs: {}, unsavedFileIds: new Set(), externalConflicts: {} })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("Conflict lifecycle across filesystem mutations (WP-18)", () => {
  it("preserves conflict buffers and remaps conflict path on rename", async () => {
    const store = useDocStore.getState()
    store.setDoc("note-1", {
      id: "note-1",
      title: "Note",
      content: "local content modified",
      created: "today",
      modified: "today",
      wordCount: 3,
      path: "/vault/Note.md",
    })
    store.markUnsaved("note-1")
    store.setExternalConflict({
      fileId: "note-1",
      path: "/vault/Note.md",
      localContent: "local content modified",
      externalContent: "external edits from disk",
    })

    await saveRecoveryDraft("note-1", "local content modified", "markdown", "/vault/Note.md")

    const mutationResult: FsMutationResult = {
      primaryId: "note-1",
      primaryPath: "/vault/RenamedNote.md",
      pathChanges: [{ oldPath: "/vault/Note.md", newPath: "/vault/RenamedNote.md" }],
      deletedPaths: [],
      deletedIds: [],
    }

    const { deletedIds, remapFn } = planMutation(mutationResult)
    useDocStore.getState().applyMutation(deletedIds, remapFn)

    // Remap recovery draft pathHint
    await remapRecoveryDraft("note-1", "note-1", "markdown", "/vault/RenamedNote.md")

    const updatedConflict = useDocStore.getState().externalConflicts["note-1"]
    expect(updatedConflict).toBeDefined()
    expect(updatedConflict?.path).toBe("/vault/RenamedNote.md")
    expect(updatedConflict?.localContent).toBe("local content modified")
    expect(updatedConflict?.externalContent).toBe("external edits from disk")

    const updatedDoc = useDocStore.getState().openDocs["note-1"]
    expect(updatedDoc?.path).toBe("/vault/RenamedNote.md")

    const draft = await readRecoveryDraft("note-1")
    expect(draft?.content).toBe("local content modified")
    expect(draft?.pathHint).toBe("/vault/RenamedNote.md")
  })

  it("remaps conflict path and preserves buffers on folder move", async () => {
    const store = useDocStore.getState()
    store.setDoc("nested-1", {
      id: "nested-1",
      title: "Nested",
      content: "nested local",
      created: "today",
      modified: "today",
      wordCount: 2,
      path: "/vault/OldFolder/Nested.md",
    })
    store.markUnsaved("nested-1")
    store.setExternalConflict({
      fileId: "nested-1",
      path: "/vault/OldFolder/Nested.md",
      localContent: "nested local",
      externalContent: "nested external",
    })

    const mutationResult: FsMutationResult = {
      primaryPath: "/vault/Target/OldFolder",
      pathChanges: [
        { oldPath: "/vault/OldFolder/Nested.md", newPath: "/vault/Target/OldFolder/Nested.md" },
      ],
      deletedPaths: [],
      deletedIds: [],
    }

    const { deletedIds, remapFn } = planMutation(mutationResult)
    useDocStore.getState().applyMutation(deletedIds, remapFn)

    const updatedConflict = useDocStore.getState().externalConflicts["nested-1"]
    expect(updatedConflict?.path).toBe("/vault/Target/OldFolder/Nested.md")
    expect(updatedConflict?.localContent).toBe("nested local")
    expect(updatedConflict?.externalContent).toBe("nested external")
  })

  it("remaps autosave key payload when a note is renamed", async () => {
    const saves: AutosaveSnapshot<MarkdownAutosavePayload>[] = []
    const coordinator = new AutosaveCoordinator<MarkdownAutosavePayload>({
      delayMs: 100,
      save: async (snapshot) => {
        saves.push(snapshot)
      },
    })
    const key = markdownKey("note-1")

    coordinator.schedule(key, {
      fileId: "note-1",
      path: "/vault/Old.md",
      content: "my content",
      backendGeneration: 1,
    })

    // Remap payload path
    coordinator.remapKey(key, key, (payload) => ({
      ...payload,
      path: "/vault/New.md",
    }))

    await coordinator.flush(key)

    expect(saves).toHaveLength(1)
    expect(saves[0].value.path).toBe("/vault/New.md")
    expect(saves[0].value.content).toBe("my content")
  })

  it("handles conflict + delete with keep recovery vs discard vs cancel", async () => {
    const store = useDocStore.getState()
    store.setDoc("note-del", {
      id: "note-del",
      title: "Delete Me",
      content: "unsaved local version",
      created: "today",
      modified: "today",
      wordCount: 3,
      path: "/vault/DeleteMe.md",
    })
    store.markUnsaved("note-del")
    store.setExternalConflict({
      fileId: "note-del",
      path: "/vault/DeleteMe.md",
      localContent: "unsaved local version",
      externalContent: "external version",
    })

    await saveRecoveryDraft("note-del", "unsaved local version", "markdown", "/vault/DeleteMe.md")

    // Case 1: keep recovery
    const keepDraft = await readRecoveryDraft("note-del")
    expect(keepDraft?.content).toBe("unsaved local version")

    const delMutation: FsMutationResult = {
      pathChanges: [],
      deletedPaths: ["/vault/DeleteMe.md"],
      deletedIds: ["note-del"],
    }
    const { deletedIds, remapFn } = planMutation(delMutation)
    useDocStore.getState().applyMutation(deletedIds, remapFn)

    // In keep recovery, the recovery draft is not discarded
    expect(useDocStore.getState().openDocs["note-del"]).toBeUndefined()
    expect(useDocStore.getState().externalConflicts["note-del"]).toBeUndefined()
    expect(await readRecoveryDraft("note-del")).not.toBeNull()

    // Case 2: discard recovery
    await discardRecoveryDraft("note-del")
    expect(await readRecoveryDraft("note-del")).toBeNull()
  })

  it("pauses autosave on external delete and prevents recreation with pending timer", async () => {
    vi.useFakeTimers()
    const saveMock = vi.fn(async () => {})
    const coordinator = new AutosaveCoordinator<MarkdownAutosavePayload>({
      delayMs: 500,
      save: async (snapshot) => {
        if (useDocStore.getState().externalConflicts[snapshot.value.fileId]) {
          coordinator.pause(snapshot.key)
          return
        }
        await saveMock()
      },
    })
    const key = markdownKey("note-ext-del")

    const store = useDocStore.getState()
    store.setDoc("note-ext-del", {
      id: "note-ext-del",
      title: "ExtDel",
      content: "dirty edits before external delete",
      created: "today",
      modified: "today",
      wordCount: 5,
      path: "/vault/ExtDel.md",
    })
    store.markUnsaved("note-ext-del")

    // Schedule autosave with 500ms delay
    coordinator.schedule(key, {
      fileId: "note-ext-del",
      path: "/vault/ExtDel.md",
      content: "dirty edits before external delete",
      backendGeneration: 1,
    })

    // Advance 200ms (timer is pending)
    vi.advanceTimersByTime(200)
    expect(coordinator.inspect(key)?.scheduled).toBe(true)

    // External remove event arrives!
    store.setExternalConflict({
      fileId: "note-ext-del",
      path: "/vault/ExtDel.md",
      localContent: "dirty edits before external delete",
      externalContent: null,
    })
    coordinator.pause(key)

    // Timer completes after pause
    vi.advanceTimersByTime(500)
    await Promise.resolve()

    // Autosave did NOT write or recreate the file!
    expect(saveMock).not.toHaveBeenCalled()
    expect(coordinator.inspect(key)?.paused).toBe(true)

    // Discard resolution drops the pending autosave
    coordinator.discard(key)
    expect(coordinator.inspect(key)).toBeUndefined()
  })

  it("integrates restore from trash with tree and recovery draft access", async () => {
    await saveRecoveryDraft("note-trash", "recovered draft content", "markdown", "/vault/Note.md")

    const restoreMutation: FsMutationResult = {
      primaryId: "note-trash",
      primaryPath: "/vault/Note.md",
      pathChanges: [{ oldPath: "", newPath: "/vault/Note.md" }],
      deletedPaths: [],
      deletedIds: [],
    }

    const tree = applyTreePatch([], restoreMutation)
    expect(tree).toEqual([
      expect.objectContaining({
        id: "note-trash",
        path: "/vault/Note.md",
        name: "Note",
        type: "file",
      }),
    ])

    const draft = await readRecoveryDraft("note-trash")
    expect(draft?.content).toBe("recovered draft content")
  })
})
