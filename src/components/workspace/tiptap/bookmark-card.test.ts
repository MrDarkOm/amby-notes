// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"

import { bookmarkOf, bookmarkParagraph, parseBookmarkAddress, webHost } from "./bookmark-card"
import { docToNormalizedMarkdown, editorSchema, markdownToDoc, roundTripCheck } from "./markdown"
import { markdownMeaning } from "./markdown-meaning"

const parse = (markdown: string) => editorSchema.nodeFromJSON(markdownToDoc(markdown))

/** The bookmarks the editor would draw as cards in this Markdown. */
function bookmarks(markdown: string) {
  const found: Array<ReturnType<typeof bookmarkOf>> = []
  parse(markdown).descendants((node, _pos, parent) => {
    if (node.type.name === "paragraph") found.push(bookmarkOf(node, parent))
  })
  return found.filter(Boolean)
}

describe("which paragraphs are bookmarks", () => {
  it("takes one titled web link alone in a paragraph", () => {
    expect(bookmarks('[Example page](https://example.com/a?b=1 "example.com")')).toEqual([
      { href: "https://example.com/a?b=1", host: "example.com", hint: "example.com" },
    ])
    expect(bookmarks("[Page](http://www.example.com 'A description of the page')")).toEqual([
      { href: "http://www.example.com", host: "example.com", hint: "A description of the page" },
    ])
  })

  it("leaves a link without a hint as a link", () => {
    expect(bookmarks("[Example page](https://example.com)")).toEqual([])
    expect(bookmarks('[Example page](https://example.com "")')).toEqual([])
    expect(bookmarks("<https://example.com>")).toEqual([])
  })

  it("leaves a link that has other text around it, or a second link, as a link", () => {
    expect(bookmarks('See [page](https://example.com "hint")')).toEqual([])
    expect(bookmarks('[page](https://example.com "hint") and more')).toEqual([])
    expect(bookmarks('[a](https://a.com "x") [b](https://b.com "y")')).toEqual([])
    expect(bookmarks('[a](https://a.com "x")\n[b](https://a.com "x")')).toEqual([])
  })

  it("takes only web addresses", () => {
    expect(bookmarks('[x](assets/report.pdf "hint")')).toEqual([])
    expect(bookmarks('[x](mailto:a@b.c "hint")')).toEqual([])
    expect(bookmarks('[x](javascript:alert(1) "hint")')).toEqual([])
    expect(bookmarks('[x](ftp://example.com/f "hint")')).toEqual([])
  })

  it("is formatted text inside the link, still one bookmark", () => {
    expect(bookmarks('[**Bold** page](https://example.com "hint")')).toHaveLength(1)
  })

  it("stands in the body, a quote or a callout, not in a list item or a table cell", () => {
    expect(bookmarks('> [x](https://example.com "hint")')).toHaveLength(1)
    expect(bookmarks('> [!NOTE]\n> [x](https://example.com "hint")')).toHaveLength(1)
    expect(bookmarks('- [x](https://example.com "hint")')).toEqual([])
    expect(bookmarks('| a |\n| - |\n| [x](https://example.com "hint") |')).toEqual([])
  })

  it("is a link in a panel of plain links: nothing becomes a card", () => {
    const panel = "[One](https://one.com)\n\n[Two](https://two.com)\n\n[Three](https://three.com)\n"
    expect(bookmarks(panel)).toEqual([])
  })
})

describe("web addresses", () => {
  it("finds the host", () => {
    expect(webHost("https://www.example.com/a")).toBe("example.com")
    expect(webHost("http://sub.example.org:8080/")).toBe("sub.example.org")
    expect(webHost("example.com")).toBeNull()
    expect(webHost("https://exa mple.com")).toBeNull()
    expect(webHost("file:///etc/passwd")).toBeNull()
  })

  it("reads a typed address, adding https when no scheme is typed", () => {
    expect(parseBookmarkAddress("  example.com/page ")).toEqual({
      href: "https://example.com/page",
      host: "example.com",
    })
    expect(parseBookmarkAddress("http://example.com")).toEqual({
      href: "http://example.com",
      host: "example.com",
    })
    expect(parseBookmarkAddress("")).toBeNull()
    expect(parseBookmarkAddress("javascript:alert(1)")).toBeNull()
    expect(parseBookmarkAddress("not an address")).toBeNull()
  })
})

describe("a bookmark in Markdown", () => {
  const written = (href: string, host: string) =>
    docToNormalizedMarkdown(
      editorSchema.nodeFromJSON({ type: "doc", content: [bookmarkParagraph(href, host)] }),
    )

  it("is written as an ordinary titled link", () => {
    expect(written("https://example.com/a", "example.com")).toBe(
      '[example.com](https://example.com/a "example.com")',
    )
  })

  it.each([
    '[Example page](https://example.com/a "example.com")',
    "[Example page](https://example.com/a 'A \"quoted\" description')\n",
    "[Example page](https://example.com/a (Some description))\n",
    'Before\n\n[Page](https://example.com "site")\n\nAfter\n',
    '> [Page](https://example.com "site")\n',
  ])("keeps %j byte for byte and reads it the same after a rewrite", (markdown) => {
    expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
    const rewritten = docToNormalizedMarkdown(parse(markdown))
    expect(markdownMeaning(rewritten).content).toBe(markdownMeaning(markdown).content)
    expect(bookmarks(rewritten)).toEqual(bookmarks(markdown))
  })

  it("reads back, for a new bookmark, as the same link for the editor and the second reader", () => {
    const markdown = written("https://example.com/a_(b)", "example.com")
    expect(bookmarks(markdown)).toMatchObject([{ href: "https://example.com/a_(b)" }])
    expect(markdownMeaning(markdown).content).toContain("https://example.com/a_(b)")
  })
})
