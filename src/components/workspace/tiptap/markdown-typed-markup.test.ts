import type { Node as PMNode } from "@tiptap/pm/model"
import { describe, expect, it } from "vitest"
import { docToMarkdown, editorSchema, markdownToDoc, roundTripCheck } from "./markdown"

// Text typed in Live Preview that merely looks like Markdown markup must be read back as
// the same document: the same nodes and marks, not just the same text. Compared as JSON,
// without the spelling (source text, markup characters) it keeps once it has been read from a file.
type Json = Record<string, unknown>
const text = (value: string, ...marks: Json[]): Json => ({
  type: "text",
  text: value,
  ...(marks.length ? { marks } : {}),
})
const paragraph = (...content: Json[]): Json => ({ type: "paragraph", content })
const image = (attrs: Json): Json => ({ type: "image", attrs })
const doc = (...content: Json[]) => editorSchema.nodeFromJSON({ type: "doc", content })

function structure(node: PMNode): string {
  return JSON.stringify(node.toJSON(), (key, value: unknown) =>
    key.startsWith("markdown") ? undefined : value,
  )
}

function readBack(markdown: string): PMNode {
  return editorSchema.nodeFromJSON(markdownToDoc(markdown))
}

/** Writes the document, reads it back, and expects the very same document. */
function expectSameAfterSave(typed: PMNode): string {
  const markdown = docToMarkdown(typed)
  expect(structure(readBack(markdown)), markdown).toBe(structure(typed))
  // What was written must also be admitted to Live Preview as it stands.
  expect(roundTripCheck(markdown), markdown).toEqual({ ok: true, result: markdown })
  return markdown
}

describe("typed text that looks like markup stays text", () => {
  it.each([
    ["[черновик](todo)", "[черновик]\\(todo)"],
    ["see [a](b) and [c](d)", "see [a]\\(b) and [c]\\(d)"],
    ["a <b> c", "a \\<b> c"],
    ["x <!-- позже --> y", "x \\<!-- позже --> y"],
    ["<https://example.com> and </b> and <?x>", "\\<https://example.com> and \\</b> and \\<?x>"],
  ])("escapes only what would be read as markup: %j", (typed, expected) => {
    expect(expectSameAfterSave(doc(paragraph(text(typed))))).toBe(expected)
  })

  it.each(["a ] b [ c", "1 < 2 and 3 > 2", "[[wiki link]] and [x]", "tags < >"])(
    "leaves brackets and angle brackets that mean nothing as typed: %j",
    (typed) => {
      expect(expectSameAfterSave(doc(paragraph(text(typed))))).toBe(typed)
    },
  )

  it.each([
    ["see [^1] here", "see \\[^1] here"],
    ["a ^[inline note] b", "a ^\\[inline note] b"],
  ])("keeps typed footnote syntax text: %j", (typed, expected) => {
    expect(expectSameAfterSave(doc(paragraph(text(typed))))).toBe(expected)
  })

  it("keeps a link-looking text split over marks as text", () => {
    const typed = doc(paragraph(text("["), text("a", { type: "bold" }), text("](b)")))
    expect(expectSameAfterSave(typed)).toBe("[**a**]\\(b)")
  })

  it("keeps markup-looking text inside a heading, a list item and a quote", () => {
    for (const wrap of [
      (inner: Json): Json => ({ type: "heading", attrs: { level: 2 }, content: [inner] }),
      (inner: Json): Json => ({
        type: "bulletList",
        content: [{ type: "listItem", content: [paragraph(inner)] }],
      }),
      (inner: Json): Json => ({ type: "blockquote", content: [paragraph(inner)] }),
    ]) {
      expectSameAfterSave(doc(wrap(text("[draft](todo) and a <b> c <!-- later -->"))))
    }
  })

  it("keeps typed link text next to a real link", () => {
    const link = { type: "link", attrs: { href: "https://example.com" } }
    expectSameAfterSave(doc(paragraph(text("[a](b) "), text("go", link))))
  })
})

describe("addresses and image labels typed in Live Preview", () => {
  it("writes an address with a space as <…> so it stays a link", () => {
    const typed = doc(paragraph(text("go", { type: "link", attrs: { href: "my file.md" } })))
    const markdown = docToMarkdown(typed)
    expect(markdown).toBe("[go](<my file.md>)")
    const reread = readBack(markdown)
    const mark = reread.firstChild?.firstChild?.marks[0]
    expect(mark?.type.name).toBe("link")
    // A reader encodes the space; the block, untouched, is then written as it was read.
    expect(mark?.attrs.href).toBe("my%20file.md")
    expect(docToMarkdown(reread)).toBe(markdown)
    expect(roundTripCheck(markdown).ok).toBe(true)
  })

  it("writes an image address with a space as <…> so it stays an image", () => {
    const markdown = docToMarkdown(doc(paragraph(image({ src: "a b.png", alt: "x" }))))
    expect(markdown).toBe("![x](<a b.png>)")
    const reread = readBack(markdown).firstChild?.firstChild
    expect(reread?.type.name).toBe("image")
    expect(reread?.attrs.src).toBe("a%20b.png")
    expect(reread?.attrs.alt).toBe("x")
  })

  it("keeps an address that begins with < an address", () => {
    const typed = doc(paragraph(text("go", { type: "link", attrs: { href: "<odd" } })))
    const markdown = docToMarkdown(typed)
    const mark = readBack(markdown).firstChild?.firstChild?.marks[0]
    expect(mark?.type.name).toBe("link")
    expect(mark?.attrs.href).toBe("%3Codd")
  })

  it("keeps an address with parentheses as it was", () => {
    const typed = doc(paragraph(text("go", { type: "link", attrs: { href: "a(b)c" } })))
    expectSameAfterSave(typed)
  })

  it.each(["x\\", "x\\y", "a*b", "x]y", "x[y", "[x]", "a <b> c", "[a](b)"])(
    "reads an image label back as typed: %j",
    (alt) => {
      expectSameAfterSave(doc(paragraph(image({ src: "a.png", alt }))))
    },
  )

  it("keeps a label that ends with a backslash when a size follows", () => {
    const markdown = docToMarkdown(
      doc(paragraph(image({ src: "a.png", alt: "x\\", width: 100, hasPipe: true }))),
    )
    const reread = readBack(markdown).firstChild?.firstChild
    expect(reread?.type.name).toBe("image")
    expect(reread?.attrs).toMatchObject({ alt: "x\\", width: 100 })
  })
})
