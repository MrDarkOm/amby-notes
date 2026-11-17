import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { docToMarkdown, editorSchema, markdownToDoc, restoreSourceFormatting } from "./markdown"
import { sameDocument } from "./markdown-block-source"
import { getMarkdownParser } from "./markdown-parser"

// EDIT-06: what one 200 ms pause in Live Preview costs on a large note. A "full" parse or
// serialization is one that handles a whole note; per-block work is not counted.
const fullSerializations = vi.hoisted(() => ({ count: 0 }))
vi.mock("./markdown-serializer", async (importActual) => {
  const actual = await importActual<typeof import("./markdown-serializer")>()
  return {
    ...actual,
    serializeFragment: (content: PMNode) => {
      if (content.childCount > 100) fullSerializations.count += 1
      return actual.serializeFragment(content)
    },
  }
})

const LOREM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(8).trim()
const SECTION = [
  (i: number) => `## Heading ${i}`,
  (i: number) =>
    `Paragraph ${i} with *emphasis*, **bold** and a [link](https://example.com/${i}). ${LOREM}`,
  (i: number) => `- item ${i} a\n- item ${i} b\n  - nested ${i}`,
  (i: number) => `| a | b |\n|---|:-:|\n| ${i} |   x |\n|long cell ${i}|y|`,
  (i: number) => "```ts\nconst value" + i + " = " + i + "\n```",
  (i: number) => `1. first ${i}\n2. second ${i}`,
  (i: number) => `> quote ${i}`,
  (i: number) => `Trailing space line ${i} \ncontinues here`,
]

export function largeNote(blocks: number, eol = "\n"): string {
  const parts: string[] = []
  for (let i = 0; i < blocks; i++) parts.push(SECTION[i % SECTION.length](i))
  return parts.join("\n\n").replace(/\n/g, eol)
}

const open = (markdown: string) => editorSchema.nodeFromJSON(markdownToDoc(markdown))

function indexOfText(doc: PMNode, needle: string): number {
  let found = -1
  doc.forEach((child, _o, index) => {
    if (found < 0 && child.textContent.includes(needle)) found = index
  })
  if (found < 0) throw new Error(`no block with ${needle}`)
  return found
}

/** Types `!` right before the first occurrence of `needle`. */
function typeInto(doc: PMNode, needle: string): PMNode {
  const index = indexOfText(doc, needle)
  let from = 0
  for (let i = 0; i < index; i++) from += doc.child(i).nodeSize
  let at = -1
  doc.child(index).descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.includes(needle)) {
      at = from + pos + 1 + node.text!.indexOf(needle)
    }
  })
  return doc.replace(at, at, new Slice(Fragment.from(editorSchema.text("!")), 0, 0))
}

describe("EDIT-06 live save on a large note", () => {
  const note = largeNote(2000)
  let doc: PMNode
  beforeAll(() => {
    doc = open(note)
  })
  afterEach(() => vi.restoreAllMocks())

  function measure(edited: PMNode) {
    const parse = vi.spyOn(getMarkdownParser(), "parse")
    fullSerializations.count = 0
    const t0 = performance.now()
    const markdown = docToMarkdown(edited)
    const ms = performance.now() - t0
    const fullParses = parse.mock.calls.filter(([text]) => String(text).length > 50_000).length
    parse.mockRestore()
    return { markdown, ms, fullParses, fullSerializations: fullSerializations.count }
  }

  it("reports what one pause costs", () => {
    expect(note.length).toBeGreaterThan(100_000)
    docToMarkdown(doc) // warm-up
    // A new edit each time: nothing about the edited block is cached from the run before.
    const runs = Array.from({ length: 5 }, (_, run) =>
      measure(typeInto(doc, `Paragraph ${801 + 8 * run} `)),
    )
    const best = runs.reduce((a, b) => (a.ms < b.ms ? a : b))
    process.stderr.write(
      `EDIT-06 pause on ${note.length} bytes, ${doc.childCount} blocks: ` +
        `${best.ms.toFixed(1)} ms (best of 5), full parses ${best.fullParses}, ` +
        `full serializations ${best.fullSerializations}\n`,
    )
    expect(best.markdown.length).toBe(note.length + 1)
  })

  it("changes only the edited block's bytes", () => {
    const { markdown } = measure(typeInto(doc, "Paragraph 801 with"))
    expect(markdown).toBe(note.replace("Paragraph 801 with", "!Paragraph 801 with"))
  })

  it("does not parse or serialize the whole note for an edit", () => {
    const { fullParses, fullSerializations: serialized } = measure(typeInto(doc, "Paragraph 801 "))
    expect(fullParses).toBe(0)
    expect(serialized).toBe(0)
  })

  it("does not parse or serialize the whole note for an untouched document either", () => {
    const { fullParses, fullSerializations: serialized, markdown } = measure(doc)
    expect(markdown).toBe(note)
    expect(fullParses).toBe(0)
    expect(serialized).toBe(0)
  })
})

describe("EDIT-06 live save keeps every block that was not edited", () => {
  const SEP = "\n\n"
  const note = largeNote(120)
  const blocks = note.split(SEP)
  const doc = open(note)
  const start = (index: number) => {
    let at = 0
    for (let i = 0; i < index; i++) at += doc.child(i).nodeSize
    return at
  }
  const paragraph = (text: string) =>
    editorSchema.nodes.paragraph.create(null, editorSchema.text(text))

  function expectOnlyBlocksChanged(edited: PMNode, a: number, b: number) {
    const markdown = docToMarkdown(edited)
    const prefix = a > 0 ? blocks.slice(0, a).join(SEP) + SEP : ""
    const suffix = b < blocks.length - 1 ? SEP + blocks.slice(b + 1).join(SEP) : ""
    expect(markdown.startsWith(prefix)).toBe(true)
    expect(markdown.endsWith(suffix)).toBe(true)
    // Whatever was written reads as the document that was edited.
    expect(sameDocument(open(markdown), edited)).toBe(true)
    return markdown
  }

  it("changes the first block only", () => {
    const edited = typeInto(doc, "Heading 0")
    expect(docToMarkdown(edited)).toBe(note.replace("## Heading 0", "## !Heading 0"))
  })

  it("changes the last block only", () => {
    const last = blocks.length - 1
    const edited = typeInto(doc, `Trailing space line ${last}`)
    expect(docToMarkdown(edited)).toBe(
      note.replace(`Trailing space line ${last} \n`, `!Trailing space line ${last}\n`),
    )
  })

  it("inserts a block between two others without touching them", () => {
    const at = start(40)
    const edited = doc.replace(at, at, new Slice(Fragment.from(paragraph("Brand new")), 0, 0))
    const markdown = expectOnlyBlocksChanged(edited, 39, 40)
    expect(markdown).toContain(`${blocks[39]}${SEP}Brand new${SEP}${blocks[40]}`)
  })

  it("deletes a block without touching the others", () => {
    const edited = doc.replace(start(40), start(41), Slice.empty)
    expect(docToMarkdown(edited)).toBe(blocks.filter((_b, i) => i !== 40).join(SEP))
  })

  it("joins two blocks and keeps the rest", () => {
    // A paragraph and the heading after it become one paragraph.
    const joined = doc.replace(start(8) - 1, start(8) + 1, Slice.empty)
    expect(joined.childCount).toBe(doc.childCount - 1)
    expectOnlyBlocksChanged(joined, 7, 8)
  })

  it("rewrites an edited table and keeps the blocks around it", () => {
    const markdown = expectOnlyBlocksChanged(typeInto(doc, "long cell 51"), 51, 51)
    expect(markdown).toContain("!long cell 51")
  })

  it("rewrites an edited list and keeps the blocks around it", () => {
    const markdown = expectOnlyBlocksChanged(typeInto(doc, "item 34 a"), 34, 34)
    expect(markdown).toContain("!item 34 a")
  })

  it("edits near the start and the end in one pause", () => {
    const twice = typeInto(typeInto(doc, "Heading 8"), "Heading 112")
    expect(docToMarkdown(twice)).toBe(
      note.replace("## Heading 8", "## !Heading 8").replace("## Heading 112", "## !Heading 112"),
    )
  })

  it("restores CRLF line endings around the edit", () => {
    const crlf = note.replace(/\n/g, "\r\n")
    const untouched = restoreSourceFormatting(docToMarkdown(doc), crlf)
    expect(untouched).toBe(crlf)
    const edited = restoreSourceFormatting(docToMarkdown(typeInto(doc, "Paragraph 41 ")), crlf)
    expect(edited).toBe(crlf.replace("Paragraph 41 with", "!Paragraph 41 with"))
  })

  it("keeps a byte order mark and the whitespace at the end of lines", () => {
    const bom = `\uFEFF${note}`
    const withBom = open(bom)
    expect(docToMarkdown(withBom)).toBe(bom)
    const edited = docToMarkdown(typeInto(withBom, "Paragraph 41 "))
    expect(edited).toBe(bom.replace("Paragraph 41 with", "!Paragraph 41 with"))
    expect(edited).toContain("Trailing space line 7 \ncontinues here")
  })
})
