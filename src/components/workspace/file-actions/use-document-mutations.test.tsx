// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import {
  DatabaseOperationError,
  StorageOperationError,
  type FsMutationResult,
  type TreeItem,
} from "@/lib/storage"
import { confirm } from "@/lib/confirm"
import { useTreeMessageStore } from "../tree/use-tree-message-store"
import { useDatabaseStore } from "../database/database-store"
import { usePropertyMoveRetryStore } from "./property-move-retry-store"
import { useDocumentMutations } from "./use-document-mutations"

const moveItem = vi.fn()
const renameItem = vi.fn()
const previewRenameRefactor = vi.fn()
const previewMoveRefactor = vi.fn()
const getNoteProperties = vi.fn()
const getDatabaseNoteContext = vi.fn()
const backupCustomProperties = vi.fn()

vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>()
  return {
    ...original,
    moveItem: (...args: unknown[]) => moveItem(...args),
    renameItem: (...args: unknown[]) => renameItem(...args),
    previewRenameRefactor: (...args: unknown[]) => previewRenameRefactor(...args),
    previewMoveRefactor: (...args: unknown[]) => previewMoveRefactor(...args),
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

function setup() {
  const handleApplyMutation = vi.fn()
  const setTreeItems = vi.fn()
  const refreshTree = vi.fn().mockResolvedValue(TREE)
  const hook = renderHook(() =>
    useDocumentMutations({
      vault: "/v",
      treeItems: TREE,
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

const moved: FsMutationResult = {
  primaryId: "n1",
  primaryPath: "/v/B/Идея.md",
  pathChanges: [{ oldPath: "/v/A/Идея.md", newPath: "/v/B/Идея.md" }],
  deletedPaths: [],
}

describe("handleMoveItem reports how the move ended", () => {
  beforeEach(() => {
    moveItem.mockReset().mockResolvedValue(moved)
    previewMoveRefactor.mockReset().mockResolvedValue({ replacements: 0, notes: 0 })
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

  it("says 'skipped' when nothing was done: an unknown target, or the link rewrite declined", async () => {
    const { hook } = setup()
    let outcome: unknown
    await act(async () => {
      outcome = await hook.result.current.handleMoveItem(["n1"], "/v/Нет")
    })
    expect(outcome).toBe("skipped")

    previewMoveRefactor.mockResolvedValue({ replacements: 2, notes: 1 })
    vi.mocked(confirm).mockResolvedValue(false)
    await act(async () => {
      outcome = await hook.result.current.handleMoveItem(["n1"], "/v/B")
    })
    expect(outcome).toBe("skipped")
    expect(moveItem).not.toHaveBeenCalled()
    // The question names the number of links and the verb; it is an ordinary question, not a dangerous one.
    const question = vi.mocked(confirm).mock.calls[0][0]
    expect(question.description).toContain("2")
    expect(question.destructive).toBeFalsy()
    expect(question.confirmLabel).toBe("Переместить")
  })

  it("moves after 'yes' to the link rewrite", async () => {
    previewMoveRefactor.mockResolvedValue({ replacements: 2, notes: 1 })
    vi.mocked(confirm).mockResolvedValue(true)
    const { hook } = setup()
    let outcome: unknown
    await act(async () => {
      outcome = await hook.result.current.handleMoveItem(["n1"], "/v/B")
    })
    expect(outcome).toBe("moved")
    expect(moveItem).toHaveBeenCalled()
  })
})

describe("handleRenameFile reports how the rename ended", () => {
  beforeEach(() => {
    renameItem.mockReset().mockResolvedValue({ ...moved, primaryPath: "/v/A/Новое.md" })
    previewRenameRefactor.mockReset().mockResolvedValue({ replacements: 0, notes: 0 })
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

  it("says 'skipped' when the person declined the link rewrite", async () => {
    previewRenameRefactor.mockResolvedValue({ replacements: 2, notes: 1 })
    vi.mocked(confirm).mockResolvedValue(false)
    const { hook } = setup()
    let outcome: unknown
    await act(async () => {
      outcome = await hook.result.current.handleRenameFile("n1", "Новое")
    })
    expect(outcome).toEqual({ status: "skipped" })
    expect(renameItem).not.toHaveBeenCalled()
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
    previewMoveRefactor.mockReset().mockResolvedValue({ replacements: 0, notes: 0 })
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
