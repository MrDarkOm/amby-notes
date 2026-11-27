// @vitest-environment happy-dom
import * as React from "react"
import { Editor } from "@tiptap/core"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import * as storage from "@/lib/storage"
import { snapshotImagePaths } from "./snapshot-assets"
import { markdownToDoc } from "../tiptap/markdown"
import { buildSnapshotExtensions } from "./snapshot-extensions"
import { SnapshotPreview, SnapshotModeToggle, type SnapshotMode } from "./snapshot-preview"

beforeEach(async () => {
  await i18n.changeLanguage("ru")
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
function Reader({ content }: { content: string }) {
  const [mode, setMode] = React.useState<SnapshotMode>("read")
  return (
    <>
      <SnapshotModeToggle value={mode} onChange={setMode} />
      <SnapshotPreview content={content} mode={mode} />
    </>
  )
}

describe("snapshot reader", () => {
  it("resolves archived assets before vault assets and confines relative paths", () => {
    const context = { vaultPath: "/vault", notePath: "/vault/.amby/trash/id/Bundle/Note.md" }
    expect(snapshotImagePaths("assets/pic.png", context)).toEqual([
      "/vault/.amby/trash/id/Bundle/assets/pic.png",
      "/vault/assets/pic.png",
    ])
    expect(snapshotImagePaths("../../../../../../private.png", context)).toEqual([])
    expect(snapshotImagePaths("file:///private.png", context)).toEqual([])
    expect(
      snapshotImagePaths("assets/pic.png", {
        vaultPath: "C:\\Vault",
        notePath: "C:\\Vault\\Note.md",
      }),
    ).toEqual(["C:/Vault/assets/pic.png"])
    expect(snapshotImagePaths("javascript:alert(1)", context)).toEqual([])
  })

  it("uses the note's Read rendering and shows the exact source on request", async () => {
    const content =
      "\uFEFF---\r\namby-id: kept\r\n---\r\n# Заголовок\r\n\r\n**Важно**\r\n\r\n| A | B |\r\n| --- | --- |\r\n| 1 | 2 |\r\n"
    const { container } = render(<Reader content={content} />)
    expect(await screen.findByRole("heading", { name: "Заголовок" })).toBeTruthy()
    expect(screen.getByText("Важно").tagName).toBe("STRONG")
    expect(container.querySelector("table")).toBeTruthy()
    expect(container.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("false")
    expect(screen.queryByText("amby-id: kept")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Исходный текст" }))
    expect(container.querySelector("pre")?.textContent).toBe(content)
    fireEvent.click(screen.getByRole("button", { name: "Просмотр" }))
    expect(await screen.findByRole("heading", { name: "Заголовок" })).toBeTruthy()
  })

  it("changes the displayed snapshot without keeping the previous document", async () => {
    const { rerender } = render(<SnapshotPreview content="# Старая версия" mode="read" />)
    await screen.findByRole("heading", { name: "Старая версия" })
    rerender(<SnapshotPreview content="# Другая версия" mode="read" />)
    expect(await screen.findByRole("heading", { name: "Другая версия" })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "Старая версия" })).toBeNull()
  })

  it("renders images while keeping HTML, transclusions and database widgets inert without writing", async () => {
    const write = vi.spyOn(storage, "writeFile")
    const save = vi.spyOn(storage, "saveVaultJSON")
    const load = vi.spyOn(storage, "loadVaultJSON")
    const query = vi.spyOn(storage, "queryDatabase")
    const content =
      "# Safe\n\n<script>alert(1)</script>\n\n![Alt](https://example.invalid/image.png)\n\n![[Other note]]\n\n```amby-db\nblock-id\n```\n"
    const { container } = render(<SnapshotPreview content={content} mode="read" />)
    await screen.findByRole("heading", { name: "Safe" })
    expect(container.querySelector("script, iframe, video, audio")).toBeNull()
    await waitFor(() =>
      expect(container.querySelector("img:not(.ProseMirror-separator)")?.getAttribute("src")).toBe(
        "https://example.invalid/image.png",
      ),
    )
    expect(container.textContent).toContain("Other note")
    expect(container.textContent).toContain("block-id")
    expect(write).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it("loads local images and Obsidian image embeds from the explicit snapshot path", async () => {
    const asset = vi.spyOn(storage, "toAssetUrl").mockResolvedValue("data:image/png;base64,test")
    const { container } = render(
      <SnapshotPreview
        content={"![Photo](assets/photo.png)\n\n![[drawing.png]]\n"}
        mode="read"
        assets={{ vaultPath: "/vault", notePath: "/vault/.amby/trash/id/Bundle/Note.md" }}
      />,
    )
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2))
    expect(asset).toHaveBeenCalledWith("/vault/.amby/trash/id/Bundle/assets/photo.png")
    expect(asset).toHaveBeenCalledWith("/vault/.amby/trash/id/Bundle/assets/drawing.png")
    fireEvent.error(container.querySelector("img")!)
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy())
  })

  it("rejects document changes even when a command dispatches one directly", () => {
    const editor = new Editor({
      extensions: buildSnapshotExtensions(),
      content: markdownToDoc("# Protected\n"),
      editable: false,
    })
    try {
      const before = editor.getJSON()
      editor.view.dispatch(editor.state.tr.insertText("Changed", 1))
      expect(editor.getJSON()).toEqual(before)
    } finally {
      editor.destroy()
    }
  })

  it("keeps task checkboxes read only", async () => {
    const { container } = render(
      <SnapshotPreview content={"# Tasks\n\n- [ ] Pending\n"} mode="read" />,
    )
    await screen.findByRole("heading", { name: "Tasks" })
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    fireEvent.click(checkbox)
    await waitFor(() => expect(checkbox.checked).toBe(false))
  })
})
