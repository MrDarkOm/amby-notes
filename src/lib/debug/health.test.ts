import { describe, expect, it, vi } from "vitest"
import { projectDebugDocuments } from "./health"

describe("debug health projection", () => {
  it("returns only counters and reason codes, keeping note identities and content private", () => {
    const documents = {
      "/private/vault/Secret.md": { content: "private body" },
      "sensitive-id": { content: "footnote [^secret]" },
    }
    const check = vi.fn((content: string) => ({ ok: !content.includes("[^secret]") }))
    const result = projectDebugDocuments(
      documents,
      new Set(["sensitive-id"]),
      { "sensitive-id": { localContent: "do not expose" } },
      { "sensitive-id": "source" },
      "live",
      check,
    )
    expect(result.documents).toEqual({ open: 2, dirty: 1, conflicts: 1, source: 1, livePreview: 1 })
    expect(result.editorReasons).toEqual({ footnotes: 1 })
    expect(JSON.stringify(result)).not.toMatch(/private|sensitive|secret|expose/iu)
    expect(documents["sensitive-id"].content).toBe("footnote [^secret]")
  })

  it("caps expensive parsing and reports uninspected documents instead of claiming compatibility", () => {
    const check = vi.fn(() => ({ ok: true }))
    const result = projectDebugDocuments(
      { large: { content: "x".repeat(200_001) }, small: { content: "# ok" } },
      new Set(),
      {},
      {},
      "source",
      check,
    )
    expect(check).toHaveBeenCalledOnce()
    expect(result.editorReasons).toEqual({ inspection_limit: 1, source_selected: 1 })
  })

  it("reports malformed source and parser failures without repairing or exposing text", () => {
    const result = projectDebugDocuments(
      {
        malformed: {
          content: "---\nsecret",
          noteProperties: { frontmatterStatus: "unterminated" } as never,
        },
        broken: { content: "secret parser input" },
      },
      new Set(),
      {},
      {},
      "live",
      () => {
        throw new Error("secret diagnostic")
      },
    )
    expect(result.documents.source).toBe(1)
    expect(result.editorReasons).toEqual({ unterminated_frontmatter: 1, inspection_failed: 1 })
    expect(JSON.stringify(result)).not.toContain("secret")
  })
})
