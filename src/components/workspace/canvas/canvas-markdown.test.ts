import { describe, expect, it } from "vitest"
import {
  escapeHtml,
  renderCardHtml,
  pathStem,
  extFromMime,
  resolveVaultFilePath,
  toRelativeVaultPath,
} from "./canvas-markdown"

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

  it("resolves vault file path correctly without double-prefixing", () => {
    expect(resolveVaultFilePath("notes/daily.md", "/Users/me/vault")).toBe(
      "/Users/me/vault/notes/daily.md",
    )
    expect(resolveVaultFilePath("/Users/me/vault/notes/daily.md", "/Users/me/vault")).toBe(
      "/Users/me/vault/notes/daily.md",
    )
    expect(resolveVaultFilePath("C:/Vault/note.md", "C:/Vault")).toBe("C:/Vault/note.md")
    expect(resolveVaultFilePath("", "/Users/me/vault")).toBe("")
    expect(resolveVaultFilePath("note.md", null)).toBe("note.md")
  })

  it("converts absolute path to relative vault path", () => {
    expect(toRelativeVaultPath("/Users/me/vault/notes/daily.md", "/Users/me/vault")).toBe(
      "notes/daily.md",
    )
    expect(toRelativeVaultPath("notes/daily.md", "/Users/me/vault")).toBe("notes/daily.md")
    expect(toRelativeVaultPath("", "/Users/me/vault")).toBe("")
  })
})
