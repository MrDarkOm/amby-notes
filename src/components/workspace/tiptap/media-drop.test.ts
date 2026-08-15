import type { Editor } from "@tiptap/core"
import type { EditorView } from "@tiptap/pm/view"
import { describe, expect, it } from "vitest"

import { setAssetContext } from "./asset-resolver"
import { getImportContextForView, importImageFromClipboard } from "./media-drop"

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
})
