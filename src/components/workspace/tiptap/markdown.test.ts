import { describe, it, expect } from "vitest"
import { markdownToDoc, docToMarkdown, editorSchema } from "./markdown"

// Full public round-trip: markdown -> Tiptap JSON -> ProseMirror node -> markdown.
// Guards against silent data corruption in the on-disk format.
function roundTrip(md: string): string {
  const node = editorSchema.nodeFromJSON(markdownToDoc(md))
  return docToMarkdown(node)
}

describe("markdown <-> tiptap round-trip", () => {
  const cases: Array<[string, string]> = [
    ["heading", "# Title"],
    ["paragraph", "Just a paragraph of text."],
    ["bold and italic", "Some **bold** and *italic* text."],
    ["inline code", "Use the `cn()` helper."],
    ["bullet list", "- one\n- two\n- three"],
    ["ordered list", "1. first\n2. second"],
    ["task list", "- [ ] todo\n- [x] done"],
    ["blockquote", "> quoted line"],
    ["link", "A [link](https://example.com) here."],
    ["code block", "```ts\nconst x = 1\n```"],
    ["table", "| a | b |\n| --- | --- |\n| 1 | 2 |"],
  ]

  for (const [name, md] of cases) {
    it(`preserves ${name}`, () => {
      expect(roundTrip(md).trim()).toBe(md.trim())
    })
  }

  // The data-integrity case that matters most: wiki links and tags must survive
  // byte-for-byte (the serializer deliberately does not escape [ ] or #).
  it("preserves wiki links and tags unescaped", () => {
    const md = "See [[Other Note]] and [[Note#Heading|alias]] about #topic and #проект"
    expect(roundTrip(md).trim()).toBe(md)
  })

  it("is stable on a mixed document (idempotent re-serialization)", () => {
    const md = "# Doc\n\nText with **bold**, a [[Wiki]] link and #tag.\n\n- [ ] a\n- [x] b"
    const once = roundTrip(md)
    const twice = roundTrip(once)
    expect(twice).toBe(once)
  })

  it("preserves transclusion ![[Note]] as-is (round-trip)", () => {
    const md = "![[Other Note]]"
    expect(roundTrip(md).trim()).toBe(md)
  })

  it("strips alias and anchor from transclusion on parse, serializes base name", () => {
    // ![[Note#Heading|Alias]] → target stored as "Note" → serialized as ![[Note]]
    const result = roundTrip("![[Note#Heading|Alias]]").trim()
    expect(result).toBe("![[Note]]")
  })

  it("transclusion inside a document survives idempotent re-serialization", () => {
    const md = "# Doc\n\n![[Embedded Note]]\n\nMore text."
    const once = roundTrip(md)
    const twice = roundTrip(once)
    expect(twice).toBe(once)
  })
})
