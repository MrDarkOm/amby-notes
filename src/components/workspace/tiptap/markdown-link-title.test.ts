// @vitest-environment happy-dom
import { Editor } from "@tiptap/core"
import { afterEach, describe, expect, it } from "vitest"
import {
  docToMarkdown,
  docToNormalizedMarkdown,
  editorSchema,
  markdownToDoc,
  roundTripCheck,
} from "./markdown"
import { schemaExtensions } from "./schema"

const parse = (markdown: string) => editorSchema.nodeFromJSON(markdownToDoc(markdown))

function linkMarks(markdown: string) {
  const marks: Array<Record<string, unknown>> = []
  parse(markdown).descendants((node) => {
    const link = node.marks.find((mark) => mark.type.name === "link")
    if (link) marks.push(link.attrs)
  })
  return marks
}

function linkDoc(attrs: Record<string, unknown>, label = "text") {
  return editorSchema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: label, marks: [{ type: "link", attrs }] }],
      },
    ],
  })
}

describe("link titles", () => {
  // Every quoting form markdown-it accepts, with the other quote characters inside.
  it.each([
    ['[text](http://a.b "Title")', "Title"],
    ["[text](http://a.b 'Title')", "Title"],
    ["[text](http://a.b (Title))", "Title"],
    ['[text](http://a.b "Заголовок ссылки")', "Заголовок ссылки"],
    ['[text](http://a.b "say \\"hi\\"")', 'say "hi"'],
    ['[text](http://a.b "it\'s (fine)")', "it's (fine)"],
    ["[text](http://a.b 'it\\'s')", "it's"],
    ["[text](http://a.b 'say \"hi\" (ok)')", 'say "hi" (ok)'],
    ["[text](http://a.b (a \\(b\\) c))", "a (b) c"],
    ["[text](http://a.b (\"double\" and 'single'))", "\"double\" and 'single'"],
    ['[text](http://a.b "A & B, C:\\dir, 50%")', "A & B, C:\\dir, 50%"],
    ['[text](http://a.b "back\\\\\\"slash")', 'back\\"slash'],
    ['[**bold** text](http://a.b "Title")', "Title"],
  ])("keeps the title and the source bytes of %s", (markdown, title) => {
    expect(linkMarks(markdown)[0]).toMatchObject({ href: "http://a.b", title })
    expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
  })

  it("keeps titled links inside paragraphs, lists, quotes and table cells", () => {
    const markdown = [
      "Before [one](http://a.b \"First\") and [two](http://c.d 'Second') after.",
      "- item [three](http://e.f (Third))\n- plain [four](http://g.h)",
      '> quote [five](http://i.j "Fifth")',
      '| A | B |\n| --- | --- |\n| [six](http://k.l "Sixth") | x |',
    ].join("\n\n")
    expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
    expect(linkMarks(markdown).map((attrs) => attrs.title)).toEqual([
      "First",
      "Second",
      "Third",
      null,
      "Fifth",
      "Sixth",
    ])
  })

  // Forms the serializer spells differently open in Live as well: the link keeps its
  // bytes while its block is unchanged, and keeps its title when the block is rewritten.
  it.each([
    ['[text](http://a.b  "Title")', "Title"],
    ['[text](http://a.b "Title" )', "Title"],
    ['[text]( http://a.b "Title")', "Title"],
    ['[text](<http://a.b> "Title")', "Title"],
    ['[text](http://a.b "a &quot;b&quot;")', 'a "b"'],
    ['[text](http://a.b "a &amp; b")', "a & b"],
    ['[text](http://a.b "a\\!b")', "a!b"],
    ['[text](http://a.b "a\\\\b")', "a\\b"],
    ["[text](http://a.b 'say \\\"hi\\\"')", 'say "hi"'],
    ['[text](http://a.b\n"Title")', "Title"],
  ])("keeps the bytes of %j and its title when it is rewritten", (markdown, title) => {
    expect(linkMarks(markdown)[0]).toMatchObject({ title })
    expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
    const rewritten = docToNormalizedMarkdown(parse(markdown))
    expect(rewritten).not.toBe(markdown)
    expect(linkMarks(rewritten)[0]).toMatchObject({ href: "http://a.b", title })
  })

  // The editor never writes a title across lines, so rewriting this block would change
  // the title's text. The note stays in Source.
  it("keeps a title that spans lines in Source mode", () => {
    const check = roundTripCheck('[text](http://a.b "line one\nline two")')
    expect(check).toMatchObject({ ok: false, refusal: "document_changes" })
  })

  it("treats an empty title as no title", () => {
    const markdown = '[text](http://a.b "")'
    expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
    expect(docToNormalizedMarkdown(parse(markdown))).toBe("[text](http://a.b)")
  })

  it("leaves a link without a title untouched", () => {
    const markdown = "A [link](https://example.com) here."
    expect(linkMarks(markdown)[0]).toMatchObject({ title: null, markdownTitleMarkup: null })
    expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
    expect(docToMarkdown(linkDoc({ href: "https://example.com" }))).toBe(
      "[text](https://example.com)",
    )
  })

  // A title that reaches the document without a source form (HTML paste, a future
  // editor field) is written in double quotes and must be read back as the same text.
  it.each([
    "Title",
    'say "hi"',
    "it's (fine)",
    "back\\slash",
    'back\\"slash',
    "ends with \\",
    "literal &amp; and &#32; references",
    "AT&T; is text",
    "\\& and \\\\",
  ])("writes a title without a source form so that it reads back: %j", (title) => {
    const markdown = docToMarkdown(linkDoc({ href: "http://a.b", title }))
    expect(markdown.startsWith('[text](http://a.b "')).toBe(true)
    expect(linkMarks(markdown)[0]).toMatchObject({ href: "http://a.b", title })
    expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
  })

  it.each(["'", "("])("escapes the closing character of a %s title", (markup) => {
    const title = "a 'b' (c) \"d\""
    const markdown = docToMarkdown(
      linkDoc({ href: "http://a.b", title, markdownTitleMarkup: markup }),
    )
    expect(linkMarks(markdown)[0]).toMatchObject({ title, markdownTitleMarkup: markup })
    expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
  })

  it("never writes a title across lines", () => {
    const markdown = docToMarkdown(linkDoc({ href: "http://a.b", title: "one\ntwo\r\n\r\nthree" }))
    expect(markdown).toBe('[text](http://a.b "one two three")')
  })
})

describe("links edited in the editor keep their title", () => {
  const editors: Editor[] = []
  afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

  function open(markdown: string) {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: schemaExtensions,
      content: markdownToDoc(markdown),
    })
    editors.push(editor)
    return editor
  }
  const written = (editor: Editor) => docToMarkdown(editor.state.doc)

  it("keeps the title when the toolbar changes the address of a link", () => {
    const editor = open("See [text](http://a.b 'Title') here.")
    // The same chain as BubbleToolbar's applyLink for a selection inside a link.
    editor.chain().setTextSelection({ from: 6, to: 8 }).run()
    editor.chain().focus().extendMarkRange("link").setLink({ href: "http://new.example" }).run()
    expect(written(editor)).toBe("See [text](http://new.example 'Title') here.")
  })

  it("does not give a title to a link the toolbar creates", () => {
    const editor = open("Plain words here.")
    editor.chain().setTextSelection({ from: 7, to: 12 }).run()
    editor.chain().focus().extendMarkRange("link").setLink({ href: "http://a.b" }).run()
    expect(written(editor)).toBe("Plain [words](http://a.b) here.")
    expect(roundTripCheck(written(editor)).ok).toBe(true)
  })

  it("does not add a title when the toolbar changes a link without one", () => {
    const editor = open("See [text](http://a.b) here.")
    editor.chain().setTextSelection({ from: 6, to: 8 }).run()
    editor.chain().focus().extendMarkRange("link").setLink({ href: "http://new.example" }).run()
    expect(written(editor)).toBe("See [text](http://new.example) here.")
  })

  it("keeps the title while the text of a link is edited", () => {
    const editor = open('See [text](http://a.b "Title") here.')
    editor.view.dispatch(editor.state.tr.insertText("x", 7))
    expect(written(editor)).toBe('See [texxt](http://a.b "Title") here.')
  })

  it("removes the title together with the link", () => {
    const editor = open('See [text](http://a.b "Title") here.')
    editor.chain().setTextSelection({ from: 6, to: 8 }).run()
    editor.chain().focus().extendMarkRange("link").unsetLink().run()
    expect(written(editor)).toBe("See text here.")
  })
})
