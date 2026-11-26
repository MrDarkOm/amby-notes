// @vitest-environment happy-dom
import { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import StarterKit from "@tiptap/starter-kit"
import { expect, it } from "vitest"
import {
  addNotePage,
  deleteNotePage,
  extractNotePage,
  moveNotePage,
  notePageExtraction,
  notePageAtPosition,
  notePageIdentity,
  restoreNotePageIndex,
  notePagesKey,
  notePagesPlugin,
  notePagesFlagFor,
  notePagesRule,
  readNotePagesFlag,
  renameNotePage,
  setNotePages,
  type NotePagesLevel,
} from "./note-pages"

function makeEditor(content: string, level?: NotePagesLevel) {
  const editor = new Editor({
    extensions: [StarterKit],
    element: document.createElement("div"),
    content,
  })
  editor.registerPlugin(notePagesPlugin(level))
  return editor
}

it("restores by heading identity rather than tab index and falls back if it was removed", () => {
  const editor = makeEditor("<h1>A</h1><p>One</p><h1>B</h1><p>Two</p>")
  try {
    const pages = notePagesKey.getState(editor.state)!.pages
    const saved = notePageIdentity(pages, 1)
    expect(restoreNotePageIndex([pages[1], pages[0]], saved)).toBe(0)
    expect(restoreNotePageIndex([pages[0]], saved)).toBe(0)
    expect(notePageAtPosition(editor.state, pages[1].body)).toBe(1)
  } finally {
    editor.destroy()
  }
})

it("moves a complete section with one undo", () => {
  const editor = makeEditor("<p>Intro</p><h1>A</h1><h2>Nested</h2><p>One</p><h1>B</h1><p>Two</p>")
  try {
    const original = editor.getHTML()
    setNotePages(editor, true, 1)
    expect(moveNotePage(editor, 1, 2, "Introduction")).toBe(true)
    expect(editor.getHTML()).toBe(
      "<p>Intro</p><h1>B</h1><p>Two</p><h1>A</h1><h2>Nested</h2><p>One</p>",
    )
    expect(notePagesKey.getState(editor.state)?.active).toBe(2)
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getHTML()).toBe(original)
  } finally {
    editor.destroy()
  }
})

it.each([
  [0, 2, "<h2>A</h2><p>One</p><h2>B</h2><p>Two</p><h2>Введение</h2><p>Intro</p>"],
  [2, 0, "<h2>B</h2><p>Two</p><h2>Введение</h2><p>Intro</p><h2>A</h2><p>One</p>"],
] as const)(
  "keeps an untitled introduction separate when moving from %i to %i",
  (from, to, expected) => {
    const original = "<p>Intro</p><h2>A</h2><p>One</p><h2>B</h2><p>Two</p>"
    const editor = makeEditor(original)
    try {
      setNotePages(editor, true, from)
      expect(moveNotePage(editor, from, to, "Введение")).toBe(true)
      expect(editor.getHTML()).toBe(expected)
      expect(notePagesKey.getState(editor.state)?.active).toBe(to)
      expect(editor.commands.undo()).toBe(true)
      expect(editor.getHTML()).toBe(original)
    } finally {
      editor.destroy()
    }
  },
)

it("extracts full selected blocks with marks and undoes the move as one step", () => {
  const editor = makeEditor(
    "<h1>A</h1><p>Stay</p><p><strong>Move</strong></p><p>Too</p><h1>B</h1><p>Other</p>",
  )
  try {
    const original = editor.getHTML()
    setNotePages(editor, true, 0)
    editor.commands.setTextSelection({ from: 12, to: 19 })
    const selection = notePageExtraction(editor)!
    expect(extractNotePage(editor, selection, "New")).toBe(true)
    expect(editor.getHTML()).toBe(
      "<h1>A</h1><p>Stay</p><h1>B</h1><p>Other</p><h1>New</h1><p><strong>Move</strong></p><p>Too</p>",
    )
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getHTML()).toBe(original)
  } finally {
    editor.destroy()
  }
})

it("uses top-level headings of the highest level, including a preamble, and leaves the document untouched", () => {
  const editor = makeEditor(
    "<p>Before</p><h2>First</h2><h3>Child</h3><p>A</p><blockquote><h2>Inside a quote</h2></blockquote><h2>Second</h2><p>B</p>",
  )
  try {
    const original = editor.getJSON()
    setNotePages(editor, true, 1)
    const pages = notePagesKey.getState(editor.state)?.pages
    expect(pages?.map(({ title }) => title)).toEqual([null, "First", "Second"])
    expect(
      Array.from(editor.view.dom.children)
        .filter((node) => !node.hasAttribute("data-note-page-hidden"))
        .map((node) => node.textContent),
    ).toEqual(["Child", "A", "Inside a quote"])
    setNotePages(editor, true, 2)
    expect(editor.view.dom.querySelector("[data-note-page-hidden]")?.textContent).toBe("Before")
    expect(editor.getJSON()).toEqual(original)
  } finally {
    editor.destroy()
  }
})

it("rejects edits across page boundaries, restricts selection, and follows undo on another page", () => {
  const editor = makeEditor("<h2>First</h2><p>A</p><h2>Second</h2><p>B</p>")
  try {
    setNotePages(editor, true, 0)
    const { pages } = notePagesKey.getState(editor.state)!
    const original = editor.getHTML()
    editor.view.dispatch(editor.state.tr.delete(2, pages[1].from + 2))
    expect(editor.getHTML()).toBe(original)
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pages[1].from + 2)),
    )
    expect(editor.state.selection.head).toBeLessThan(pages[1].from)
    editor.view.dispatch(editor.state.tr.insertText("!", pages[0].to - 1))
    expect(editor.getHTML()).toContain("<p>A!</p>")
    setNotePages(editor, true, 1)
    expect(editor.commands.undo()).toBe(true)
    expect(notePagesKey.getState(editor.state)?.active).toBe(0)
    expect(editor.getHTML()).toBe(original)
  } finally {
    editor.destroy()
  }
})

it("allows a guarded external document replacement and falls back when there is one section", () => {
  const editor = makeEditor("<h2>First</h2><p>A</p><h2>Second</h2><p>B</p>")
  try {
    setNotePages(editor, true, 1)
    editor.commands.setContent("<h2>Third</h2><p>C</p>", { emitUpdate: false })
    expect(notePagesKey.getState(editor.state)?.active).toBeNull()
    expect(editor.view.dom.querySelector("[data-note-page-hidden]")).toBeNull()
    expect(editor.getHTML()).toBe("<h2>Third</h2><p>C</p>")
  } finally {
    editor.destroy()
  }
})

it("pages a note by its first-level headings only when asked for H1 pages", () => {
  const editor = makeEditor(
    "<p>Intro</p><h1>Goals</h1><h2>Detail</h2><p>A</p><h1>Plans</h1><p>B</p>",
    "h1",
  )
  try {
    setNotePages(editor, true, 1)
    expect(notePagesKey.getState(editor.state)?.pages.map(({ title }) => title)).toEqual([
      null,
      "Goals",
      "Plans",
    ])
  } finally {
    editor.destroy()
  }
  const sections = makeEditor("<h2>First</h2><p>A</p><h2>Second</h2><p>B</p>", "h1")
  try {
    setNotePages(sections, true)
    expect(notePagesKey.getState(sections.state)?.pages).toEqual([])
    expect(notePagesKey.getState(sections.state)?.active).toBeNull()
  } finally {
    sections.destroy()
  }
})

it("reads the amby-pages flag from frontmatter properties", () => {
  const flag = (value: string) => readNotePagesFlag([{ key: "amby-pages", value }])
  expect(flag("true")).toBe(true)
  expect(flag(" True ")).toBe(true)
  expect(flag("false")).toBe(false)
  expect(flag("maybe")).toBeNull()
  expect(readNotePagesFlag([{ key: "pages", value: "true" }])).toBeNull()
  expect(readNotePagesFlag(undefined)).toBeNull()
})

it("decides which headings make pages from the setting, the flag and the dossier", () => {
  expect(notePagesRule("off", true, true)).toBeNull()
  expect(notePagesRule("always", null, false)).toBe("h1")
  expect(notePagesRule("always", false, false)).toBeNull()
  expect(notePagesRule("flagged", null, false)).toBeNull()
  expect(notePagesRule("flagged", true, false)).toBe("h1")
  expect(notePagesRule("flagged", null, true)).toBe("top")
  expect(notePagesRule("always", true, true)).toBe("top")
  expect(notePagesRule("flagged", false, true)).toBeNull()
})

it("writes the smallest flag that turns pages on or off for one note", () => {
  expect(notePagesFlagFor("flagged", true)).toBe(true)
  expect(notePagesFlagFor("flagged", false)).toBeNull()
  expect(notePagesFlagFor("always", true)).toBeNull()
  expect(notePagesFlagFor("always", false)).toBe(false)
  for (const mode of ["flagged", "always"] as const) {
    for (const enabled of [true, false]) {
      expect(notePagesRule(mode, notePagesFlagFor(mode, enabled), false) !== null).toBe(enabled)
    }
  }
})

it("never shows the heading of the open page; an empty page offers a line to start writing", () => {
  const editor = makeEditor("<h1>Goals</h1><p>A</p><h1>Empty</h1><h1>Last</h1><p>C</p>", "h1")
  try {
    setNotePages(editor, true, 0)
    const visible = () =>
      Array.from(editor.view.dom.children)
        .filter((node) => !node.hasAttribute("data-note-page-hidden"))
        .map((node) => node.textContent)
    expect(visible()).toEqual(["A"])
    // The cursor cannot rest in the hidden heading: it moves to the page's content.
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2)))
    expect(editor.state.selection.from).toBeGreaterThanOrEqual(editor.state.doc.child(0).nodeSize)
    // Typing into the hidden heading is refused.
    const before = editor.getHTML()
    editor.view.dispatch(editor.state.tr.insertText("!", 2))
    expect(editor.getHTML()).toBe(before)

    // A page with only its heading shows no heading either, just the invitation to write.
    setNotePages(editor, true, 1)
    expect(visible().filter((text) => text === "Empty")).toEqual([])
    const empty = editor.view.dom.querySelector("[data-note-page-empty]")
    expect(empty).not.toBeNull()
    // Typing there starts the page's text under its heading.
    editor.view.someProp("handleTextInput", (handle) =>
      handle(editor.view, editor.state.selection.from, editor.state.selection.to, "x", () =>
        editor.state.tr.insertText("x"),
      ),
    )
    expect(editor.getHTML()).toBe(
      "<h1>Goals</h1><p>A</p><h1>Empty</h1><p>x</p><h1>Last</h1><p>C</p>",
    )
    expect(editor.view.dom.querySelector("[data-note-page-empty]")).toBeNull()
  } finally {
    editor.destroy()
  }
})

it("adds a page at the end with a heading of the page level and opens it", () => {
  const editor = makeEditor("<h1>Goals</h1><p>A</p><h1>Plans</h1><p>B</p>", "h1")
  try {
    setNotePages(editor, true, 0)
    expect(addNotePage(editor, "New page")).toBe(true)
    const state = notePagesKey.getState(editor.state)!
    expect(state.pages.map(({ title }) => title)).toEqual(["Goals", "Plans", "New page"])
    expect(state.active).toBe(2)
    expect(editor.getHTML()).toBe(
      "<h1>Goals</h1><p>A</p><h1>Plans</h1><p>B</p><h1>New page</h1><p></p>",
    )
    // The cursor waits on the new page's empty line.
    expect(editor.state.selection.from).toBeGreaterThan(state.pages[2].from)
    // One undo removes the page.
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getHTML()).toBe("<h1>Goals</h1><p>A</p><h1>Plans</h1><p>B</p>")
  } finally {
    editor.destroy()
  }
  const dossier = makeEditor("<h2>Basics</h2><p>A</p><h2>Traits</h2><p>B</p>")
  try {
    setNotePages(dossier, true, 0)
    addNotePage(dossier, "Extra")
    expect(dossier.getHTML()).toContain("<h2>Extra</h2>")
  } finally {
    dossier.destroy()
  }
})

it("renames a page by rewriting only its heading text", () => {
  const editor = makeEditor("<p>Intro</p><h1>Goals</h1><p>A</p><h1>Plans</h1><p>B</p>", "h1")
  try {
    setNotePages(editor, true, 2)
    expect(renameNotePage(editor, 1, "  Aims ")).toBe(true)
    expect(editor.getHTML()).toBe("<p>Intro</p><h1>Aims</h1><p>A</p><h1>Plans</h1><p>B</p>")
    expect(notePagesKey.getState(editor.state)?.active).toBe(2)
    // The introduction has no heading, and an empty name changes nothing.
    expect(renameNotePage(editor, 0, "Intro")).toBe(false)
    expect(renameNotePage(editor, 2, "   ")).toBe(false)
    expect(editor.getHTML()).toBe("<p>Intro</p><h1>Aims</h1><p>A</p><h1>Plans</h1><p>B</p>")
  } finally {
    editor.destroy()
  }
})

it("deletes a page with everything on it, or keeps its text in the neighbouring page", () => {
  const html = "<p>Intro</p><h1>Goals</h1><p>A</p><h1>Plans</h1><p>B</p><h1>Ideas</h1><p>C</p>"
  const run = (index: number, keep: boolean) => {
    const editor = makeEditor(html, "h1")
    try {
      setNotePages(editor, true, index)
      expect(deleteNotePage(editor, index, keep)).toBe(true)
      return { html: editor.getHTML(), active: notePagesKey.getState(editor.state)?.active }
    } finally {
      editor.destroy()
    }
  }
  expect(run(2, false)).toEqual({
    html: "<p>Intro</p><h1>Goals</h1><p>A</p><h1>Ideas</h1><p>C</p>",
    active: 1,
  })
  // Moving keeps the text at the end of the page before it.
  expect(run(2, true)).toEqual({
    html: "<p>Intro</p><h1>Goals</h1><p>A</p><p>B</p><h1>Ideas</h1><p>C</p>",
    active: 1,
  })
  // The first page has no page before it: its text goes to the top of the next page.
  expect(run(0, true)).toEqual({
    html: "<h1>Goals</h1><p>Intro</p><p>A</p><h1>Plans</h1><p>B</p><h1>Ideas</h1><p>C</p>",
    active: 0,
  })
  expect(run(0, false).html).toBe(
    "<h1>Goals</h1><p>A</p><h1>Plans</h1><p>B</p><h1>Ideas</h1><p>C</p>",
  )
})

it("leaves the cursor inside a line of the page that opens after a deletion", () => {
  for (const [index, keep] of [
    [2, false],
    [2, true],
    [0, false],
    [3, false],
  ] as const) {
    const editor = makeEditor(
      "<h1>Goals</h1><p>A</p><h1>Plans</h1><p>B</p><h1>Ideas</h1><p>C</p><h1>Last</h1>",
      "h1",
    )
    try {
      setNotePages(editor, true, index)
      deleteNotePage(editor, index, keep)
      const state = notePagesKey.getState(editor.state)!
      const page = state.pages[state.active!]
      const { selection } = editor.state
      expect(selection.$from.parent.inlineContent).toBe(true)
      expect(selection.from).toBeGreaterThanOrEqual(page.body)
      expect(selection.to).toBeLessThan(page.to)
    } finally {
      editor.destroy()
    }
  }
})

it("drops a stale browser selection inside the editor when the page changes without focus", () => {
  const editor = makeEditor("<h1>Goals</h1><p>A</p><h1>Plans</h1><p>B</p>", "h1")
  try {
    document.body.append(editor.view.dom)
    setNotePages(editor, true, 0)
    const text = editor.view.dom.querySelector("p")!.firstChild!
    document.getSelection()!.collapse(text, 1)
    ;(document.activeElement as HTMLElement | null)?.blur()
    setNotePages(editor, true, 1)
    expect(document.getSelection()!.rangeCount).toBe(0)
  } finally {
    editor.destroy()
  }
})
