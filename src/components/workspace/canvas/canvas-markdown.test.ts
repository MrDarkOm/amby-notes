import { describe, expect, it } from "vitest"
import { escapeHtml, renderCardHtml, pathStem, extFromMime } from "./canvas-markdown"

describe("canvas-markdown", () => {
  it("escapes html special characters", () => {
    expect(escapeHtml("<script>alert('xss')&\"test\"</script>")).toBe(
      "&lt;script&gt;alert('xss')&amp;&quot;test&quot;&lt;/script&gt;",
    )
  })

  it("renders markdown text with wikilinks and tags", () => {
    const md = "Hello [[Target Note|My Alias]] and #important-tag"
    const html = renderCardHtml(md)
    expect(html).toContain('data-wikilink="Target Note"')
    expect(html).toContain("My Alias")
    expect(html).toContain("#important-tag")
  })

  it("handles empty or whitespace text", () => {
    expect(renderCardHtml("")).toBe("")
    expect(renderCardHtml("   \n\t  ")).toBe("")
  })

  it("extracts path stem correctly", () => {
    expect(pathStem("notes/daily/2026-08-19.md")).toBe("2026-08-19")
    expect(pathStem("diagram.canvas")).toBe("diagram")
    expect(pathStem("my-file")).toBe("my-file")
  })

  it("extracts extension from mime types", () => {
    expect(extFromMime("image/jpeg")).toBe("jpg")
    expect(extFromMime("image/png")).toBe("png")
    expect(extFromMime("image/webp")).toBe("webp")
    expect(extFromMime("application/octet-stream")).toBe("png")
  })
})
