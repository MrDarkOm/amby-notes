// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { DocumentEditor, type Document } from "./document-editor"
import type { DocumentBodyProps } from "./document-body"

const rendered = vi.hoisted(() => ({ bodies: [] as DocumentBodyProps[] }))
vi.mock("./document-header", () => ({ DocumentHeader: () => null }))
vi.mock("./document-actions", () => ({
  FilePickerModal: () => null,
  LayerConfirmDialog: () => null,
}))
vi.mock("./note-pdf-export", () => ({ NotePdfExport: () => null, NotePdfExportDialog: () => null }))
vi.mock("./document-body", () => ({
  DocumentBody: (props: DocumentBodyProps) => {
    rendered.bodies.push(props)
    return (
      <div>
        <output data-testid="mode">{props.viewMode}</output>
        <textarea
          aria-label="source"
          value={props.content}
          onChange={(event) => props.onContentChange(event.target.value)}
        />
        <button onClick={() => props.onViewModeChange("live")}>Live</button>
      </div>
    )
  },
}))

const note = (content: string, extra: Partial<Document> = {}): Document => ({
  id: "note-a",
  title: "Note",
  content,
  path: "/fixture/Note.md",
  modified: "",
  wordCount: 1,
  ...extra,
})
afterEach(() => {
  cleanup()
  rendered.bodies.length = 0
})

describe("DocumentEditor lossless boundary", () => {
  it.each(["Footnote[^1]\n\n[^1]: definition\n", "[label][ref]\n\n[ref]: https://example.com\n"])(
    "never mounts incompatible Markdown in Live Preview",
    (content) => {
      const changeMode = vi.fn()
      const save = vi.fn()
      const ui = render(
        <DocumentEditor
          document={note(content)}
          viewMode="live"
          onViewModeChange={changeMode}
          onContentChange={save}
        />,
      )
      expect(
        rendered.bodies.every((body) => body.viewMode === "source" && body.content === content),
      ).toBe(true)
      fireEvent.click(ui.getByText("Live"))
      expect(changeMode).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
    },
  )

  it("checks raw source line endings even when IPC normalized the editor body", () => {
    const ui = render(<DocumentEditor document={note("One\nTwo\n", { source: "One\r\nTwo\n" })} />)
    expect(ui.getByTestId("mode").textContent).toBe("source")
  })

  it("admits a lossless body without parsing opaque YAML as Markdown", () => {
    const ui = render(
      <DocumentEditor
        document={note("# Body\n", { source: "---\r\nunknown: yes\r\n---\r\n# Body\r\n" })}
      />,
    )
    expect(ui.getByTestId("mode").textContent).toBe("live")
  })

  it("rechecks before the first render of a new document or external revision", () => {
    const ui = render(<DocumentEditor document={note("# Safe\n")} />)
    rendered.bodies.length = 0
    const incompatible = "Text[^x]\n\n[^x]: note\n"
    ui.rerender(<DocumentEditor document={note(incompatible, { id: "note-b" })} />)
    expect(
      rendered.bodies.every((body) => body.viewMode === "source" && body.content === incompatible),
    ).toBe(true)
    rendered.bodies.length = 0
    ui.rerender(<DocumentEditor document={note("# Updated\n", { id: "note-b" })} />)
    expect(
      rendered.bodies.every((body) => body.viewMode === "live" && body.content === "# Updated\n"),
    ).toBe(true)
  })

  it("checks unsaved source edits before allowing a mode transition", () => {
    const changeMode = vi.fn()
    const save = vi.fn()
    const ui = render(
      <DocumentEditor
        document={note("# Safe\n")}
        viewMode="source"
        onViewModeChange={changeMode}
        onContentChange={save}
      />,
    )
    const incompatible = "Text[^x]\n\n[^x]: note\n"
    fireEvent.change(ui.getByRole("textbox"), { target: { value: incompatible } })
    fireEvent.click(ui.getByText("Live"))
    expect(changeMode).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledWith(incompatible, "note-a")
    fireEvent.change(ui.getByRole("textbox"), { target: { value: "# Fixed\n" } })
    fireEvent.click(ui.getByText("Live"))
    expect(changeMode).toHaveBeenCalledWith("live")
  })

  it("never leaves Live Preview because of what the user types", () => {
    const ui = render(<DocumentEditor document={note("Начало")} viewMode="live" />)
    expect(ui.getByTestId("mode").textContent).toBe("live")
    // Text the parser cannot read back (an interior trailing space, a footnote), as the
    // store echoes it after each keystroke.
    for (const typed of ["Начало ", "Начало \nмир", "Сноска[^1]\n\n[^1]: текст\n"]) {
      fireEvent.change(ui.getByRole("textbox"), { target: { value: typed } })
      ui.rerender(<DocumentEditor document={note(typed)} viewMode="live" />)
      expect(ui.getByTestId("mode").textContent, JSON.stringify(typed)).toBe("live")
    }
    expect(rendered.bodies.every((body) => body.viewMode === "live")).toBe(true)
  })

  it("keeps a note forced into Source there while it is edited, until the user switches", () => {
    const changeMode = vi.fn()
    const incompatible = "Text[^x]\n\n[^x]: note\n"
    const ui = render(
      <DocumentEditor
        document={note(incompatible)}
        viewMode="live"
        onViewModeChange={changeMode}
      />,
    )
    expect(ui.getByTestId("mode").textContent).toBe("source")
    fireEvent.change(ui.getByRole("textbox"), { target: { value: "# Fixed\n" } })
    ui.rerender(
      <DocumentEditor document={note("# Fixed\n")} viewMode="live" onViewModeChange={changeMode} />,
    )
    // Fixed, but the editor does not jump back on its own.
    expect(ui.getByTestId("mode").textContent).toBe("source")
    fireEvent.click(ui.getByText("Live"))
    expect(changeMode).toHaveBeenCalledWith("live")
    expect(ui.getByTestId("mode").textContent).toBe("live")
  })

  it("does not resurrect an old local buffer when external content returns to an earlier value", () => {
    const ui = render(<DocumentEditor document={note("# A\n")} viewMode="source" />)
    fireEvent.change(ui.getByRole("textbox"), { target: { value: "# B\n" } })
    ui.rerender(<DocumentEditor document={note("# B\n")} viewMode="source" />)
    ui.rerender(<DocumentEditor document={note("# A\n")} viewMode="source" />)
    expect((ui.getByRole("textbox") as HTMLTextAreaElement).value).toBe("# A\n")
  })
})
