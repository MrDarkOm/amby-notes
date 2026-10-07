import { describe, expect, it } from "vitest"
import { docToMarkdown, editorSchema, markdownToDoc, roundTripCheck } from "./markdown"

// What the editor writes for text a user typed must be read back as that same text,
// because a note it cannot read back is opened in Source mode the next time.
type Json = Record<string, unknown>
const text = (value: string, mark?: string): Json => ({
  type: "text",
  text: value,
  ...(mark ? { marks: [{ type: mark }] } : {}),
})
const paragraph = (...content: Json[]): Json => ({ type: "paragraph", content })
const doc = (...content: Json[]) => editorSchema.nodeFromJSON({ type: "doc", content })

function written(...blocks: Json[]): string {
  return docToMarkdown(doc(...blocks))
}

function expectReadBack(markdown: string, typed: string) {
  expect(roundTripCheck(markdown), JSON.stringify(markdown)).toEqual({ ok: true, result: markdown })
  expect(editorSchema.nodeFromJSON(markdownToDoc(markdown)).textContent).toBe(typed)
}

describe("text typed in Live Preview is read back as typed", () => {
  it.each([
    [" Начало", "&#32;Начало"],
    ["   Начало", "&#32;  Начало"],
    ["     Начало", "&#32;    Начало"],
    ["\tНачало", "&#9;Начало"],
    [" Начало", "&#160;Начало"],
    [" ", "&#32;"],
    ["   ", "&#32;  "],
    [" ", "&#160;"],
  ])("keeps whitespace at the start of a paragraph: %j", (typed, expected) => {
    const markdown = written(paragraph(text(typed)), paragraph(text("tail")))
    expect(markdown).toBe(`${expected}\n\ntail`)
    expectReadBack(markdown, `${typed}tail`)
  })

  it("keeps whitespace at the start of a heading, a list item, a quote and after a line break", () => {
    for (const [block, expected] of [
      [{ type: "heading", attrs: { level: 2 }, content: [text(" T")] }, "## &#32;T"],
      [
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [paragraph(text(" a"))] }],
        },
        "- &#32;a",
      ],
      [{ type: "blockquote", content: [paragraph(text(" a"))] }, "> &#32;a"],
      [paragraph(text("a"), { type: "hardBreak" }, text("  b")), "a\\\n&#32; b"],
    ] as Array<[Json, string]>) {
      const markdown = written(block, paragraph(text("tail")))
      expect(markdown).toBe(`${expected}\n\ntail`)
      expect(roundTripCheck(markdown).ok, markdown).toBe(true)
    }
  })

  it.each([
    ["1) a", "1\\) a"],
    ["1. a", "1\\. a"],
    ["+ a", "\\+ a"],
    ["> a", "\\> a"],
    ["# a", "\\# a"],
    ["<b>", "\\<b>"],
    ["&#32;", "\\&#32;"],
    ["&amp;", "\\&amp;"],
  ])("escapes text that would open a block or a reference: %j", (typed, expected) => {
    const markdown = written(paragraph(text(typed)), paragraph(text("tail")))
    expect(markdown).toBe(`${expected}\n\ntail`)
    expectReadBack(markdown, `${typed}tail`)
  })

  it("escapes a line that starts like a block after a hard break", () => {
    const markdown = written(paragraph(text("a"), { type: "hardBreak" }, text("- b")))
    expect(markdown).toBe("a\\\n\\- b")
    expect(roundTripCheck(markdown).ok).toBe(true)
  })

  it("does not take a trailing `#` of a heading for a closing sequence", () => {
    for (const typed of ["#", "a #", "a ##"]) {
      const markdown = written({ type: "heading", attrs: { level: 1 }, content: [text(typed)] })
      expectReadBack(markdown, typed)
    }
    // Ordinary headings are untouched: no escape where `#` is part of a word.
    expect(written({ type: "heading", attrs: { level: 1 }, content: [text("Issue #12")] })).toBe(
      "# Issue #12",
    )
  })

  it("keeps a space typed after the task marker", () => {
    const markdown = written({
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [paragraph(text(" a"))],
        },
      ],
    })
    expect(markdown).toBe("- [ ] &#32;a")
    expectReadBack(markdown, " a")
  })

  it("leaves ordinary text byte-identical", () => {
    for (const markdown of [
      "Привет, мир",
      "a b  c",
      "Issue #12 and 3) and a > b",
      "x & y",
      "AT&T;",
    ]) {
      expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
      expect(docToMarkdown(editorSchema.nodeFromJSON(markdownToDoc(markdown)))).toBe(markdown)
    }
  })

  // A deterministic sweep of typed text built from characters that matter to Markdown.
  it("reads back every document made of typed text and marks", () => {
    let seed = 987
    const random = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n
    const atoms = [
      "a",
      "Б",
      " ",
      " ",
      "  ",
      "\t",
      " ",
      " ",
      "*",
      "_",
      "#",
      ">",
      "-",
      "+",
      "1.",
      "1)",
      "`",
      "\\",
      "[",
      "]",
      "|",
      "&",
      "~",
      "!",
      "=",
      "---",
      "&#32;",
      "&amp;",
      "[[x]]",
      "#tag",
      "$$",
      "(",
      ")",
      "😀",
    ]
    const typed = () => {
      let value = ""
      for (let count = 1 + random(4); count > 0; count--) value += atoms[random(atoms.length)]
      return value
    }
    // Emphasis is applied to words: a punctuation mark at the edge of an emphasised run
    // followed by a letter (`**)**a`) is not a valid closing delimiter in CommonMark.
    const word = () => ["a", "Б", "a b", " a", "a "][random(5)]
    const inline = (): Json[] => {
      const out: Json[] = []
      for (let count = 1 + random(3); count > 0; count--) {
        if (random(8) === 0 && out.length) out.push({ type: "hardBreak" })
        else {
          const mark = [undefined, undefined, undefined, "bold", "italic", "code", "strike"][
            random(7)
          ]
          out.push(text(mark ? word() : typed(), mark))
        }
      }
      return out
    }
    const block = (depth: number): Json => {
      switch (random(depth > 1 ? 3 : 7)) {
        case 0:
        case 1:
          return paragraph(...inline())
        case 2:
          return { type: "heading", attrs: { level: 1 + random(3) }, content: [text(typed())] }
        case 3:
          return {
            type: "bulletList",
            content: [{ type: "listItem", content: [block(depth + 1)] }],
          }
        case 4:
          return {
            type: "orderedList",
            attrs: { start: 1 },
            content: [{ type: "listItem", content: [block(depth + 1)] }],
          }
        case 5:
          return { type: "blockquote", content: [block(depth + 1)] }
        default:
          return {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { checked: false },
                content: [paragraph(...inline())],
              },
            ],
          }
      }
    }
    let checked = 0
    for (let index = 0; index < 3000; index++) {
      let node
      try {
        node = doc(block(0), paragraph(text("tail")))
        node.check()
      } catch {
        continue
      }
      const markdown = docToMarkdown(node)
      checked++
      expect(roundTripCheck(markdown).ok, JSON.stringify(markdown)).toBe(true)
      expect(editorSchema.nodeFromJSON(markdownToDoc(markdown)).textContent, markdown).toBe(
        node.textContent,
      )
    }
    expect(checked).toBeGreaterThan(1500)
  })
})
