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
import sharedCompatibilityCorpus from "../../../../tests/fixtures/markdown-compatibility.json"
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
    [
      "linked database view",
      '```amby-db\n{"databaseId":"01J00000000000000000000010","viewId":"01J00000000000000000000011","layout":"board"}\n```',
    ],
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

  describe("whitespace at the end of a paragraph", () => {
    // markdown-it trims the last line of a paragraph or heading; the serializer writes
    // text as it is. Typing "word " in Live Preview used to produce a buffer the parser
    // could not read back, which dropped the note into Source mode on the spot.
    const kept = [
      "Начало ",
      "Начало \n",
      "# T\n\nНачало ",
      "A b  ",
      "A b\t",
      "a \n\nb ",
      "- a ",
      "> a ",
      "# T ",
      "**b** ",
      "- [ ] t ",
      "Начало \r\n",
      "Начало \r\n\r\nВторой ",
    ]

    it.each(kept)("opens %j in Live Preview with the same bytes", (source) => {
      expect(roundTripCheck(source)).toEqual({ ok: true, result: source })
    })

    it("keeps the space as text, not as a hard break or a trimmed value", () => {
      const doc = editorSchema.nodeFromJSON(markdownToDoc("Начало "))
      expect(doc.childCount).toBe(1)
      expect(doc.firstChild?.textContent).toBe("Начало ")
    })

    it("admits what the editor writes while the user types a word and a space", () => {
      for (const typed of ["Начало", "Начало ", "Начало мир", "Начало мир "]) {
        const doc = editorSchema.nodeFromJSON({
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: typed }] }],
        })
        const written = docToMarkdown(doc)
        expect(written).toBe(typed)
        expect(roundTripCheck(written).ok, JSON.stringify(typed)).toBe(true)
      }
    })

    it("writes the bytes it read after parse and serialize, for a note with several paragraphs", () => {
      const source = "# Глава \n\nПервый абзац \n\nВторой абзац\n\n- пункт \n"
      expect(roundTripCheck(source)).toEqual({ ok: true, result: source })
      expect(roundTrip(source)).toBe("# Глава \n\nПервый абзац \n\nВторой абзац\n\n- пункт ")
    })

    it("still sends what it cannot reproduce byte for byte to Source mode", () => {
      // Interior trailing space on a soft line break is dropped by the parser.
      expect(roundTripCheck("a \nb").ok).toBe(false)
      // A closing `#` run and a setext underline are not the editor's own form.
      expect(roundTripCheck("# T # ").ok).toBe(false)
      expect(roundTripCheck("Setext \n===").ok).toBe(false)
    })
  })

  describe("whitespace-only lines written by earlier versions of the editor", () => {
    // A paragraph of nothing but spaces was written as a raw line. The body of a note
    // found in a real vault, byte for byte.
    const legacy = "Фев\n\nФлдыовдыф\n\n   \n\n  \n\n     "

    it("opens in Live Preview and gives back the same bytes", () => {
      expect(roundTripCheck(legacy)).toEqual({ ok: true, result: legacy })
      for (const source of ["   ", "a\n\n \n\nb", "\t\n\na", "a\r\n\r\n  \r\n\r\nb"]) {
        expect(roundTripCheck(source), JSON.stringify(source)).toEqual({ ok: true, result: source })
      }
    })

    it("keeps those lines when the text changes without changing the number of lines", () => {
      const doc = editorSchema.nodeFromJSON(markdownToDoc(legacy))
      const edited = doc.copy(
        doc.content.replaceChild(
          0,
          editorSchema.nodes.paragraph.create(null, editorSchema.text("Февраль")),
        ),
      )
      expect(restoreSourceFormatting(docToMarkdown(edited), legacy)).toBe(
        legacy.replace("Фев", "Февраль"),
      )
    })

    it("does not move the whitespace when lines are added or removed", () => {
      const result = restoreSourceFormatting("a\n\nb\n\nc", "a\n\n  \n\nb")
      expect(result).toBe("a\n\nb\n\nc")
    })

    it("still rejects whitespace the editor cannot place", () => {
      // Whitespace on a line with other text is content.
      expect(roundTripCheck("a\n\n  b\n").ok).toBe(false)
    })
  })

  it("preserves content without trailing newlines without appending extraneous newlines", () => {
    expect(restoreSourceFormatting("Фев\n\n", "Фев")).toBe("Фев")
    expect(restoreSourceFormatting("Line\n\n", "Line")).toBe("Line")
    expect(roundTripCheck("Фев").ok).toBe(true)
    expect(roundTripCheck("Line").ok).toBe(true)
  })

  it("keeps a new empty note empty instead of materialising a newline", () => {
    expect(roundTrip("")).toBe("")
    expect(roundTripCheck("")).toEqual({ ok: true, result: "" })
    expect(roundTripCheck("\n")).toEqual({ ok: true, result: "\n" })
    expect(roundTripCheck("\r\n\r\n")).toEqual({ ok: true, result: "\r\n\r\n" })
  })

  it("restores typed content when the note was initially empty or blank", () => {
    expect(restoreSourceFormatting("Hello world", "")).toBe("Hello world")
    expect(restoreSourceFormatting("Hello world", "\n")).toBe("Hello world")
    expect(restoreSourceFormatting("Hello world", "\r\n\r\n")).toBe("Hello world")
  })

  it("preserves intentional empty paragraphs between and after blocks", () => {
    expect(roundTrip("First\n\n\nSecond")).toBe("First\n\n\nSecond")
    expect(roundTrip("First\n\n\n")).toBe("First\n\n\n")

    const doc = editorSchema.nodeFromJSON(markdownToDoc("First\n\n\nSecond"))
    expect(doc.childCount).toBe(3)
    expect(doc.child(1).type.name).toBe("paragraph")
    expect(doc.child(1).childCount).toBe(0)
  })

  it("preserves an empty block between ordered lists without merging their numbering", () => {
    const markdown = "1. First\n\n\n1. Second\n2. Third"
    expect(roundTrip(markdown)).toBe(markdown)

    const doc = editorSchema.nodeFromJSON(markdownToDoc(markdown))
    expect(doc.childCount).toBe(3)
    expect(doc.child(0).type.name).toBe("orderedList")
    expect(doc.child(1).type.name).toBe("paragraph")
    expect(doc.child(1).childCount).toBe(0)
    expect(doc.child(2).type.name).toBe("orderedList")
    expect(doc.child(2).attrs.start).toBe(1)
  })

  it("preserves leading blank lines that are not represented in the ProseMirror document", () => {
    expect(restoreSourceFormatting("Text", "\n\nText")).toBe("\n\nText")
    expect(roundTripCheck("\n\nText").ok).toBe(true)
  })

  it("restores consistent CRLF formatting after visual serialization", () => {
    const crlfFixture = livePreviewSafeFixture.replace(/\r?\n/g, "\r\n")
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

  it("does not accumulate blank blocks across repeated mode transitions", () => {
    const source = [
      "1. Before the columns",
      "",
      "",
      '<!-- amby:columns widths="0.4211,0.5789" -->',
      "",
      "<!-- amby:column -->",
      "",
      "Left",
      "",
      "<!-- amby:column -->",
      "",
      "Right",
      "",
      "<!-- /amby:columns -->",
      "",
      "",
      "> [!NOTE] 💡",
      "> First row",
      ">",
      "> Second row",
    ].join("\n")

    let transitioned = source
    for (let index = 0; index < 25; index++) transitioned = roundTrip(transitioned)
    expect(transitioned).toBe(source)

    const doc = editorSchema.nodeFromJSON(markdownToDoc(source))
    expect(doc.child(1).type.name).toBe("paragraph")
    expect(doc.child(1).childCount).toBe(0)
    expect(doc.child(2).type.name).toBe("columnSet")
    expect(doc.child(3).type.name).toBe("paragraph")
    expect(doc.child(3).childCount).toBe(0)
  })

  describe("empty lines inside columns", () => {
    const DB = "01M2B5Z6F4XAXBRWPW5B4VTBS0"
    const block =
      "```amby-db\n" +
      `{"version":2,"views":[{"id":"v1","databaseId":"${DB}","title":"","layout":"table","config":{}}]}` +
      "\n```"
    const columns = (first: string, second = "Right") =>
      [
        '<!-- amby:columns widths="0.4363,0.5637" -->',
        "",
        "<!-- amby:column -->",
        "",
        first,
        "",
        "<!-- amby:column -->",
        "",
        second,
        "",
        "<!-- /amby:columns -->",
      ].join("\n")
    const emptyCount = (md: string, column: number) => {
      const doc = editorSchema.nodeFromJSON(markdownToDoc(md))
      const target = doc.child(0).child(column)
      let count = 0
      target.forEach((child) => {
        if (child.type.name === "paragraph" && child.childCount === 0) count++
      })
      return count
    }

    it("keeps a blank line above a database block as an empty paragraph, not as lost Markdown", () => {
      // A line added above the database in a column: two blank lines before the fence.
      const source = columns("\n" + block)
      expect(roundTrip(source)).toBe(source)
      expect(emptyCount(source, 0)).toBe(1)
      // It is Live-editable again, not forced into Source.
      expect(roundTripCheck(source).ok).toBe(true)
    })

    it("opens the note a user got stuck in Source with, in Live Preview again", () => {
      // Verbatim from the report: a line above the database in the first column.
      const source = [
        '<!-- amby:columns widths="0.4363,0.5637" -->',
        "",
        "<!-- amby:column -->",
        "",
        "",
        "```amby-db",
        '{"height":286,"width":363,"version":2,"views":[{"id":"v1","databaseId":"01M2B5Z6F4XAXBRWPW5B4VTBS0","title":"","layout":"table","config":{}},{"id":"v7f4227bcb1","databaseId":"01M2B5Z6F4XAXBRWPW5B4VTBS0","title":"","layout":"gallery","config":{"layoutConfig":{"cardSize":"small"}}}]}',
        "```",
        "",
        "<!-- amby:column -->",
        "",
        "ыфвфывфыв",
        "",
        "<!-- /amby:columns -->",
      ].join("\n")
      expect(roundTripCheck(source).ok).toBe(true)
      expect(roundTrip(source)).toBe(source)
    })

    it("keeps empty paragraphs at the start, between blocks and at the end of a column", () => {
      for (const body of ["\nA", "A\n\n\nB", "A\n", "\n\nA\n\n\nB\n\n"]) {
        const source = columns(body)
        expect(roundTrip(source), JSON.stringify(body)).toBe(source)
        expect(roundTripCheck(source).ok).toBe(true)
      }
      expect(emptyCount(columns("\nA"), 0)).toBe(1)
      expect(emptyCount(columns("A\n\n\nB"), 0)).toBe(1)
      expect(emptyCount(columns("\n\nA"), 0)).toBe(2)
      // The second column counts the same way.
      expect(emptyCount(columns("Left", "\n" + block), 1)).toBe(1)
    })

    it("stays stable across repeated Source and Live switches", () => {
      let text = columns("\n" + block, "\nRight\n")
      const first = roundTrip(text)
      for (let index = 0; index < 20; index++) text = roundTrip(first)
      expect(text).toBe(first)
      expect(first).toBe(columns("\n" + block, "\nRight\n"))
    })

    it("reads the long-standing form of an empty column as one empty paragraph", () => {
      const source =
        "<!-- amby:columns -->\n\n<!-- amby:column -->\n\nKeep\n\n<!-- amby:column -->\n\n\n\n<!-- /amby:columns -->"
      expect(emptyCount(source, 1)).toBe(1)
      expect(roundTrip(source)).toBe(source)
      // Each blank line beyond that is one more empty paragraph, and survives.
      const two =
        "<!-- amby:columns -->\n\n<!-- amby:column -->\n\nKeep\n\n<!-- amby:column -->\n\n\n\n\n<!-- /amby:columns -->"
      expect(emptyCount(two, 1)).toBe(2)
      expect(roundTrip(two)).toBe(two)
    })
  })

  it("keeps a database block inside a column through a round trip", () => {
    const block =
      '```amby-db\n{"version":2,"views":[{"id":"a","databaseId":"01J00000000000000000000010","title":"T","layout":"table","config":{}}],"width":420}\n```'
    const source = [
      '<!-- amby:columns widths="0.5000,0.5000" -->',
      "",
      "<!-- amby:column -->",
      "",
      "Text next to the database",
      "",
      "<!-- amby:column -->",
      "",
      block,
      "",
      "<!-- /amby:columns -->",
    ].join("\n")
    expect(roundTrip(source)).toBe(source)
    const doc = editorSchema.nodeFromJSON(markdownToDoc(source))
    expect(doc.child(0).type.name).toBe("columnSet")
    expect(doc.child(0).child(1).child(0).type.name).toBe("ambyBlock")
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

  it("preserves opaque blocks while editing only a supported paragraph", () => {
    for (const opaque of [
      '<aside data-custom="keep">Unknown HTML</aside>',
      "```custom-language\nunknown { source }\n```",
      "$$\ncustom + math\n$$",
    ]) {
      const source = `Before.\n\n${opaque}\n\nAfter.`
      expect(roundTripCheck(source).ok).toBe(true)
      const doc = editorSchema.nodeFromJSON(markdownToDoc(source))
      expect(doc.firstChild?.type.name).toBe("paragraph")
      const edited = doc.copy(
        doc.content.replaceChild(
          0,
          editorSchema.nodes.paragraph.create(
            null,
            editorSchema.text("Edited supported paragraph."),
          ),
        ),
      )
      const saved = docToMarkdown(edited)
      expect(saved).toBe(source.replace("Before.", "Edited supported paragraph."))
      expect(roundTripCheck(saved).ok).toBe(true)
    }
  })

  it("admits the titled links and the long list of the shared indexing corpus", () => {
    const shared = sharedCompatibilityCorpus.find(
      (fixture) => fixture.name === "titled_links_and_long_ordered_list",
    )
    expect(shared).toBeDefined()
    expect(roundTripCheck(shared!.markdown)).toEqual({ ok: true, result: shared!.markdown })
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

  // Link titles and unpadded ordered lists are admitted to Live Preview; footnotes and
  // link definitions next to them must still keep the note in Source.
  it.each([
    ["footnote reference and definition", "Text.[^1]\n\n[^1]: The footnote body."],
    ["footnote reference without a definition", "Text.[^note]"],
    ["footnote definition without a reference", "Text.\n\n[^1]: The footnote body."],
    ["inline footnote", "Text.^[An inline footnote.]"],
    ["footnote in a list item", "1. one[^1]\n2. two\n\n[^1]: Body."],
    ["footnote beside a titled link", '[a](http://a.b "T")[^1]\n\n[^1]: Body.'],
    ["full reference link", "Read [Amby][project].\n\n[project]: https://example.com"],
    ["collapsed reference link", "Read [project][].\n\n[project]: https://example.com"],
    ["shortcut reference link", "Read [project].\n\n[project]: https://example.com"],
    ["reference image", "![Amby][logo]\n\n[logo]: assets/logo.png"],
    ["definition nothing refers to", "Text.\n\n[unused]: https://example.com"],
    ["definition with a double-quoted title", 'Read [a][b].\n\n[b]: http://a.b "Title"'],
    ["definition with a single-quoted title", "Read [a][b].\n\n[b]: http://a.b 'Title'"],
    ["definition with a parenthesised title", "Read [a][b].\n\n[b]: http://a.b (Title)"],
    ["definition with a title on its own line", 'Read [a][b].\n\n[b]: http://a.b\n  "Title"'],
    ["definition with an angle-bracket address", "Read [a][b].\n\n[b]: <http://a.b>"],
    [
      "definition beside a titled link and a long list",
      `[a](http://a.b "T") and [c][d].\n\n${Array.from({ length: 10 }, (_, n) => `${n + 1}. x`).join("\n")}\n\n[d]: http://c.d`,
    ],
  ])("still routes to Source mode: %s", (_name, markdown) => {
    const check = roundTripCheck(markdown)
    expect(check.ok).toBe(false)
    // What the guard rejected is stable, so the rejection cannot flip on a second look.
    expect(roundTripCheck(check.result).result).toBe(check.result)
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
    expect(first?.content?.[0]?.type).toBe("paragraph")
    expect(first?.content?.[1]?.type).toBe("callout")
    expect(roundTripCheck(callout)).toEqual({ ok: true, result: callout })
  })

  it("treats an existing callout title as ordinary Markdown-formatted content", () => {
    const callout = "> [!NOTE] **Ordinary title**\n> Next line"
    const doc = markdownToDoc(callout) as {
      content?: Array<{
        content?: Array<{ content?: Array<{ marks?: Array<{ type: string }> }> }>
      }>
    }
    expect(doc.content?.[0]?.content?.[0]?.content?.[0]?.marks?.[0]?.type).toBe("bold")
    expect(roundTripCheck(callout)).toEqual({ ok: true, result: callout })
  })

  it("preserves Obsidian image sizing variants and dimensions in round-trip", () => {
    const images = [
      "![Alt text|300](assets/photo.png)",
      "![Alt text|300x200](assets/photo.png)",
      "![|450](assets/photo.png)",
      "![250](assets/photo.png)",
      "![300x150](assets/photo.png)",
      "![Alt with | pipe](assets/photo.png)",
    ]
    for (const img of images) {
      expect(roundTripCheck(img)).toEqual({ ok: true, result: img })
    }
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
      Array.from({ length: 11 }, (_, n) => `${n + 1}. item`).join("\n"),
      Array.from({ length: 11 }, (_, n) => `${String(n + 1).padStart(2)}. item`).join("\n"),
      'A [titled](https://example.com "Title") and [another](https://example.com \'It "is"\') link.',
      "Odd [title](https://example.com  (spaced)) and a note.[^1]",
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
