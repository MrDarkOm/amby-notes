import { describe, it, expect } from "vitest"
import {
  markdownToDoc,
  docToMarkdown,
  editorSchema,
  restoreSourceFormatting,
  roundTripCheck,
} from "./markdown"
import obsidianCompatFixture from "./fixtures/obsidian-compat.md?raw"
import livePreviewSafeFixture from "./fixtures/live-preview-safe.md?raw"
import malformedFrontmatterFixture from "./fixtures/malformed-frontmatter.md?raw"
import {
  docSelectionToMarkdownSelection,
  markdownSelectionToDocSelection,
} from "./markdown-selection"

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

  it("keeps every syntax admitted to Live Preview byte-exact", () => {
    const result = roundTripCheck(livePreviewSafeFixture)
    expect(result.ok, result.result).toBe(true)
  })

  it("preserves terminal blank lines that are not represented in the ProseMirror document", () => {
    expect(restoreSourceFormatting("Text", "Text\n\n")).toBe("Text\n\n")
    expect(roundTripCheck("Text\n").ok).toBe(true)
    expect(roundTripCheck("Text\n\n").ok).toBe(true)
  })

  it("preserves leading blank lines that are not represented in the ProseMirror document", () => {
    expect(restoreSourceFormatting("Text", "\n\nText")).toBe("\n\nText")
    expect(roundTripCheck("\n\nText").ok).toBe(true)
  })

  it("restores consistent CRLF formatting after visual serialization", () => {
    const crlfFixture = livePreviewSafeFixture.replace(/\n/g, "\r\n")
    expect(roundTripCheck(crlfFixture).ok).toBe(true)
    expect(restoreSourceFormatting("One\nTwo", "One\r\nTwo\r\n")).toBe("One\r\nTwo\r\n")
  })

  it("keeps mixed line endings in Source mode pending the token-level model", () => {
    expect(roundTripCheck("One\r\nTwo\n").ok).toBe(false)
  })

  it("keeps the Live Preview fixture stable across repeated serialization", () => {
    const once = roundTrip(livePreviewSafeFixture)
    expect(roundTrip(once)).toBe(once)
  })

  it("preserves transclusion ![[Note]] as-is (round-trip)", () => {
    const md = "![[Other Note]]"
    expect(roundTrip(md).trim()).toBe(md)
  })

  it("preserves transclusion alias and anchor while using the base target for preview", () => {
    const result = roundTrip("![[Note#Heading|Alias]]").trim()
    expect(result).toBe("![[Note#Heading|Alias]]")
  })

  it("transclusion inside a document survives idempotent re-serialization", () => {
    const md = "# Doc\n\n![[Embedded Note]]\n\nMore text."
    const once = roundTrip(md)
    const twice = roundTrip(once)
    expect(twice).toBe(once)
  })

  it("preserves a raw HTML block as an opaque Live Preview node", () => {
    const rawHtml = '<iframe src="https://example.com"></iframe>'
    const result = roundTripCheck(rawHtml)
    expect(result).toEqual({ ok: true, result: rawHtml })
  })

  it("preserves multi-line raw HTML without parsing or executing it", () => {
    const rawHtml = "<details>\n<summary>More</summary>\n<script>doNotRun()</script>\n</details>"
    expect(roundTripCheck(rawHtml)).toEqual({ ok: true, result: rawHtml })
  })

  it("routes the complex Obsidian fixture through the lossless Source-mode guard", () => {
    expect(roundTripCheck(obsidianCompatFixture).ok).toBe(false)
  })

  it("routes a complex body with footnotes to Source mode after keeping frontmatter opaque", () => {
    const body = obsidianCompatFixture.replace(/^---\n[\s\S]*?\n---\n/u, "")
    expect(roundTripCheck(body).ok).toBe(false)
  })

  it("routes footnotes to Source mode before citation tokens exist", () => {
    const footnote = "Footnote reference.[^one]\n\n[^one]: The footnote body."
    expect(roundTripCheck(footnote).ok).toBe(false)
  })

  it("routes reference-style links to Source mode rather than expanding them", () => {
    const referenceLink = 'Read [Amby][project].\n\n[project]: https://example.com "Amby"'
    expect(roundTripCheck(referenceLink).ok).toBe(false)
  })

  it("routes malformed frontmatter through the Source-mode guard", () => {
    expect(roundTripCheck(malformedFrontmatterFixture).ok).toBe(false)
  })

  it("preserves table alignment markers and delimiter spacing", () => {
    const table = "| Left | Right |\n| :--- | ----: |\n| a | b |"
    expect(roundTripCheck(table)).toEqual({ ok: true, result: table })
  })

  it("preserves foldable callout markers and titles", () => {
    const callout = "> [!NOTE]- Foldable\n> body"
    expect(roundTripCheck(callout)).toEqual({ ok: true, result: callout })
  })

  it("preserves custom Obsidian callout types", () => {
    const callout = "> [!TODO]+ Ship M2\n> Remaining work."
    expect(roundTripCheck(callout)).toEqual({ ok: true, result: callout })
  })

  it("keeps a plain callout title out of the emoji field and parses nested callouts", () => {
    const callout = "> [!NOTE] Parent title\n> > [!TODO] Nested title\n> > Nested body"
    const doc = markdownToDoc(callout)
    const first = (
      doc as {
        content?: Array<{ attrs?: Record<string, unknown>; content?: Array<{ type?: string }> }>
      }
    ).content?.[0]
    expect(first?.attrs?.emoji).toBe("💡")
    expect(first?.content?.[0]?.type).toBe("callout")
    expect(roundTripCheck(callout)).toEqual({ ok: true, result: callout })
  })

  it("preserves a note with tags, wiki links, and separate callouts", () => {
    const note =
      "#Тег #привет\n\nПросто  для [[теста]]\n\n> [!NOTE] 😍\n> \n\n> [!NOTE] ☺️\n> asdsadasdsad\n\n[[Назуар]] [[Тестовая]]"
    expect(roundTripCheck(note)).toEqual({ ok: true, result: note })
  })

  it("preserves raw inline HTML as an opaque inline atom", () => {
    const inlineHtml = "Press <kbd>⌘</kbd> + <kbd>K</kbd>."
    expect(roundTripCheck(inlineHtml)).toEqual({ ok: true, result: inlineHtml })
  })

  it("preserves inline and block math source without normalizing delimiters", () => {
    const math = "Inline $E = mc^2$.\n\n$$\n\\int_0^1 x^2 dx\n$$"
    expect(roundTripCheck(math)).toEqual({ ok: true, result: math })
  })

  it("preserves Mermaid and media embeds as portable Markdown", () => {
    const portable =
      '```mermaid\ngraph TD\n  A --> B\n```\n\n![[recording.mp3]]\n\n<audio controls src="recording.mp3"></audio>'
    expect(roundTripCheck(portable)).toEqual({ ok: true, result: portable })
  })

  it("maps a cursor through Source and Live Preview without changing Markdown", () => {
    const source = "# Heading\n\nAlpha bravo charlie"
    const doc = editorSchema.nodeFromJSON(markdownToDoc(source))
    const sourceCursor = source.indexOf("bravo") + 2
    const live = markdownSelectionToDocSelection(doc, source, {
      from: sourceCursor,
      to: sourceCursor,
    })

    expect(live).not.toBeNull()
    expect(doc.textBetween(0, live!.from, " ")).toContain("br")
    expect(docSelectionToMarkdownSelection(doc, source, live!)).toEqual({
      from: sourceCursor,
      to: sourceCursor,
    })
  })

  it("never admits a drifting document from the deterministic compatibility corpus", () => {
    const blocks = [
      "# Heading",
      "Plain text with **bold** and `code`.",
      "- first\n- second",
      "1. first\n2. second",
      "- [ ] todo\n- [x] done",
      "> quoted text",
      "See [[Target#Heading|alias]] and #topic.",
      "```unknown\nvalue\n```",
      "| A | B |\n| :--- | ---: |\n| x | y |",
      "> [!TIP]+ Expanded\n> Helpful text.",
      "<details>\n<summary>More</summary>\ncontent\n</details>",
    ]
    let seed = 0x5eeda11
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed
    }

    for (let index = 0; index < 80; index++) {
      const count = (next() % 4) + 1
      const document = Array.from({ length: count }, () => blocks[next() % blocks.length]).join(
        "\n\n",
      )
      const check = roundTripCheck(document)
      if (check.ok) expect(check.result, `corpus document ${index}`).toBe(document)
      // A parser normalization must be stable and, crucially, the guard must
      // reject the original document before a Live Preview save can use it.
      expect(roundTripCheck(check.result).result, `corpus document ${index}`).toBe(check.result)
    }
  })
})
