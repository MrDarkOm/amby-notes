// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import {
  DatabaseOperationError,
  StorageOperationError,
  type FsMutationResult,
  type TreeItem,
  type UndoRecord,
} from "@/lib/storage"
import { useNoticeJournalStore } from "@/lib/notices/use-notice-journal-store"
import { confirm } from "@/lib/confirm"
import { useTreeMessageStore } from "../tree/use-tree-message-store"
import { useDatabaseStore } from "../database/database-store"
import { usePropertyMoveRetryStore } from "./property-move-retry-store"
import { useDocumentMutations } from "./use-document-mutations"
import { applyIconOverrides } from "../workspace-tree-utils"

const moveItem = vi.fn()
const renameItem = vi.fn()
const undoMutation = vi.fn()
const readNote = vi.fn()
const beginMerge = vi.fn()
const finishMerge = vi.fn()
const deleteItem = vi.fn()
const getNoteProperties = vi.fn()
const getDatabaseNoteContext = vi.fn()
const backupCustomProperties = vi.fn()

vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>()
  return {
    ...original,
    moveItem: (...args: unknown[]) => moveItem(...args),
    renameItem: (...args: unknown[]) => renameItem(...args),
    undoMutation: (...args: unknown[]) => undoMutation(...args),
    readNote: (...args: unknown[]) => readNote(...args),
    beginMerge: (...args: unknown[]) => beginMerge(...args),
    finishMerge: (...args: unknown[]) => finishMerge(...args),
    deleteItem: (...args: unknown[]) => deleteItem(...args),
    getNoteProperties: (...args: unknown[]) => getNoteProperties(...args),
    getDatabaseNoteContext: (...args: unknown[]) => getDatabaseNoteContext(...args),
    backupCustomProperties: (...args: unknown[]) => backupCustomProperties(...args),
  }
})
vi.mock("@/lib/confirm", () => ({ confirm: vi.fn() }))

const TREE: TreeItem[] = [
  {
    id: "/v/A",
    path: "/v/A",
    name: "A",
    type: "folder",
    children: [{ id: "n1", path: "/v/A/Идея.md", name: "Идея", type: "file" }],
  },
  { id: "/v/B", path: "/v/B", name: "B", type: "folder", children: [] },
]

function setup(tree: TreeItem[] = TREE) {
  const handleApplyMutation = vi.fn()
  const setTreeItems = vi.fn()
  const refreshTree = vi.fn().mockResolvedValue(tree)
  const hook = renderHook(() =>
    useDocumentMutations({
      vault: "/v",
      treeItems: tree,
      setTreeItems,
      refreshTree,
      backendGeneration: 1,
      autosave: {} as never,
      autosaveKey: (id: string) => id as never,
      handleApplyMutation,
      handleContentChange: vi.fn(),
      handleContentDirty: vi.fn(),
      recoveryScope: {} as never,
      releaseUnusedDocumentBuffers: vi.fn(),
      handleSelect: vi.fn().mockResolvedValue(undefined),
    }),
  )
  return { hook, handleApplyMutation, setTreeItems, refreshTree }
}

const MOVE_UNDO: UndoRecord = {
  kind: "move",
  sourcePath: "/v/A/Идея.md",
  targetPath: "/v/B",
  primaryPath: "/v/B/Идея.md",
  pathChanges: [{ oldPath: "/v/A/Идея.md", newPath: "/v/B/Идея.md" }],
  rewritten: [
    { path: "/v/Один.md", snapshotId: "S1", digest: "d1" },
    { path: "/v/Два.md", snapshotId: "S2", digest: "d2" },
  ],
}

const moved: FsMutationResult = {
  primaryId: "n1",
  primaryPath: "/v/B/Идея.md",
  pathChanges: [{ oldPath: "/v/A/Идея.md", newPath: "/v/B/Идея.md" }],
  deletedPaths: [],
}

describe("handleMoveItem reports how the move ended", () => {
  beforeEach(() => {
    moveItem.mockReset().mockResolvedValue(moved)
    getNoteProperties.mockReset().mockResolvedValue({ customProperties: [] })
    vi.mocked(confirm).mockReset().mockResolvedValue(true)
    useTreeMessageStore.getState().dismiss()
  })

  it("says 'moved' and applies the paths, so an open note stays open at its new place", async () => {
    const { hook, handleApplyMutation } = setup()
    let outcome: unknown
    await act(async () => {
      outcome = await hook.result.current.handleMoveItem(["n1"], "/v/B")
    })
    expect(outcome).toBe("moved")
    expect(moveItem).toHaveBeenCalledWith("/v", "/v/A/Идея.md", "/v/B")
    expect(handleApplyMutation).toHaveBeenCalledWith(
      expect.objectContaining({ pathChanges: moved.pathChanges }),
    )
  })

  it("says 'failed' when the operation fails, and says it under the tree without the raw error", async () => {
    await i18n.changeLanguage("ru")
    moveItem.mockRejectedValue(new Error("exists /secret/path"))
    const { hook } = setup()
    let outcome: unknown
    await act(async () => {
      outcome = await hook.result.current.handleMoveItem(["n1"], "/v/B")
    })
    expect(outcome).toBe("failed")
    const message = useTreeMessageStore.getState().message
    expect(message).not.toBeNull()
    expect(message?.level).toBe("warning")
    const text = i18n.t(message!.titleKey, message!.params)
    expect(text).toContain("Идея")
    expect(text).not.toContain("exists")
    expect(text).not.toContain("/secret")
  })

  it("says 'skipped' when nothing was done: an unknown target", async () => {
    const { hook } = setup()
    let outcome: unknown
    await act(async () => {
      outcome = await hook.result.current.handleMoveItem(["n1"], "/v/Нет")
    })
    expect(outcome).toBe("skipped")
    expect(moveItem).not.toHaveBeenCalled()
  })

  it("moves without a question when links are rewritten, and offers «Вернуть» under the tree and in the journal", async () => {
    await i18n.changeLanguage("ru")
    moveItem.mockResolvedValue({ ...moved, undo: MOVE_UNDO })
    const { hook } = setup()
    let outcome: unknown
    await act(async () => {
      outcome = await hook.result.current.handleMoveItem(["n1"], "/v/B")
    })
    expect(outcome).toBe("moved")
    expect(confirm).not.toHaveBeenCalled()
    const message = useTreeMessageStore.getState().message
    expect(message?.action?.labelKey).toBe("notices.journal.restore")
    expect(i18n.t(message!.lineKey!, message!.params)).toBe("Ссылки обновлены в 2 заметках.")
    const entry = useNoticeJournalStore.getState().entries[0]
    expect(entry.kind).toBe("movedWithLinks")
    expect(JSON.parse(entry.params.undo)).toEqual(MOVE_UNDO)
  })
})

describe("handleRenameFile reports how the rename ended", () => {
  beforeEach(() => {
    renameItem.mockReset().mockResolvedValue({ ...moved, primaryPath: "/v/A/Новое.md" })
    vi.mocked(confirm).mockReset().mockResolvedValue(true)
  })

  it("says 'renamed' when the file was renamed", async () => {
    const { hook } = setup()
    let outcome: unknown
    await act(async () => {
      outcome = await hook.result.current.handleRenameFile("n1", "Новое")
    })
    expect(outcome).toEqual({ status: "renamed" })
  })

  it("renames without a question when links are rewritten; «Вернуть» undoes it by the record", async () => {
    await i18n.changeLanguage("ru")
    const record: UndoRecord = {
      kind: "rename",
      originalPath: "/v/A/Идея.md",
      primaryPath: "/v/A/Новое.md",
      pathChanges: [{ oldPath: "/v/A/Идея.md", newPath: "/v/A/Новое.md" }],
      extraRenames: [],
      rewritten: [{ path: "/v/Ссылка.md", snapshotId: "S1", digest: "d1" }],
    }
    renameItem.mockResolvedValue({ ...moved, primaryPath: "/v/A/Новое.md", undo: record })
    const undone = {
      primaryPath: "/v/A/Идея.md",
      pathChanges: [{ oldPath: "/v/A/Новое.md", newPath: "/v/A/Идея.md" }],
      deletedPaths: [],
    }
    undoMutation.mockReset().mockResolvedValue(undone)
    const { hook, handleApplyMutation } = setup()
    await act(async () => {
      await hook.result.current.handleRenameFile("n1", "Новое")
    })
    expect(confirm).not.toHaveBeenCalled()
    const message = useTreeMessageStore.getState().message
    expect(i18n.t(message!.titleKey, message!.params)).toBe("Переименовано в «Новое»")
    await act(async () => {
      await message!.action!.run()
    })
    expect(undoMutation).toHaveBeenCalledWith(record)
    expect(handleApplyMutation).toHaveBeenLastCalledWith(undone)
    const entry = useNoticeJournalStore.getState().entries[0]
    expect(entry.kind).toBe("renamedWithLinks")
    expect(entry.params.restored).toBe("1")
  })

  it("says under the tree why «Вернуть» was refused, and leaves the entry undoable", async () => {
    await i18n.changeLanguage("ru")
    const record: UndoRecord = {
      kind: "rename",
      originalPath: "/v/A/Идея.md",
      primaryPath: "/v/A/Новое.md",
      pathChanges: [],
      extraRenames: [],
      rewritten: [{ path: "/v/Ссылка.md", snapshotId: "S1", digest: "d1" }],
    }
    renameItem.mockResolvedValue({ ...moved, primaryPath: "/v/A/Новое.md", undo: record })
    undoMutation
      .mockReset()
      .mockRejectedValue(new StorageOperationError("undoNoteChanged", "Changed since: /secret"))
    const { hook } = setup()
    await act(async () => {
      await hook.result.current.handleRenameFile("n1", "Новое")
    })
    await act(async () => {
      await useTreeMessageStore.getState().message!.action!.run()
    })
    const message = useTreeMessageStore.getState().message
    expect(message?.level).toBe("warning")
    expect(message?.lineKey).toBe("operationErrors.undoNoteChanged")
    expect(useNoticeJournalStore.getState().entries[0].params.restored).toBeUndefined()
  })

  it("gives the text for the name field when the name is taken, and never the raw error", async () => {
    await i18n.changeLanguage("ru")
    renameItem.mockRejectedValue(
      new StorageOperationError("alreadyExists", "File already exists: /secret/Новое.md"),
    )
    const { hook } = setup()
    let outcome: unknown
    await act(async () => {
      outcome = await hook.result.current.handleRenameFile("n1", "Новое")
    })
    expect(outcome).toEqual({ status: "failed", text: i18n.t("operationErrors.alreadyExists") })
    expect(JSON.stringify(outcome)).not.toContain("/secret")
  })

  it("gives the general text with a code for an error it does not know", async () => {
    await i18n.changeLanguage("ru")
    renameItem.mockRejectedValue(new Error("EIO /secret"))
    const { hook } = setup()
    let outcome: unknown
    await act(async () => {
      outcome = await hook.result.current.handleRenameFile("n1", "Новое")
    })
    expect(outcome).toEqual({
      status: "failed",
      text: i18n.t("operationErrors.general", { code: "unknown" }),
    })
  })
})

// The question "carry the properties over to the database?" after a note is moved into one. Whatever
// stops it from being asked is said under the tree with a way to ask again (docs/notices.md, sections 8, 12);
// the properties stay in the note, and nothing is written until the person answers.
describe("the offer to carry the properties of a moved note to the database", () => {
  const PROPERTIES = { customProperties: [{ id: "p1", name: "Статус", value: "в работе" }] }
  const CONTEXT = { databaseTitle: "Задачи", databaseId: "d1", row: { noteId: "n1" } }

  function mountedHarness() {
    const ref: { current: ReturnType<typeof useDocumentMutations> | null } = { current: null }
    function Harness() {
      const mutations = useDocumentMutations({
        vault: "/v",
        treeItems: TREE,
        setTreeItems: vi.fn(),
        refreshTree: vi.fn().mockResolvedValue(TREE),
        backendGeneration: 1,
        autosave: {} as never,
        autosaveKey: (id: string) => id as never,
        handleApplyMutation: vi.fn(),
        handleContentChange: vi.fn(),
        handleContentDirty: vi.fn(),
        recoveryScope: {} as never,
        releaseUnusedDocumentBuffers: vi.fn(),
        handleSelect: vi.fn().mockResolvedValue(undefined),
      } as never)
      ref.current = mutations
      return <>{mutations.propertyMigrationDialog}</>
    }
    render(<Harness />)
    return ref
  }
  const move = async (ref: ReturnType<typeof mountedHarness>) => {
    await act(async () => {
      await ref.current!.handleMoveItem(["n1"], "/v/B")
    })
  }
  // The move waits for the person's answer to the question, so it is started and answered, not awaited at once.
  const QUESTION = "Перенести свойства заметки?"
  const answer = async (started: Promise<unknown>, button: string) => {
    await waitFor(() => expect(screen.getByText(QUESTION)).toBeTruthy())
    await act(async () => {
      screen.getByText(button).click()
      await started
    })
  }

  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    moveItem.mockReset().mockResolvedValue(moved)
    getNoteProperties.mockReset().mockResolvedValue(PROPERTIES)
    getDatabaseNoteContext.mockReset().mockResolvedValue(CONTEXT)
    backupCustomProperties.mockReset().mockResolvedValue("backup")
    vi.mocked(confirm).mockReset().mockResolvedValue(true)
    useTreeMessageStore.getState().dismiss()
    usePropertyMoveRetryStore.getState().clearAll()
  })
  afterEach(cleanup)

  it("asks once the note is in the database, and writes nothing before the answer", async () => {
    const ref = mountedHarness()
    const started = ref.current!.handleMoveItem(["n1"], "/v/B")
    await waitFor(() => expect(screen.getByText(QUESTION)).toBeTruthy())
    expect(backupCustomProperties).not.toHaveBeenCalled()
    expect(useTreeMessageStore.getState().message).toBeNull()
    await answer(started, "Сохранить копию")
    expect(backupCustomProperties).toHaveBeenCalledWith("/v", "n1")
  })

  it("makes the open databases read their rows and fields again once the note is moved and answered", async () => {
    const before = useDatabaseStore.getState().invalidationSeq
    const ref = mountedHarness()
    const started = ref.current!.handleMoveItem(["n1"], "/v/B")
    await answer(started, "Сохранить копию")
    expect(useDatabaseStore.getState().invalidationSeq).toBeGreaterThan(before)
  })

  it("does the same when the note carries no properties: the database has a new row", async () => {
    getNoteProperties.mockResolvedValue({ customProperties: [], properties: [] })
    const before = useDatabaseStore.getState().invalidationSeq
    const ref = mountedHarness()
    await move(ref)
    expect(useDatabaseStore.getState().invalidationSeq).toBeGreaterThan(before)
  })

  it("does not ask, and says nothing, when the note is not in a database", async () => {
    getDatabaseNoteContext.mockResolvedValue(null)
    const ref = mountedHarness()
    await move(ref)
    expect(screen.queryByText("Перенести свойства заметки?")).toBeNull()
    expect(useTreeMessageStore.getState().message).toBeNull()
  })

  it("does not ask, and says nothing, when the Databases module is off", async () => {
    getDatabaseNoteContext.mockRejectedValue(new DatabaseOperationError("moduleDisabled", "off"))
    const ref = mountedHarness()
    await move(ref)
    expect(useTreeMessageStore.getState().message).toBeNull()
  })

  it("says it under the tree when the place in the database cannot be read, and leaves the properties in the note", async () => {
    getDatabaseNoteContext.mockRejectedValue(new Error("SQLITE_BUSY /secret"))
    const ref = mountedHarness()
    await move(ref)
    const message = useTreeMessageStore.getState().message
    expect(message?.level).toBe("warning")
    expect(i18n.t(message!.titleKey, message!.params)).toContain("Идея")
    expect(i18n.t(message!.titleKey, message!.params)).not.toContain("SQLITE")
    expect(message?.action?.labelKey).toBe("notices.tree.propertiesRetry")
    expect(screen.queryByText("Перенести свойства заметки?")).toBeNull()
    expect(backupCustomProperties).not.toHaveBeenCalled()
    // The same way back is open from the note itself.
    expect(usePropertyMoveRetryStore.getState().failed["n1"]).toBeDefined()
  })

  it("asks again after the retry, and the message and the note's card go once it is answered", async () => {
    getDatabaseNoteContext.mockRejectedValueOnce(new Error("busy"))
    const ref = mountedHarness()
    await move(ref)
    const retry = useTreeMessageStore.getState().message!.action!.run
    await answer(Promise.resolve(retry()), "Сохранить копию")
    expect(backupCustomProperties).toHaveBeenCalledWith("/v", "n1")
    expect(useTreeMessageStore.getState().message).toBeNull()
    expect(usePropertyMoveRetryStore.getState().failed["n1"]).toBeUndefined()
  })

  it("reads the properties again after the move when the first read failed", async () => {
    getNoteProperties.mockRejectedValueOnce(new Error("busy")).mockResolvedValue(PROPERTIES)
    const ref = mountedHarness()
    const started = ref.current!.handleMoveItem(["n1"], "/v/B")
    await answer(started, "Сохранить копию")
    expect(useTreeMessageStore.getState().message).toBeNull()
  })

  it("says it, with a way to retry, when the properties cannot be read at all", async () => {
    getNoteProperties.mockRejectedValue(new Error("busy"))
    const ref = mountedHarness()
    await move(ref)
    expect(useTreeMessageStore.getState().message?.action).toBeDefined()
    expect(backupCustomProperties).not.toHaveBeenCalled()
  })

  it("says it when the copy of the properties cannot be saved, instead of calling the move failed", async () => {
    backupCustomProperties.mockRejectedValue(new Error("disk"))
    const ref = mountedHarness()
    const started = ref.current!.handleMoveItem(["n1"], "/v/B")
    await answer(started, "Сохранить копию")
    const message = useTreeMessageStore.getState().message
    expect(message?.titleKey).toBe("notices.tree.propertiesKept")
    expect(message?.action).toBeDefined()
  })
})

describe("a move that does not happen puts back the raw tree, not the displayed one", () => {
  const RAW: TreeItem[] = [
    {
      id: "/v/A",
      path: "/v/A",
      name: "A",
      type: "folder",
      children: [{ id: "n1", path: "/v/A/Идея.md", name: "Идея", type: "file" }],
    },
    { id: "/v/B", path: "/v/B", name: "B", type: "folder", children: [] },
  ]

  // Like the vault data: the raw tree lives in a ref; the displayed one is computed from it.
  function setupWithRealTree() {
    const treeRef = { current: RAW }
    const setTreeItems = vi.fn((action: unknown) => {
      treeRef.current =
        typeof action === "function"
          ? (action as (current: TreeItem[]) => TreeItem[])(treeRef.current)
          : (action as TreeItem[])
    })
    const displayed = applyIconOverrides(RAW, { n1: "star" }, { "/v/A/Идея.md": "database" })
    const hook = renderHook(() =>
      useDocumentMutations({
        vault: "/v",
        treeItems: displayed,
        setTreeItems: setTreeItems as never,
        refreshTree: vi.fn().mockResolvedValue(RAW),
        backendGeneration: 1,
        autosave: {} as never,
        autosaveKey: (id: string) => id as never,
        handleApplyMutation: vi.fn(),
        handleContentChange: vi.fn(),
        handleContentDirty: vi.fn(),
        recoveryScope: {} as never,
        releaseUnusedDocumentBuffers: vi.fn(),
        handleSelect: vi.fn().mockResolvedValue(undefined),
      }),
    )
    return { hook, treeRef, displayed }
  }

  beforeEach(() => {
    moveItem.mockReset().mockResolvedValue(moved)
    getNoteProperties.mockReset().mockResolvedValue({ customProperties: [] })
    vi.mocked(confirm).mockReset().mockResolvedValue(true)
  })

  it("after a failed move the raw tree is the one it was", async () => {
    moveItem.mockRejectedValue(new Error("boom"))
    const { hook, treeRef } = setupWithRealTree()
    await act(async () => {
      await hook.result.current.handleMoveItem(["n1"], "/v/B")
    })
    expect(treeRef.current).toEqual(RAW)
  })
})

describe("handleMergeFile", () => {
  it("merges without a question: keeps the target's text first, archives the source, offers «Вернуть»", async () => {
    await i18n.changeLanguage("ru")
    const tree: TreeItem[] = [
      { id: "s", path: "/v/Черновик.md", name: "Черновик", type: "file" },
      { id: "t", path: "/v/Итог.md", name: "Итог", type: "file" },
    ]
    readNote.mockReset().mockImplementation(async (_vault: string, id: string) => ({
      content: id === "s" ? "из черновика" : "итог",
      revision: `r-${id}`,
    }))
    beginMerge.mockReset().mockResolvedValue("SNAP")
    const record: UndoRecord = {
      kind: "merge",
      target: { path: "/v/Итог.md", snapshotId: "SNAP", digest: "d" },
      sourcePath: "/v/Черновик.md",
      archiveId: "Черновик.md",
      sourceDigest: "s",
    }
    const archived = { pathChanges: [], deletedPaths: ["/v/Черновик.md"], undo: record }
    finishMerge.mockReset().mockResolvedValue(archived)
    deleteItem.mockReset()
    const autosave = { flush: vi.fn().mockResolvedValue(undefined), enqueueImmediate: vi.fn() }
    const handleApplyMutation = vi.fn()
    const hook = renderHook(() =>
      useDocumentMutations({
        vault: "/v",
        treeItems: tree,
        setTreeItems: vi.fn(),
        refreshTree: vi.fn().mockResolvedValue(tree),
        backendGeneration: 1,
        autosave: autosave as never,
        autosaveKey: (id: string) => id as never,
        handleApplyMutation,
        handleContentChange: vi.fn(),
        handleContentDirty: vi.fn(),
        recoveryScope: {} as never,
        releaseUnusedDocumentBuffers: vi.fn(),
        handleSelect: vi.fn().mockResolvedValue(undefined),
      }),
    )
    await act(async () => {
      await hook.result.current.handleMergeFile("s", "t")
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(beginMerge).toHaveBeenCalledWith("/v/Итог.md")
    expect(autosave.enqueueImmediate).toHaveBeenCalledWith(
      "t",
      expect.objectContaining({ content: "итог\n\nиз черновика" }),
    )
    expect(finishMerge).toHaveBeenCalledWith("/v", "/v/Черновик.md", "/v/Итог.md", "SNAP")
    expect(deleteItem).not.toHaveBeenCalled()
    expect(handleApplyMutation).toHaveBeenCalledWith(archived)
    const message = useTreeMessageStore.getState().message
    expect(i18n.t(message!.titleKey, message!.params)).toBe("Текст «Черновик» добавлен в «Итог»")
    expect(useNoticeJournalStore.getState().entries[0].kind).toBe("notesMerged")
  })
})

describe("a move of several items is undone with one «Вернуть»", () => {
  const TWO: TreeItem[] = [
    {
      id: "/v/A",
      path: "/v/A",
      name: "A",
      type: "folder",
      children: [
        { id: "n1", path: "/v/A/Идея.md", name: "Идея", type: "file" },
        { id: "n2", path: "/v/A/План.md", name: "План", type: "file" },
      ],
    },
    { id: "/v/B", path: "/v/B", name: "B", type: "folder", children: [] },
  ]
  const record = (name: string, rewritten: string[]): UndoRecord => ({
    kind: "move",
    sourcePath: `/v/A/${name}.md`,
    targetPath: "/v/B",
    primaryPath: `/v/B/${name}.md`,
    pathChanges: [{ oldPath: `/v/A/${name}.md`, newPath: `/v/B/${name}.md` }],
    rewritten: rewritten.map((path, index) => ({ path, snapshotId: `S${index}`, digest: "d" })),
  })
  const first = record("Идея", ["/v/Ссылки.md"])
  const second = record("План", ["/v/Ссылки.md", "/v/Ещё.md"])
  const result = (undo: UndoRecord): FsMutationResult => ({
    primaryPath: undo.kind === "move" ? undo.primaryPath : null,
    pathChanges: undo.kind === "move" ? undo.pathChanges : [],
    deletedPaths: [],
    undo,
  })

  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    moveItem.mockReset().mockResolvedValueOnce(result(first)).mockResolvedValueOnce(result(second))
    getNoteProperties.mockReset().mockResolvedValue({ customProperties: [] })
    undoMutation.mockReset().mockResolvedValue({ pathChanges: [], deletedPaths: [] })
    useTreeMessageStore.getState().dismiss()
    useNoticeJournalStore.getState().clear()
  })

  it("records one entry naming the items and every note whose links changed", async () => {
    const { hook } = setup(TWO)
    await act(async () => {
      await hook.result.current.handleMoveItem(["n1", "n2"], "/v/B")
    })
    const entries = useNoticeJournalStore.getState().entries
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe("movedManyWithLinks")
    expect(JSON.parse(entries[0].params.undo)).toEqual([first, second])
    const message = useTreeMessageStore.getState().message!
    expect(i18n.t(message.titleKey, message.params)).toBe("Перенесено выбранное (2) в «B»")
    expect(i18n.t(message.lineKey!, message.params)).toBe("Ссылки обновлены в 2 заметках.")
  })

  it("undoes the moves in reverse order and marks the entry done", async () => {
    const { hook } = setup(TWO)
    await act(async () => {
      await hook.result.current.handleMoveItem(["n1", "n2"], "/v/B")
    })
    await act(async () => {
      await useTreeMessageStore.getState().message!.action!.run()
    })
    expect(undoMutation.mock.calls.map(([undo]) => undo)).toEqual([second, first])
    expect(useNoticeJournalStore.getState().entries[0].params.restored).toBe("1")
  })

  it("says how much came back when one undo is refused, and keeps the rest undoable", async () => {
    undoMutation
      .mockReset()
      .mockResolvedValueOnce({ pathChanges: [], deletedPaths: [] })
      .mockRejectedValueOnce(new StorageOperationError("undoNoteChanged", "Changed since"))
    const { hook } = setup(TWO)
    await act(async () => {
      await hook.result.current.handleMoveItem(["n1", "n2"], "/v/B")
    })
    await act(async () => {
      await useTreeMessageStore.getState().message!.action!.run()
    })
    const message = useTreeMessageStore.getState().message!
    expect(i18n.t(message.lineKey!, message.params)).toBe(
      "Вернулось 1 из 2, остальное осталось на новом месте. Ничего не потеряно.",
    )
    const entry = useNoticeJournalStore.getState().entries[0]
    expect(entry.params.restored).toBeUndefined()
    expect(JSON.parse(entry.params.undo)).toEqual([first])
  })

  it("offers nothing when no links changed", async () => {
    moveItem
      .mockReset()
      .mockResolvedValueOnce(result(record("Идея", [])))
      .mockResolvedValueOnce(result(record("План", [])))
    const { hook } = setup(TWO)
    await act(async () => {
      await hook.result.current.handleMoveItem(["n1", "n2"], "/v/B")
    })
    expect(useNoticeJournalStore.getState().entries).toHaveLength(0)
    expect(useTreeMessageStore.getState().message).toBeNull()
  })
})
