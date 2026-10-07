import { describe, expect, it } from "vitest"
import {
  docToMarkdown,
  docToNormalizedMarkdown,
  editorSchema,
  markdownToDoc,
  roundTripCheck,
} from "./markdown"

type Json = Record<string, unknown>
const parse = (markdown: string) => editorSchema.nodeFromJSON(markdownToDoc(markdown))
const paragraph = (value: string): Json => ({
  type: "paragraph",
  content: [{ type: "text", text: value }],
})
const item = (...content: Json[]): Json => ({ type: "listItem", content })
const orderedList = (items: Json[], attrs?: Json): Json => ({
  type: "orderedList",
  ...(attrs ? { attrs } : {}),
  content: items,
})
const written = (...blocks: Json[]) =>
  docToMarkdown(editorSchema.nodeFromJSON({ type: "doc", content: blocks }))

const numbered = (count: number, line: (n: number) => string, start = 1) =>
  Array.from({ length: count }, (_, index) => line(start + index)).join("\n")
const unpadded = (count: number, start = 1) => numbered(count, (n) => `${n}. item ${n}`, start)
const padded = (count: number, start = 1) => {
  const width = String(start + count - 1).length
  return numbered(count, (n) => `${String(n).padStart(width)}. item ${n}`, start)
}

function expectLive(markdown: string) {
  expect(roundTripCheck(markdown), JSON.stringify(markdown)).toEqual({ ok: true, result: markdown })
}

describe("ordered list numbers", () => {
  it.each([
    ["ten items", unpadded(10)],
    ["twelve items", unpadded(12)],
    ["a hundred and one items", unpadded(101)],
    ["a list that starts at 8", unpadded(4, 8)],
    ["a list that starts at 98", unpadded(4, 98)],
    ["nine items", unpadded(9)],
  ])("keeps an unpadded list as written: %s", (_name, markdown) => {
    expectLive(markdown)
    expect(markdown).not.toMatch(/^ /mu)
  })

  it.each([
    ["ten items", padded(10)],
    ["twelve items", padded(12)],
    ["a hundred and one items", padded(101)],
    ["a list that starts at 8", padded(4, 8)],
  ])("keeps a list the editor padded earlier as written: %s", (_name, markdown) => {
    expect(markdown).toMatch(/^ +\d+\. /mu)
    expectLive(markdown)
    expect(parse(markdown).firstChild?.attrs.markdownPadded).toBe(true)
  })

  it("does not mark a list whose numbers all have one width", () => {
    expect(parse(unpadded(9)).firstChild?.attrs.markdownPadded).toBeNull()
    expect(parse(unpadded(10)).firstChild?.attrs.markdownPadded).toBeNull()
    expect(parse(unpadded(3, 10)).firstChild?.attrs.markdownPadded).toBeNull()
  })

  it("keeps the continuation indent of multi-line and nested items, unpadded", () => {
    const markdown = [
      "1. first",
      "   - nested bullet",
      "   - another",
      "2. second",
      "",
      "   second paragraph of the item",
      "3. third\\",
      "   after a line break",
      ...Array.from({ length: 6 }, (_, index) => `${index + 4}. item`),
      "10. tenth",
      "    - nested under a two-digit number",
      "    1. nested ordered",
      "    2. list",
      "11. eleventh\\",
      "    after a line break",
      "12. twelfth",
      "",
      "    second paragraph of the item",
    ].join("\n")
    expectLive(markdown)
  })

  it("keeps the continuation indent of multi-line and nested items, padded", () => {
    const markdown = [
      " 1. first",
      "    - nested bullet",
      "    - another",
      " 2. second",
      "",
      "    second paragraph of the item",
      " 3. third\\",
      "    after a line break",
      ...Array.from({ length: 6 }, (_, index) => ` ${index + 4}. item`),
      "10. tenth",
      "    - nested under a two-digit number",
      "     1. nested padded list",
      ...Array.from({ length: 8 }, (_, index) => `     ${index + 2}. item`),
      "    10. tenth nested",
      "11. eleventh\\",
      "    after a line break",
    ].join("\n")
    expectLive(markdown)
  })

  it("keeps nested and quoted lists of ten items in either form", () => {
    const indent = (text: string, prefix: string) =>
      text
        .split("\n")
        .map((line) => prefix + line)
        .join("\n")
    for (const list of [unpadded(11), padded(11)]) {
      expectLive(`- parent\n${indent(list, "  ")}\n- sibling`)
      expectLive(indent(list, "> "))
      expectLive(`1. parent\n${indent(list, "   ")}\n2. sibling`)
      expectLive(`# Heading\n\n${list}\n\nText after.`)
    }
  })

  it("keeps two lists split by an empty block, each in its own form", () => {
    expectLive(`${unpadded(10)}\n\n\n${padded(10)}`)
    expectLive(`${padded(10)}\n\n\n${unpadded(10)}`)
  })

  it("writes a list typed in the editor without padding", () => {
    const items = Array.from({ length: 12 }, (_, index) => item(paragraph(`item ${index + 1}`)))
    const markdown = written(orderedList(items))
    expect(markdown).toBe(unpadded(12))
    expectLive(markdown)
  })

  it("indents what follows the first line of a typed item by the width of its own number", () => {
    const items = Array.from({ length: 10 }, (_, index) => item(paragraph(`item ${index + 1}`)))
    items[8] = item(paragraph("ninth"), paragraph("more"))
    items[9] = item(paragraph("tenth"), paragraph("more"))
    const markdown = written(orderedList(items))
    expect(markdown).toContain("9. ninth\n\n   more\n10. tenth\n\n    more")
    expectLive(markdown)
    expect(parse(markdown).firstChild?.childCount).toBe(10)
  })

  it("keeps padding a padded list that grows and stops when one width remains", () => {
    const list = parse(padded(10)).firstChild!
    const extra = editorSchema.nodeFromJSON(item(paragraph("item 11")))
    const grown = list.copy(list.content.addToEnd(extra))
    expect(docToMarkdown(editorSchema.topNodeType.create(null, grown))).toBe(padded(11))
    const shrunk = list.copy(list.content.cut(0, list.content.size - list.lastChild!.nodeSize))
    expect(docToMarkdown(editorSchema.topNodeType.create(null, shrunk))).toBe(unpadded(9))
  })

  // Forms that are neither of the two open in Live too: the list keeps its bytes until
  // it is edited, and is then written without padding, numbered from its first number.
  it.each([
    ["half padded", ` 1. a\n${numbered(8, (n) => `${n}. a`, 2)}\n10. a`],
    ["wide indent of a nested block", `${unpadded(9)}\n10. a\n     - nested`],
    ["every number is 1", numbered(10, () => "1. a")],
    ["the `)` delimiter", numbered(10, (n) => `${n}) a`)],
  ])("keeps the bytes of a list it would write differently: %s", (_name, markdown) => {
    expectLive(markdown)
    const rewritten = docToNormalizedMarkdown(parse(markdown))
    expect(rewritten).not.toBe(markdown)
    expect(parse(rewritten).textContent).toBe(parse(markdown).textContent)
    expectLive(rewritten)
  })
})
