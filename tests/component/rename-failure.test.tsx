// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import * as storage from "@/lib/storage"
import { useDocumentMutations } from "@/components/workspace/file-actions/use-document-mutations"
import { useDocStore } from "@/components/workspace/use-doc-store"
import { useTabsStore } from "@/components/workspace/use-tabs-store"
import {
  AutosaveCoordinator,
  type AutosaveSnapshot,
} from "@/components/workspace/autosave/autosave-coordinator"
import type { MarkdownAutosavePayload } from "@/components/workspace/file-actions/types"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useDocStore.getState().clearDocs()
  useTabsStore.setState({ tabs: [], activeTabKey: "", secondaryTabKey: null })
})

it("keeps the original document, tab and pending autosave path after a rename collision", async () => {
  const key = { generation: 1, kind: "markdown" as const, documentId: "note" }
  const payload = {
    fileId: "note",
    path: "/vault/Original.md",
    content: "latest unsaved",
    backendGeneration: 1,
    expectedRevision: "r1",
  }
  const saved: AutosaveSnapshot<MarkdownAutosavePayload>[] = []
  const autosave = new AutosaveCoordinator<MarkdownAutosavePayload>({
    delayMs: 60000,
    save: async (snapshot) => {
      saved.push(snapshot)
    },
  })
  autosave.schedule(key, payload)
  const original = {
    id: "note",
    title: "Original",
    path: payload.path,
    content: payload.content,
    source: "original disk",
    created: "",
    modified: "",
    wordCount: 2,
  }
  useDocStore.getState().setDoc("note", original)
  useDocStore.getState().markUnsaved("note")
  useTabsStore.getState().openItem({ fileId: "note", title: "Original", kind: "document" })
  vi.spyOn(storage, "previewRenameRefactor").mockResolvedValue({
    replacements: 0,
    notes: 0,
  })
  vi.spyOn(storage, "renameItem").mockRejectedValue(new Error("Target already exists"))
  vi.spyOn(console, "error").mockImplementation(() => {})
  const apply = vi.fn()
  const refresh = vi.fn(async () => [])
  const { result } = renderHook(() =>
    useDocumentMutations({
      vault: "/vault",
      treeItems: [{ id: "note", path: payload.path, name: "Original", type: "file" }],
      backendGeneration: 1,
      refreshTree: refresh,
      autosave,
      autosaveKey: () => key,
      handleApplyMutation: apply,
      handleContentChange: vi.fn(),
      releaseUnusedDocumentBuffers: async () => {},
      handleSelect: async () => {},
    }),
  )
  try {
    await act(async () => result.current.handleRenameFile("note", "Taken"))
    expect(useDocStore.getState().openDocs.note).toEqual(original)
    expect(useDocStore.getState().unsavedFileIds.has("note")).toBe(true)
    expect(useTabsStore.getState().tabs[0].title).toBe("Original")
    expect(apply).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(autosave.inspect(key)?.dirty).toBe(true)
    await autosave.flush(key)
    expect(saved[0].value).toEqual(payload)
  } finally {
    autosave.discard(key)
  }
})
