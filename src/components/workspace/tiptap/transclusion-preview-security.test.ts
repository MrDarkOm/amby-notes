import { describe, expect, it } from "vitest"

import securityFixture from "./fixtures/transclusion-preview-security.md?raw"
import { markdownToSafeReadonlyHtml, roundTripCheck } from "./markdown"

describe("safe transclusion preview renderer", () => {
  it("renders ordinary Markdown without degrading headings, lists, code, links, or wiki links", () => {
    const html = markdownToSafeReadonlyHtml(securityFixture)

    expect(html).toContain("<h1>Safe transclusion preview</h1>")
    expect(html).toContain("<ul>")
    expect(html).toContain("<code>code</code>")
    expect(html).toContain('<a href="https://example.com">safe link</a>')
    expect(html).toContain("[[Wiki Note]]")
  })

  it("escapes scriptable raw HTML and rejects javascript links", () => {
    const html = markdownToSafeReadonlyHtml(securityFixture)

    expect(html).not.toContain("<script")
    expect(html).not.toContain("<img")
    expect(html).not.toContain("<iframe")
    expect(html).not.toContain("<style")
    expect(html).not.toContain("<svg")
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("&lt;div class=&quot;ordinary&quot;&gt;ordinary raw HTML&lt;/div&gt;")
  })

  it("keeps ordinary raw HTML byte-exact in the Live Preview source path", () => {
    const rawHtml = '<div class="ordinary">ordinary raw HTML</div>'

    expect(roundTripCheck(rawHtml)).toEqual({ ok: true, result: rawHtml })
  })
})
