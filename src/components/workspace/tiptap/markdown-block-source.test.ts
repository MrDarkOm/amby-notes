// @vitest-environment happy-dom
import { Editor } from "@tiptap/core"
import { afterEach, describe, expect, it } from "vitest"
import sharedCompatibilityCorpus from "../../../../tests/fixtures/markdown-compatibility.json"
import livePreviewSafeFixture from "./fixtures/live-preview-safe.md?raw"
import malformedFrontmatterFixture from "./fixtures/malformed-frontmatter.md?raw"
import obsidianCompatFixture from "./fixtures/obsidian-compat.md?raw"
import transclusionSecurityFixture from "./fixtures/transclusion-preview-security.md?raw"
import {
  docToMarkdown,
  docToNormalizedMarkdown,
  editorSchema,
  markdownToDoc,
  restoreSourceFormatting,
  roundTripCheck,
} from "./markdown"
import { schemaExtensions } from "./schema"

const parse = (markdown: string) => editorSchema.nodeFromJSON(markdownToDoc(markdown))
/** What a save without a single edit writes. */
const reopened = (markdown: string) =>
  restoreSourceFormatting(docToMarkdown(parse(markdown)), markdown)

// The invariant of Live Preview: a note that is admitted and saved without an edit is
// the same file, byte for byte. A note that cannot promise it is not admitted.
function expectUntouchedSaveKeepsBytes(markdown: string, label = JSON.stringify(markdown)) {
  const check = roundTripCheck(markdown)
  if (check.ok) expect(reopened(markdown), label).toBe(markdown)
  return check.ok
}

function expectLive(markdown: string) {
  expect(roundTripCheck(markdown), JSON.stringify(markdown)).toEqual({ ok: true, result: markdown })
  expect(reopened(markdown)).toBe(markdown)
}

/** Forms the editor reads but writes differently: they open in Live and keep their bytes. */
const AUDIT_CASES: Array<[string, string]> = [
  ["an escaped list marker", "1\\. not a list\n\n\\- not a bullet either"],
  ["a space before a soft line break", "first line \nsecond line"],
  ["a sparse bullet list", "- one\n\n- two\n\n- three"],
  ["a sparse ordered list", "1. one\n\n2. two"],
  ["a list nested with a tab", "- parent\n\t- child\n\t- second child"],
  ["a list nested with four spaces", "- parent\n    - child"],
  ["a spaced horizontal rule", "before\n\n* * *\n\nafter"],
  ["an underscore horizontal rule", "before\n\n___\n\nafter"],
  ["a setext heading", "Title\n=====\n\nSubtitle\n--------\n\ntext"],
  ["a heading with a closing sequence", "## Title ##\n\ntext"],
  ["a lowercase callout", "> [!tip] Title\n> body"],
  ["a table with uneven cells", "| a | b |\n|---|:-:|\n| 1 |   2 |\n|long cell|x|"],
  ["a table with a short aligned delimiter", "| a | b |\n|:-|-:|\n| 1\\|2 | x |"],
  [
    "blocks without a blank line between them",
    "# Heading\ntext\n- one\n- two\n> quote\n```\ncode\n```\ntail",
  ],
  ["the `)` list delimiter", "1) one\n2) two"],
  ["an ordered list numbered with ones", "1. one\n1. two\n1. three"],
  ["an indented code block", "text\n\n    code line\n    second\n\ntail"],
  ["a tilde fence", "~~~\ncode\n~~~"],
  ["mixed emphasis markers", "***both*** and __strong__ and _em_"],
  ["an autolink", "See <https://example.com/a>."],
  ["a hard break written with spaces", "first  \nsecond"],
  ["character references", "&copy; 2026 &amp; &#42;"],
  ["a paragraph that starts with spaces", "   indented text\n\nnext"],
  ["a link title with spare spaces", '[text](http://a.b  "Title")'],
  ["a link title with a reference inside", '[text](http://a.b "a &quot;b&quot;")'],
  ["a link address in angle brackets", '[text](<http://a.b> "Title")'],
  ["an image title in single quotes", "![alt](assets/a.png 'Image title')"],
  ["an image title in parentheses", "![alt](assets/a.png (Image title))"],
  ["a line of spaces between blocks", "first\n   \nsecond\n\t\nthird"],
  ["several blank lines and odd forms together", "Title\n===\n\n\n* a\n\n* b\n\n\n\n1\\. x  \ny"],
  ["Windows line endings", "Title\r\n===\r\n\r\n* a\r\n\r\n* b\r\n"],
  ["leading and trailing blank lines", "\n\n* * *\n\ntext \nmore\n\n\n"],
]

/** Notes that must stay in Source: something in them would be lost by rebuilding a block. */
const SOURCE_ONLY: Array<[string, string]> = [
  ["a footnote", "Text.[^1]\n\n[^1]: Body."],
  ["an inline footnote", "Text.^[Inline.]"],
  ["a link definition between blocks", "Read [a][b].\n\n[b]: http://a.b\n\nMore text."],
  ["a link definition at the end", "Read [a][b].\n\n[b]: http://a.b"],
  ["a link definition at the start", "[b]: http://a.b\n\nRead [a][b]."],
  ["a link definition nothing refers to", "Text.\n\n[unused]: http://a.b\n\nMore."],
  ["a link definition inside a quote", "> Read [a][b].\n>\n> [b]: http://a.b"],
  ["a link definition inside a list item", "- Read [a][b].\n\n  [b]: http://a.b"],
  ["a code fence with more than a language", '```js title="example.js"\ncode\n```'],
]

describe("a save without edits keeps the file", () => {
  it.each(AUDIT_CASES)("opens in Live and keeps the bytes of %s", (_name, markdown) => {
    expectLive(markdown)
  })

  it.each(SOURCE_ONLY)("keeps a note in Source: %s", (_name, markdown) => {
    expect(roundTripCheck(markdown).ok).toBe(false)
  })

  it("holds for every fixture", () => {
    expect(expectUntouchedSaveKeepsBytes(livePreviewSafeFixture)).toBe(true)
    expect(expectUntouchedSaveKeepsBytes(transclusionSecurityFixture)).toBeTypeOf("boolean")
    // Footnotes keep the Obsidian fixture in Source, with and without its frontmatter.
    expect(expectUntouchedSaveKeepsBytes(obsidianCompatFixture)).toBe(false)
    const body = obsidianCompatFixture.replace(/^---\n[\s\S]*?\n---\n/u, "")
    expect(expectUntouchedSaveKeepsBytes(body)).toBe(false)
    expect(expectUntouchedSaveKeepsBytes(malformedFrontmatterFixture)).toBeTypeOf("boolean")
  })

  it("holds for the shared indexing corpus", () => {
    for (const fixture of sharedCompatibilityCorpus) {
      expectUntouchedSaveKeepsBytes(fixture.markdown, fixture.name)
    }
  })

  it("holds for a generated corpus of clean and odd blocks", () => {
    const blocks = [
      ...AUDIT_CASES.map(([, markdown]) => markdown).filter((markdown) => !markdown.includes("\r")),
      "# Heading",
      "Plain text with **bold** and `code`.",
      "- first\n- second",
      "- [ ] todo\n- [x] done",
      "> quoted text",
      "See [[Target#Heading|alias]] and #topic.",
      "```unknown\nvalue\n```",
      "> [!TIP]+ Expanded\n> Helpful text.",
      "<details>\n<summary>More</summary>\ncontent\n</details>",
      "<!-- amby:columns -->\n\n<!-- amby:column -->\n\nleft\n\n<!-- amby:column -->\n\nright\n\n<!-- /amby:columns -->",
      "Text.[^1]",
      "[ref]: http://a.b",
    ]
    const separators = ["\n\n", "\n\n", "\n\n\n", "\n"]
    let seed = 0x5eeda11
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed
    }
    let admitted = 0
    for (let index = 0; index < 400; index++) {
      const count = (next() % 5) + 1
      let document = ""
      for (let block = 0; block < count; block++) {
        if (block) document += separators[next() % separators.length]
        document += blocks[next() % blocks.length]
      }
      if (
        expectUntouchedSaveKeepsBytes(document, `document ${index}: ${JSON.stringify(document)}`)
      ) {
        admitted++
        // What the editor would write if every block were rebuilt reads back as the same
        // document, so no later edit can change the meaning of a block it rewrites.
        const normalized = docToNormalizedMarkdown(parse(document))
        expect(roundTripCheck(normalized).ok, `document ${index}`).toBe(true)
      }
    }
    expect(admitted).toBeGreaterThan(100)
  })
})

describe("what a rewritten block keeps", () => {
  // The parser reads these, the serializer spells them its own way; nothing may be lost
  // on the way. (A link title once was: the parser dropped it while reading.)
  it.each([
    [
      "an image title in single quotes",
      "![alt](a.png 'Image title')",
      '![alt](a.png "Image title")',
    ],
    [
      "an image title in parentheses",
      "![alt](a.png (It's a title))",
      '![alt](a.png "It\'s a title")',
    ],
    [
      "the alignment of a short table delimiter",
      "| a | b |\n|:-|-:|\n| 1\\|2 | x |",
      "| a | b |\n| :--- | ---: |\n| 1\\|2 | x |",
    ],
    ["the language of a tilde fence", "~~~python\nprint()\n~~~", "```python\nprint()\n```"],
    ["the number an ordered list starts at", "7) seven\n8) eight", "7. seven\n8. eight"],
    ["the level of a setext heading", "Title\n-----", "## Title"],
    ["a hard break written with spaces", "first  \nsecond", "first\\\nsecond"],
    [
      "the address of an autolink",
      "<https://example.com/a>",
      "[https://example.com/a](https://example.com/a)",
    ],
  ])("keeps %s", (_name, source, rewritten) => {
    expectLive(source)
    expect(docToNormalizedMarkdown(parse(source)).replace(/\n+$/u, "")).toBe(rewritten)
    expectLive(rewritten)
  })
})

describe("an edit rewrites only the block it touches", () => {
  const editors: Editor[] = []
  afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

  const SOURCE = [
    "Title",
    "=====",
    "",
    "1\\. first paragraph ",
    "of two lines",
    "",
    "",
    "* one",
    "",
    "* two",
    "",
    "* * *",
    "middle paragraph",
    "",
    "| a | b |",
    "|---|:-:|",
    "| 1 |   2 |",
    "",
    "last paragraph",
  ].join("\n")

  function open(markdown: string) {
    expect(roundTripCheck(markdown).ok).toBe(true)
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: schemaExtensions,
      content: markdownToDoc(markdown),
    })
    editors.push(editor)
    return editor
  }
  const saved = (editor: Editor, original = SOURCE) =>
    restoreSourceFormatting(docToMarkdown(editor.state.doc), original)
  /** Position inside the text of the top-level block that contains `text`. */
  function positionOf(editor: Editor, text: string): number {
    let found = -1
    editor.state.doc.descendants((node, pos) => {
      if (found < 0 && node.isText && node.text?.includes(text)) {
        found = pos + node.text.indexOf(text)
      }
    })
    expect(found).toBeGreaterThan(0)
    return found
  }
  function blockAt(editor: Editor, text: string) {
    const $pos = editor.state.doc.resolve(positionOf(editor, text))
    return { from: $pos.before(1), to: $pos.after(1), node: $pos.node(1) }
  }

  it("writes nothing new when nothing was edited", () => {
    expect(saved(open(SOURCE))).toBe(SOURCE)
  })

  it("rewrites the edited paragraph and nothing else", () => {
    const editor = open(SOURCE)
    editor.view.dispatch(editor.state.tr.insertText("!", positionOf(editor, "middle") + 6))
    // The paragraph stood right under the rule; a rewritten block gets the usual blank line.
    expect(saved(editor)).toBe(
      SOURCE.replace("* * *\nmiddle paragraph", "* * *\n\nmiddle! paragraph"),
    )
  })

  it("rewrites an edited block in the form the editor writes", () => {
    const editor = open(SOURCE)
    editor.view.dispatch(editor.state.tr.insertText("!", positionOf(editor, "one") + 3))
    // The sparse `*` list becomes the editor's own tight form; its neighbours stay.
    expect(saved(editor)).toBe(SOURCE.replace("* one\n\n* two", "* one!\n* two"))
  })

  it("gives the original bytes back after undo", () => {
    const editor = open(SOURCE)
    editor.view.dispatch(editor.state.tr.insertText("!", positionOf(editor, "one") + 3))
    expect(saved(editor)).not.toBe(SOURCE)
    editor.commands.undo()
    expect(saved(editor)).toBe(SOURCE)
  })

  it("gives the original bytes back when the edit is typed away", () => {
    const editor = open(SOURCE)
    const at = positionOf(editor, "Title") + 5
    editor.view.dispatch(editor.state.tr.insertText("!", at))
    expect(saved(editor)).toBe(SOURCE.replace("Title\n=====", "# Title!"))
    editor.view.dispatch(editor.state.tr.delete(at, at + 1))
    expect(saved(editor)).toBe(SOURCE)
  })

  it("removes a deleted block and keeps the others", () => {
    const editor = open(SOURCE)
    const { from, to } = blockAt(editor, "middle")
    editor.view.dispatch(editor.state.tr.delete(from, to))
    expect(saved(editor)).toBe(SOURCE.replace("* * *\nmiddle paragraph\n", "* * *\n"))
  })

  it("moves a block with its bytes", () => {
    const editor = open(SOURCE)
    const { from, to, node } = blockAt(editor, "one")
    const tr = editor.state.tr.delete(from, to)
    tr.insert(tr.doc.content.size, node)
    editor.view.dispatch(tr)
    const markdown = saved(editor)
    expect(markdown.endsWith("last paragraph\n\n* one\n\n* two")).toBe(true)
    expect(markdown).toContain("Title\n=====\n\n1\\. first paragraph \nof two lines\n")
    expect(markdown).toContain("| a | b |\n|---|:-:|\n| 1 |   2 |\n\nlast paragraph")
    expect(parse(markdown).textContent).toBe(editor.state.doc.textContent)
  })

  it("duplicates a block with its bytes", () => {
    const editor = open(SOURCE)
    const { to, node } = blockAt(editor, "b")
    expect(node.type.name).toBe("table")
    editor.view.dispatch(editor.state.tr.insert(to, node))
    const table = "| a | b |\n|---|:-:|\n| 1 |   2 |"
    expect(saved(editor)).toBe(SOURCE.replace(table, `${table}\n\n${table}`))
  })

  it("rewrites both halves of a paragraph that was split", () => {
    const editor = open(SOURCE)
    editor.commands.setTextSelection(positionOf(editor, "of two"))
    editor.commands.splitBlock()
    const markdown = saved(editor)
    expect(markdown).toContain("Title\n=====\n\n")
    expect(markdown).toContain("* one\n\n* two\n\n* * *\nmiddle paragraph")
    expect(parse(markdown).childCount).toBe(parse(SOURCE).childCount + 1)
  })

  it("keeps the bytes of a note the editor reloads through JSON", () => {
    const editor = open(SOURCE)
    editor.commands.setContent(editor.getJSON(), { emitUpdate: false })
    expect(saved(editor)).toBe(SOURCE)
  })

  // A block kept as source must not change what its neighbours mean. When it would,
  // the whole note is written in the editor's own form instead.
  it("never lets kept source swallow a block typed after it", () => {
    const source = "text\n\n```\nunterminated code"
    const editor = open(source)
    const end = editor.state.doc.content.size
    editor.view.dispatch(
      editor.state.tr.insert(
        end,
        editor.schema.nodes.paragraph.create(null, editor.schema.text("new")),
      ),
    )
    const markdown = saved(editor, source)
    expect(markdown).toBe("text\n\n```\nunterminated code\n```\n\nnew")
    expect(parse(markdown).lastChild?.type.name).toBe("paragraph")
    expect(parse(markdown).lastChild?.textContent).toBe("new")
  })

  it("never lets a moved block join the list before it", () => {
    const source = "- item\n\ntail\n\n   indented paragraph"
    const editor = open(source)
    const { from, to } = blockAt(editor, "tail")
    editor.view.dispatch(editor.state.tr.delete(from, to))
    const markdown = saved(editor, source)
    const doc = parse(markdown)
    expect(doc.childCount).toBe(2)
    expect(doc.child(1).type.name).toBe("paragraph")
  })
})
