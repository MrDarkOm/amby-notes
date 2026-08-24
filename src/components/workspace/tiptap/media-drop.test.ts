import type { Editor } from "@tiptap/core"
import type { EditorView } from "@tiptap/pm/view"
import { describe, expect, it } from "vitest"

import { setAssetContext } from "./asset-resolver"
import {
  getImportContextForView,
  importImageFromClipboard,
  insertImportedAssets,
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

  it("inserts completed mixed media in one mapped transaction", () => {
    const operations: Array<unknown> = []
    let insertedSize = 0
    const tr = {
      docChanged: false,
      insert(pos: number, node: { nodeSize: number }) {
        operations.push(["image", pos])
        insertedSize = node.nodeSize
        this.docChanged = true
        return this
      },
      insertText(text: string, pos: number) {
        operations.push(["file", pos, text])
        insertedSize = text.length
        this.docChanged = true
        return this
      },
      addMark(from: number, to: number, mark: unknown) {
        operations.push(["mark", from, to, mark])
        return this
      },
      mapping: { map: (pos: number) => pos + insertedSize },
    }
    const dispatched: unknown[] = []
    const view = {
      state: {
        doc: { content: { size: 50 } },
        tr,
        schema: {
          nodes: { image: { create: () => ({ nodeSize: 1 }) } },
          marks: { link: { create: ({ href }: { href: string }) => ({ href }) } },
        },
      },
      dispatch: (transaction: unknown) => dispatched.push(transaction),
    } as unknown as EditorView

    expect(
      insertImportedAssets(view, 5, [
        { relPath: "assets/photo.png", fileName: "photo.png", kind: "image", absPath: "" },
        { relPath: "assets/report.pdf", fileName: "report.pdf", kind: "file", absPath: "" },
        { relPath: "assets/diagram.webp", fileName: "diagram.webp", kind: "image", absPath: "" },
      ]),
    ).toBe(true)

    expect(operations).toEqual([
      ["image", 5],
      ["file", 6, "report.pdf"],
      ["mark", 6, 16, { href: "assets/report.pdf" }],
      ["image", 16],
    ])
    expect(dispatched).toEqual([tr])
  })

  it("does not dispatch an imported batch after its session is aborted", () => {
    const controller = new AbortController()
    controller.abort()
    const dispatch = () => {
      throw new Error("must not dispatch")
    }
    const view = {
      state: {
        doc: { content: { size: 1 } },
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
})
