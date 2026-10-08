// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { EditorState, TextSelection } from "@tiptap/pm/state"

import { FootnoteTyping, footnoteTyped, insertFootnote, nextFootnoteLabel } from "./footnote-nodes"
import {
  docToMarkdown,
  docToNormalizedMarkdown,
  editorSchema,
  markdownToDoc,
  restoreSourceFormatting,
  roundTripCheck,
} from "./markdown"
import { markdownMeaning } from "./markdown-meaning"
import { schemaExtensions } from "./schema"

const parse = (markdown: string) => editorSchema.nodeFromJSON(markdownToDoc(markdown))

const kinds = (markdown: string) => {
  const found: string[] = []
  parse(markdown).descendants((node) => {
    if (node.type.name.startsWith("footnote") || node.type.name === "opaqueMarkdownBlock") {
      found.push(node.type.name)
    }
  })
  return found
}

/** Notes with footnotes, written the way people and other editors write them. */
const NOTES: Array<[string, string]> = [
  ["a reference and its definition", "A claim.[^1]\n\n[^1]: The source of the claim."],
  ["a one-word definition", "Text.[^1]\n\n[^1]: Body."],
  ["a definition that is only an address", "Text.[^web]\n\n[^web]: https://example.com/page"],
  ["a named label", "Text.[^note-a] and more.[^b_2]\n\n[^note-a]: First.\n[^b_2]: Second."],
  ["a reference without a definition", "Text.[^missing] goes on."],
  ["a definition nothing refers to", "Text.\n\n[^1]: Nobody points here."],
  ["an inline footnote", "Text.^[Written where it is used.] After."],
  ["an inline footnote with brackets and a link", "Text.^[See [the site](http://a.b) [sic].]"],
  [
    "formatting inside a definition",
    "T.[^1]\n\n[^1]: With **bold**, `code` and [a link](http://a.b).",
  ],
  ["a definition on two lines", "T.[^1]\n\n[^1]: First line\nsecond line of the same paragraph."],
  ["extra spaces after the colon", "T.[^1]\n\n[^1]:   Spaced out."],
  ["an empty definition", "T.[^1]\n\n[^1]:"],
  [
    "footnotes in a list, a quote, a heading and a table",
    [
      "# Title[^h]",
      "",
      "- item[^1]",
      "- other ^[inline in a list]",
      "",
      "> quoted[^q]",
      "",
      "| a | b[^t] |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "[^h]: Heading note.",
      "[^1]: List note.",
      "",
      "[^q]: Quote note.",
      "",
      "[^t]: Table note.",
    ].join("\n"),
  ],
  ["Windows line endings", "Text.[^1]\r\n\r\n[^1]: Body text.\r\n"],
  [
    "a definition with an indented continuation",
    "T.[^1]\n\n[^1]: First paragraph.\n\n    Second paragraph of the note.\n\nAfter.",
  ],
  ["a definition inside a quote", "> Text.[^1]\n>\n> [^1]: Kept as it is written."],
]

describe("footnotes in the file", () => {
  it.each(NOTES)("opens in Live and saves without a change: %s", (_name, markdown) => {
    expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
    const doc = parse(markdown)
    expect(restoreSourceFormatting(docToMarkdown(doc), markdown)).toBe(markdown)
  })

  it.each(NOTES)("reads back the same after every block is rewritten: %s", (_name, markdown) => {
    const doc = parse(markdown)
    const rewritten = docToNormalizedMarkdown(doc)
    // For the editor's own parser …
    expect(docToNormalizedMarkdown(parse(rewritten))).toBe(rewritten)
    // … and for the independent reading, which knows nothing of the editor's nodes.
    const unix = markdown.replace(/\r\n/gu, "\n")
    expect(markdownMeaning(rewritten).content).toBe(markdownMeaning(unix).content)
    expect(markdownMeaning(rewritten).hasDefinitions).toBe(false)
  })

  it("reads references, definitions and inline notes as nodes", () => {
    expect(kinds("A claim.[^1]\n\n[^1]: The source.")).toEqual([
      "footnoteReference",
      "footnoteDefinition",
    ])
    expect(kinds("Text.^[Inline.]")).toEqual(["footnoteInline"])
    const doc = parse("A.[^note-a]\n\n[^note-a]: The **text**.")
    expect(doc.child(0).lastChild?.attrs.label).toBe("note-a")
    expect(doc.child(1).attrs.label).toBe("note-a")
    expect(doc.child(1).textContent).toBe("The text.")
  })

  it("keeps the text of an inline footnote as it is written", () => {
    const doc = parse("T.^[See *this* and \\[that\\].]")
    let value = ""
    doc.descendants((node) => {
      if (node.type.name === "footnoteInline") value = node.attrs.value as string
    })
    expect(value).toBe("See *this* and \\[that\\].")
  })

  it("leaves what only looks like a footnote alone", () => {
    expect(kinds("A [^two words] bracket.")).toEqual([])
    expect(kinds("Code `[^1]` and `^[x]`.")).toEqual([])
    expect(kinds("```\n[^1]: in code\n```")).toEqual([])
    expect(kinds("An empty ^[] and a lone ^[ bracket.")).toEqual([])
    for (const markdown of ["A [^two words] bracket.", "Code `[^1]` and `^[x]`."]) {
      expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
    }
  })

  it("keeps the indented continuation of a definition as its source text", () => {
    const markdown =
      "T.[^1]\n\n[^1]: First paragraph.\n\n    Second paragraph of the note.\n\nAfter."
    expect(kinds(markdown)).toEqual([
      "footnoteReference",
      "footnoteDefinition",
      "opaqueMarkdownBlock",
    ])
    // An indented block that follows something else is ordinary code.
    expect(kinds("Text.\n\n    code\n\nAfter.")).toEqual([])
  })

  it("still keeps a real link definition in Source", () => {
    expect(roundTripCheck("Read [a][b].\n\n[b]: http://a.b").ok).toBe(false)
    expect(roundTripCheck("T.[^1]\n\n[^1]: Note.\n\n[b]: http://a.b").ok).toBe(false)
  })
})

describe("editing a note with footnotes", () => {
  const open = (markdown: string, find: string, offset = 0) => {
    const doc = parse(markdown)
    let at = -1
    doc.descendants((node, pos) => {
      if (at === -1 && node.isText && node.text?.includes(find)) {
        at = pos + node.text.indexOf(find) + offset
      }
    })
    const base = EditorState.create({ schema: editorSchema, doc })
    return base.apply(base.tr.setSelection(TextSelection.create(doc, at)))
  }

  it("rewrites only the edited block and keeps its reference", () => {
    const markdown = "Setext\n======\n\nA claim.[^1] More.\n\n* * *\n\n[^1]:   Spaced out."
    const state = open(markdown, "A claim")
    const edited = state.apply(state.tr.insertText("New. ", state.selection.from))
    expect(docToMarkdown(edited.doc)).toBe(
      "Setext\n======\n\nNew. A claim.[^1] More.\n\n* * *\n\n[^1]:   Spaced out.",
    )
  })

  it("rewrites an edited definition in the editor's form and nothing else", () => {
    const markdown = "A claim.[^1]\n\n* * *\n\n[^1]: Spaced *out*."
    const state = open(markdown, "Spaced")
    const edited = state.apply(state.tr.insertText("Well ", state.selection.from))
    const written = docToMarkdown(edited.doc)
    expect(written).toBe("A claim.[^1]\n\n* * *\n\n[^1]: Well Spaced *out*.")
    expect(roundTripCheck(written)).toEqual({ ok: true, result: written })
  })

  it("keeps a definition as its source text when rewriting it would change its text", () => {
    // Several spaces after the colon are text for a reader that does not know footnotes.
    const markdown = "A claim.[^1]\n\n[^1]:   Spaced out."
    expect(kinds(markdown)).toEqual(["footnoteReference", "opaqueMarkdownBlock"])
    expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
  })

  it("writes text typed at the start of a definition so that it reads back", () => {
    for (const typed of [
      "# not a heading",
      "- not a list",
      "1. not a list",
      "> not a quote",
      " spaced",
    ]) {
      const state = open("T.[^1]\n\n[^1]: x", "x")
      const edited = state.apply(
        state.tr.insertText(typed, state.selection.from, state.selection.from + 1),
      )
      const written = docToMarkdown(edited.doc)
      const again = parse(written)
      expect(again.child(1).type.name, typed).toBe("footnoteDefinition")
      expect(again.child(1).textContent, typed).toBe(typed)
    }
  })
})

describe("typing footnotes in Live", () => {
  let editor: Editor | null = null
  afterEach(() => {
    editor?.destroy()
    editor = null
  })

  function mount(markdown: string): Editor {
    editor = new Editor({
      element: document.body.appendChild(document.createElement("div")),
      extensions: [...schemaExtensions, FootnoteTyping],
      content: markdownToDoc(markdown),
    })
    editor.commands.focus("end")
    return editor
  }

  function type(target: Editor, text: string) {
    for (const character of text) {
      const { from, to } = target.state.selection
      const handled = target.view.someProp("handleTextInput", (handler) =>
        handler(target.view, from, to, character, () =>
          target.state.tr.insertText(character, from, to),
        ),
      )
      if (!handled) target.view.dispatch(target.state.tr.insertText(character, from, to))
    }
  }

  it("makes a reference when `[^label]` is closed", () => {
    const target = mount("A claim.")
    type(target, "[^1]")
    expect(target.state.doc.firstChild?.lastChild?.type.name).toBe("footnoteReference")
    type(target, " More.")
    expect(docToMarkdown(target.state.doc)).toBe("A claim.[^1] More.")
  })

  it("makes an inline note when `^[text]` is closed", () => {
    const target = mount("A claim.")
    type(target, "^[said who]")
    expect(target.state.doc.firstChild?.lastChild?.type.name).toBe("footnoteInline")
    expect(docToMarkdown(target.state.doc)).toBe("A claim.^[said who]")
  })

  it("makes a definition from `[^label]: ` at the start of a line", () => {
    const target = mount("")
    type(target, "[^1]: The source.")
    expect(target.state.doc.firstChild?.type.name).toBe("footnoteDefinition")
    expect(target.state.doc.firstChild?.attrs.label).toBe("1")
    expect(docToMarkdown(target.state.doc)).toBe("[^1]: The source.")
  })

  it("leaves brackets that are not footnotes as typed", () => {
    const target = mount("")
    type(target, "a [^two words] b and `[^1]`")
    let footnotes = 0
    target.state.doc.descendants((node) => {
      if (node.type.name.startsWith("footnote")) footnotes++
    })
    expect(footnotes).toBe(0)
  })

  it("does nothing for a reference typed in the middle of a line followed by a colon", () => {
    const state = EditorState.create({ schema: editorSchema, doc: parse("Text [^1]:") })
    const end = state.doc.content.size - 1
    expect(footnoteTyped(state, end, end, " ")).toBeNull()
  })

  it("inserts a numbered footnote with its definition at the end of the note", () => {
    const target = mount("First.[^1]\n\nSecond.\n\n[^1]: One.")
    expect(nextFootnoteLabel(target.state)).toBe("2")
    let afterSecond = 0
    target.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "Second.") afterSecond = pos + node.nodeSize
    })
    target.commands.setTextSelection(afterSecond)
    insertFootnote(target.state, target.view.dispatch)
    type(target, "Two.")
    expect(docToMarkdown(target.state.doc)).toBe(
      "First.[^1]\n\nSecond.[^2]\n\n[^1]: One.\n\n[^2]: Two.",
    )
  })
})
