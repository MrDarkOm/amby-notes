// @vitest-environment happy-dom
// Deleting files (docs/notices.md, sections 3 and 9): a permanent deletion is asked in the application every
// time and "Cancel" deletes nothing; a failure of the move to the system bin is said under the tree, with the
// numbers and without the text of the error, which goes to the log.
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { confirm } from "@/lib/confirm"
import type { FsMutationResult, TreeItem } from "@/lib/storage"
import { useDocumentCrud } from "./use-document-crud"
import { DEFAULT_PREFS } from "../app-config"
import { useSettingsStore } from "../use-settings-store"
import { useVaultStore } from "../use-vault-store"
import { useTreeMessageStore } from "../tree/use-tree-message-store"

const deleteItem = vi.fn()

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  deleteItem: (...args: unknown[]) => deleteItem(...args),
}))
vi.mock("@/lib/confirm", () => ({ confirm: vi.fn() }))

const TREE: TreeItem[] = [
  { id: "n1", path: "/v/План.md", name: "План", type: "file" },
  { id: "n2", path: "/v/Идея.md", name: "Идея", type: "file" },
]
const deleted: FsMutationResult = {
  primaryId: null,
  primaryPath: null,
  pathChanges: [],
  deletedPaths: ["/v/План.md"],
}

function setup() {
  return renderHook(() =>
    useDocumentCrud({
      vault: "/v",
      treeItems: TREE,
      setTreeItems: vi.fn(),
      refreshTreePaths: vi.fn().mockResolvedValue(TREE),
      setOpenCanvases: vi.fn(),
      setOpenSketches: vi.fn(),
      setPendingRenameId: vi.fn(),
      autosave: { discard: vi.fn() } as never,
      autosaveKey: (id: string) => id as never,
      handleApplyMutation: vi.fn().mockReturnValue(true),
      handleContentChange: vi.fn(),
      handleContentDirty: vi.fn(),
      loadDoc: vi.fn(),
      releaseUnusedDocumentBuffers: vi.fn().mockResolvedValue(undefined),
      recoveryScope: { vault: "/v", generation: 1 } as never,
    }),
  )
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  deleteItem.mockReset().mockResolvedValue(deleted)
  vi.mocked(confirm).mockReset().mockResolvedValue(true)
  useVaultStore.setState({ vault: "/v", switching: false })
  useSettingsStore.setState({
    prefs: { ...DEFAULT_PREFS, files: { ...DEFAULT_PREFS.files, deleteMode: "permanent" } },
  })
  useTreeMessageStore.getState().dismiss()
})
afterEach(cleanup)

describe("permanent deletion", () => {
  it("asks in the application, says it cannot be undone, and deletes nothing on Cancel", async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    const { result } = setup()
    await act(() => result.current.handleDeleteFiles(["n1"]))
    expect(confirm).toHaveBeenCalledTimes(1)
    const question = vi.mocked(confirm).mock.calls[0][0]
    expect(question.destructive).toBe(true)
    expect(question.title).toContain("План")
    expect(deleteItem).not.toHaveBeenCalled()
  })

  it("deletes after yes", async () => {
    const { result } = setup()
    await act(() => result.current.handleDeleteFiles(["n1"]))
    expect(deleteItem).toHaveBeenCalledWith("/v", "/v/План.md", "permanent")
  })

  it("asks once for several files and puts the number in the question", async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    const { result } = setup()
    await act(() => result.current.handleDeleteFiles(["n1", "n2"]))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(vi.mocked(confirm).mock.calls[0][0].title).toContain("2")
  })
})

describe("a failed deletion", () => {
  it("is told under the tree with the numbers, and the text of the error stays out", async () => {
    deleteItem.mockRejectedValue(new Error("EACCES /Users/me/secret"))
    const { result } = setup()
    await act(() => result.current.handleDeleteFiles(["n1", "n2"]))
    const message = useTreeMessageStore.getState().message
    expect(message).not.toBeNull()
    expect(message?.level).toBe("warning")
    const text = i18n.t(message!.titleKey, message!.params)
    expect(text).toContain("2")
    expect(JSON.stringify(message)).not.toContain("EACCES")
    expect(JSON.stringify(message)).not.toContain("secret")
  })

  it("is silent when everything was deleted", async () => {
    const { result } = setup()
    await act(() => result.current.handleDeleteFiles(["n1"]))
    expect(useTreeMessageStore.getState().message).toBeNull()
  })
})
