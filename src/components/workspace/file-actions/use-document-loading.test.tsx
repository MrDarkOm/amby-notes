// @vitest-environment happy-dom
// The note layer of a canvas, sketch or other container (SAVE-09): its ID and revision come from the
// backend, never from a pattern over the file text, and without them the layer stays read only.
import { cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TreeItem } from "@/lib/storage"
import { noteEditingPolicy } from "../editor/note-editing-policy"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { useDocumentLoading } from "./use-document-loading"

const readFile = vi.fn()
const readNote = vi.fn()

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  readFile: (...args: unknown[]) => readFile(...args),
  readNote: (...args: unknown[]) => readNote(...args),
}))

// The text of the layer as the person wrote it: a body line that looks like an ID.
const LAYER_SOURCE = "---\ntitle: Доска\n---\nid: другой-id\nТекст\n"
const FILE_ID = "canvas:/v/Доска/Доска.canvas"

const canvasItem: TreeItem = {
  id: FILE_ID,
  path: "/v/Доска/Доска.canvas",
  name: "Доска",
  type: "canvas",
}
const withLayer: TreeItem[] = [
  { id: "real-note-id", path: "/v/Доска/Доска.md", name: "Доска", type: "file" },
  canvasItem,
]
const withoutLayer: TreeItem[] = [canvasItem]

function setup(treeItems: TreeItem[]) {
  return renderHook(() =>
    useDocumentLoading({
      vault: "/v",
      treeItems,
      loadCanvas: vi.fn().mockResolvedValue(undefined),
      loadSketch: vi.fn().mockResolvedValue(undefined),
      setPendingRenameId: vi.fn(),
      backendGeneration: 1,
      windowLabel: "main",
      autosave: { enqueueImmediate: vi.fn() } as never,
      autosaveKey: (id: string) => id as never,
      handleApplyMutation: vi.fn().mockReturnValue(true),
      handleContentChange: vi.fn(),
      handleContentDirty: vi.fn(),
      releaseUnusedDocumentBuffers: vi.fn().mockResolvedValue(undefined),
      recoveryScope: { vault: "/v", generation: 1 } as never,
    }),
  )
}

beforeEach(() => {
  useDocStore.getState().clearDocs()
  useVaultStore.setState({ vault: "/v", backendGeneration: 1 })
  readFile.mockReset().mockResolvedValue(LAYER_SOURCE)
  readNote.mockReset().mockImplementation(async (_vault: string, id: string) => {
    if (id !== "real-note-id") throw new Error(`Note not found: ${id}`)
    return { content: "Текст\n", revision: "backend-revision", source: LAYER_SOURCE }
  })
})
afterEach(cleanup)

describe("note layer of a container", () => {
  it("takes the ID from the backend, not from an `id:` line of the text", async () => {
    const { result } = setup(withLayer)
    const doc = await result.current.loadDoc(FILE_ID, "Доска")
    expect(doc.noteId).toBe("real-note-id")
    expect(readNote).toHaveBeenCalledWith("/v", "real-note-id")
    expect(readNote).not.toHaveBeenCalledWith("/v", "другой-id")
  })

  it("keeps the revision the backend returned", async () => {
    const { result } = setup(withLayer)
    const doc = await result.current.loadDoc(FILE_ID, "Доска")
    expect(doc.revision).toBe("backend-revision")
    expect(noteEditingPolicy(doc.noteProperties).readOnly).toBe(false)
  })

  it("stays read only, with no made-up revision, when the backend does not answer", async () => {
    readNote.mockRejectedValue(new Error("not indexed"))
    const { result } = setup(withLayer)
    const doc = await result.current.loadDoc(FILE_ID, "Доска")
    expect(doc.revision ?? "").toBe("")
    expect(doc.noteId).toBeUndefined()
    expect(noteEditingPolicy(doc.noteProperties).readOnly).toBe(true)
  })

  it("stays read only when the backend tree does not know the layer yet", async () => {
    const { result } = setup(withoutLayer)
    const doc = await result.current.loadDoc(FILE_ID, "Доска")
    expect(readNote).not.toHaveBeenCalled()
    expect(doc.revision ?? "").toBe("")
    expect(doc.noteId).toBeUndefined()
    expect(noteEditingPolicy(doc.noteProperties).readOnly).toBe(true)
  })
})
