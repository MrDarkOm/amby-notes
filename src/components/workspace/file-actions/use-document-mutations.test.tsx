// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { FsMutationResult, TreeItem } from "@/lib/storage"
import { confirm } from "@/lib/confirm"
import { useTreeMessageStore } from "../tree/use-tree-message-store"
import { useDocumentMutations } from "./use-document-mutations"

const moveItem = vi.fn()
const previewMoveRefactor = vi.fn()
const getNoteProperties = vi.fn()

vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>()
  return {
    ...original,
    moveItem: (...args: unknown[]) => moveItem(...args),
    previewMoveRefactor: (...args: unknown[]) => previewMoveRefactor(...args),
    getNoteProperties: (...args: unknown[]) => getNoteProperties(...args),
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
