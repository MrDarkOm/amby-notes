import type { Editor } from "@tiptap/core"
import { EditorState } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import { describe, expect, it } from "vitest"

import { setAssetContext } from "./asset-resolver"
import { editorSchema } from "./schema"
import { docToMarkdown, markdownToDoc } from "./markdown"
import { sameDocument } from "./markdown-block-source"
import {
  getImportContextForView,
  getTauriDropPosForView,
  importImageFromClipboard,
  importDroppedPaths,
  insertImportedAssets,
  tauriDropClientPosition,
} from "./media-drop"

describe("media insertion context", () => {
  it("reads the Tiptap editor from the ProseMirror DOM element", () => {
    const editor = {} as Editor
    setAssetContext(editor, { vaultPath: "/vault", notePath: "/vault/note.md" })
    const view = { dom: { editor } } as unknown as EditorView

    expect(getImportContextForView(view)).toEqual({
      vaultPath: "/vault",
      notePath: "/vault/note.md",
    })
  })

  it("does not request clipboard access outside Tauri", async () => {
    await expect(
      importImageFromClipboard({ vaultPath: "/vault", notePath: "/vault/note.md" }),
    ).resolves.toBeNull()
  })

  it("inserts completed mixed media as separate blocks in one transaction", () => {
    let state = EditorState.create({
      schema: editorSchema,
      doc: editorSchema.node("doc", null, [
        editorSchema.node("paragraph", null, editorSchema.text("beforeafter")),
      ]),
    })
    let dispatches = 0
    const view = {
      get state() {
        return state
      },
      dispatch(tr: typeof state.tr) {
        state = state.apply(tr)
        dispatches++
      },
    } as unknown as EditorView
    expect(
      insertImportedAssets(view, 7, [
        { relPath: "assets/photo.png", fileName: "photo.png", kind: "image", absPath: "" },
        { relPath: "assets/notes.zip", fileName: "notes.zip", kind: "file", absPath: "" },
        { relPath: "assets/diagram.webp", fileName: "diagram.webp", kind: "image", absPath: "" },
      ]),
    ).toBe(true)
    expect(dispatches).toBe(1)
    expect(
      state.doc.children.map((block) => block.textContent || block.firstChild?.attrs.src),
    ).toEqual(["before", "assets/photo.png", "notes.zip", "assets/diagram.webp", "after"])
    expect(state.doc.child(2).firstChild?.marks[0]?.attrs.href).toBe("assets/notes.zip")
    state.doc.check()
    const reopened = editorSchema.nodeFromJSON(markdownToDoc(docToMarkdown(state.doc)))
    expect(sameDocument(state.doc, reopened)).toBe(true)
  })

  it("inserts audio, PDF and images as separate named media blocks", () => {
    let state = EditorState.create({ schema: editorSchema })
    const view = {
      get state() {
        return state
      },
      dispatch(tr: typeof state.tr) {
        state = state.apply(tr)
      },
    } as unknown as EditorView
    insertImportedAssets(view, 1, [
      { relPath: "assets/song.mp3", fileName: "song.mp3", kind: "file", absPath: "" },
      { relPath: "assets/report.pdf", fileName: "report.pdf", kind: "file", absPath: "" },
      { relPath: "assets/photo.png", fileName: "photo.png", kind: "image", absPath: "" },
    ])
    expect(
      state.doc.children.map((block) => ({
        src: block.firstChild?.attrs.src,
        alt: block.firstChild?.attrs.alt,
      })),
    ).toEqual([
      { src: "assets/song.mp3", alt: "song.mp3" },
      { src: "assets/report.pdf", alt: "report.pdf" },
      { src: "assets/photo.png", alt: null },
    ])
    state.doc.check()
  })

  it("does not dispatch an imported batch after its session is aborted", () => {
    const controller = new AbortController()
    controller.abort()
    const dispatch = () => {
      throw new Error("must not dispatch")
    }
    const view = {
      state: {
        doc: {
          content: { size: 1 },
          resolve: () => ({ parent: { inlineContent: true } }),
        },
        tr: {},
        schema: { nodes: {}, marks: {} },
      },
      dispatch,
    } as unknown as EditorView

    expect(
      insertImportedAssets(
        view,
        0,
        [{ relPath: "assets/photo.png", fileName: "photo.png", kind: "image", absPath: "" }],
        controller.signal,
      ),
    ).toBe(false)
  })

  it("moves a document-boundary drop into the nearest text block", () => {
    let state = EditorState.create({
      schema: editorSchema,
      doc: editorSchema.node("doc", null, [
        editorSchema.node("paragraph", null, [editorSchema.text("before")]),
      ]),
    })
    const view = {
      get state() {
        return state
      },
      dispatch(transaction: typeof state.tr) {
        state = state.apply(transaction)
      },
    } as unknown as EditorView

    expect(
      insertImportedAssets(view, state.doc.content.size, [
        {
          relPath: "assets/notes.zip",
          fileName: "notes.zip",
          kind: "file",
          absPath: "",
        },
      ]),
    ).toBe(true)
    expect(state.doc.textContent).toBe("beforenotes.zip")
    expect(state.doc.firstChild?.lastChild?.marks[0]?.attrs.href).toBe("assets/notes.zip")
  })

  it("inserts an ordered mixed batch at the document boundary", () => {
    let state = EditorState.create({
      schema: editorSchema,
      doc: editorSchema.node("doc", null, [
        editorSchema.node("paragraph", null, [editorSchema.text("before")]),
      ]),
    })
    const view = {
      get state() {
        return state
      },
      dispatch(transaction: typeof state.tr) {
        state = state.apply(transaction)
      },
    } as unknown as EditorView

    expect(
      insertImportedAssets(view, state.doc.content.size, [
        { relPath: "assets/a.md", fileName: "a.md", kind: "file", absPath: "" },
        { relPath: "assets/b.png", fileName: "b.png", kind: "image", absPath: "" },
        { relPath: "assets/c.png", fileName: "c.png", kind: "image", absPath: "" },
      ]),
    ).toBe(true)
    expect(state.doc.textContent).toBe("beforea.md")
    expect(state.doc.childCount).toBe(3)
    expect(state.doc.child(1).firstChild?.attrs.src).toBe("assets/b.png")
    expect(state.doc.child(2).firstChild?.attrs.src).toBe("assets/c.png")
  })

  it("keeps successful dropped imports ordered when one source fails", async () => {
    const importer = async (_vault: string, _note: string, source: string) => {
      if (source === "bad") throw new Error("unreadable")
      return {
        relPath: `assets/${source}`,
        fileName: source,
        kind: "file" as const,
        absPath: "",
      }
    }

    await expect(
      importDroppedPaths(
        { vaultPath: "/vault", notePath: "/vault/note.md" },
        ["first", "bad", "third"],
        undefined,
        importer,
      ),
    ).resolves.toEqual([
      { relPath: "assets/first", fileName: "first", kind: "file", absPath: "" },
      { relPath: "assets/third", fileName: "third", kind: "file", absPath: "" },
    ])
  })

  it("normalizes Tauri drop coordinates only on Windows", () => {
    expect(tauriDropClientPosition({ x: 640, y: 420 }, 2, "MacIntel")).toEqual({
      x: 640,
      y: 420,
    })
    expect(tauriDropClientPosition({ x: 640, y: 420 }, 2, "Linux x86_64")).toEqual({
      x: 640,
      y: 420,
    })
    expect(tauriDropClientPosition({ x: 640, y: 420 }, 2, "Win32")).toEqual({
      x: 320,
      y: 210,
    })
  })

  it("maps the empty editor tail to the document boundary but rejects outside drops", () => {
    const contentRect = { left: 100, right: 500, top: 100, bottom: 180 } as DOMRect
    const containerRect = { left: 90, right: 510, top: 90, bottom: 500 } as DOMRect
    const view = {
      dom: {
        getBoundingClientRect: () => contentRect,
        closest: () => ({ getBoundingClientRect: () => containerRect }),
      },
      state: { doc: { content: { size: 42 } } },
      posAtCoords: () => ({ pos: 7, inside: 1 }),
    } as unknown as EditorView

    expect(getTauriDropPosForView(view, 200, 140)).toBe(7)
    expect(getTauriDropPosForView(view, 200, 300)).toBe(42)
    expect(getTauriDropPosForView(view, 200, 520)).toBeNull()
    expect(getTauriDropPosForView(view, 520, 300)).toBeNull()
  })
})
