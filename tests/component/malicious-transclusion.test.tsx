// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { markdownToSafeReadonlyHtml } from "@/components/workspace/tiptap/markdown"

describe("Malicious transclusion rendering and security boundary", () => {
  it("escapes script tags and does not execute inline javascript", () => {
    const malicious = `# Header\n\n<script>window.pwned = true;</script>\n<img src="x" onerror="window.pwned=true">\n<iframe src="javascript:alert(1)"></iframe>`
    const safeHtml = markdownToSafeReadonlyHtml(malicious)
    const rawString = String(safeHtml)

    // Verify raw HTML tags are escaped as entities
    expect(rawString).toContain("&lt;script&gt;")
    expect(rawString).toContain("&lt;img")
    expect(rawString).toContain("&lt;iframe")
    expect(rawString).not.toContain("<script>")
    expect(rawString).not.toContain("<iframe")

    // Verify when placed into DOM, no scripts are parsed as active DOM elements
    const div = document.createElement("div")
    div.innerHTML = rawString
    expect(div.querySelectorAll("script")).toHaveLength(0)
    expect(div.querySelectorAll("iframe")).toHaveLength(0)
    expect(div.querySelectorAll("img")).toHaveLength(0)
    expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined()
  })

  it("escapes event handlers and javascript URIs in links", () => {
    const malicious = `[Click me](javascript:alert('xss'))\n<a href="javascript:alert('xss')" onclick="alert(1)">Link</a>`
    const safeHtml = markdownToSafeReadonlyHtml(malicious)
    const rawString = String(safeHtml)

    const div = document.createElement("div")
    div.innerHTML = rawString

    const links = div.querySelectorAll("a")
    for (const link of links) {
      expect(link.getAttribute("onclick")).toBeNull()
      expect(link.getAttribute("href")?.toLowerCase()).not.toContain("javascript:")
    }
  })
})
