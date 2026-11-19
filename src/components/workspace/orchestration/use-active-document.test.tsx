// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import "@/lib/i18n"
import { useDocStore, type Document } from "../use-doc-store"
import type { Tab } from "../use-tabs-store"
import { useViewStateStore } from "../use-view-state-store"
import { useActiveDocument } from "./use-active-document"

const NO_TREE = new Map()

function tab(fileId: string, kind: Tab["kind"] = "document"): Tab {
  return { key: `tab-${fileId}`, kind, fileId, title: fileId, history: [fileId], historyIndex: 0 }
}

function doc(id: string, content = "a"): Document {
  return {
    id,
    title: id,
    content,
    created: "",
    modified: "",
    wordCount: 0,
    path: `/vault/${id}.md`,
    source: content,
  }
}

describe("useActiveDocument", () => {
  beforeEach(() => {
    useDocStore.getState().clearDocs()
  })
  afterEach(() => {
    cleanup()
    useDocStore.getState().clearDocs()
  })

  it("has no document without a tab", () => {
    const { result } = renderHook(() => useActiveDocument(null, NO_TREE))
    expect(result.current.currentDoc).toBeNull()
    expect(result.current.currentDocId).toBeNull()
    expect(result.current.currentDocDefaultLayer).toBe("editor")
  })

  it("follows the active tab when it switches", () => {
    useDocStore.getState().setDoc("a", doc("a"))
    useDocStore.getState().setDoc("b", doc("b"))
    const { result, rerender } = renderHook(({ active }) => useActiveDocument(active, NO_TREE), {
      initialProps: { active: tab("a") },
    })
    expect(result.current.currentDocId).toBe("a")
    expect(result.current.currentDocPath).toBe("/vault/a.md")
    rerender({ active: tab("b") })
    expect(result.current.currentDocId).toBe("b")
  })

  it("picks the note up once it is read, without a render per keystroke", () => {
    let renders = 0
    const active = tab("late")
    const { result } = renderHook(() => {
      renders += 1
      return useActiveDocument(active, NO_TREE)
    })
    expect(result.current.currentDoc).toBeNull()
    act(() => useDocStore.getState().setDoc("late", doc("late")))
    expect(result.current.currentDocId).toBe("late")
    const before = renders
    for (const content of ["ab", "abc", "abcd"]) {
      act(() => useDocStore.getState().patchDoc("late", { content }))
    }
    act(() => useDocStore.getState().markUnsaved("late"))
    act(() => useDocStore.getState().markSaved("late"))
    expect(renders).toBe(before)
  })

  it("seeds a placeholder buffer for a canvas page", () => {
    useViewStateStore.setState({ activeLayers: {}, primaryLayers: {} })
    const { result } = renderHook(() => useActiveDocument(tab("board.canvas", "canvas"), NO_TREE))
    expect(result.current.currentDoc?.id).toBe("board.canvas")
    expect(result.current.currentDocDefaultLayer).toBe("canvas")
    expect(useDocStore.getState().openDocs["board.canvas"]).toBeDefined()
  })
})
