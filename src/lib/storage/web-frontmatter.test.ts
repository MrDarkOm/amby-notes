import { describe, expect, it } from "vitest"
import {
  removeWebFrontmatterProperty,
  splitWebFrontmatter,
  upsertWebFrontmatterProperty,
  webNoteProperties,
  webRevision,
} from "./web-frontmatter"

describe("splitWebFrontmatter", () => {
  it("splits standard LF frontmatter correctly", () => {
    const raw = "---\namby-id: 01M2G6775PZPKWZ4CFKBAV0AA\n---\n# Hello World\nSome body text."
    const split = splitWebFrontmatter(raw)
    expect(split).not.toBeNull()
    expect(split?.body).toBe("# Hello World\nSome body text.")
    expect(split?.yaml).toBe("amby-id: 01M2G6775PZPKWZ4CFKBAV0AA")
    expect(split?.envelope).toBe("---\namby-id: 01M2G6775PZPKWZ4CFKBAV0AA\n---\n")
  })

  it("splits CRLF frontmatter correctly", () => {
    const raw =
      "---\r\namby-id: 01M2G6775PZPKWZ4CFKBAV0AA\r\n---\r\n# Hello World\r\nSome body text."
    const split = splitWebFrontmatter(raw)
    expect(split).not.toBeNull()
    expect(split?.body).toBe("# Hello World\r\nSome body text.")
    expect(split?.yaml).toBe("amby-id: 01M2G6775PZPKWZ4CFKBAV0AA")
    expect(split?.envelope).toBe("---\r\namby-id: 01M2G6775PZPKWZ4CFKBAV0AA\r\n---\r\n")
  })

  it("handles empty body note layer correctly", () => {
    const raw = "---\namby-id: 01M2G6775PZPKWZ4CFKBAV0AA\n---\n"
    const split = splitWebFrontmatter(raw)
    expect(split).not.toBeNull()
    expect(split?.body).toBe("")
    expect(split?.yaml).toBe("amby-id: 01M2G6775PZPKWZ4CFKBAV0AA")
  })

  it("returns null when no frontmatter is present", () => {
    const raw = "# Hello World\nJust body content."
    expect(splitWebFrontmatter(raw)).toBeNull()
  })

  it("computes deterministic web CAS revisions", () => {
    expect(webRevision("")).toBe("811c9dc5")
    expect(webRevision("Hello")).not.toBe("811c9dc5")
  })
})

describe("webNoteProperties", () => {
  it("parses YAML frontmatter properties with various value kinds", () => {
    const content = `---
amby-id: 01M2G6775PZPKWZ4CFKBAV0AA
title: Project Documentation
priority: 1
completed: false
verified: true
tags:
  - architecture
  - docs
categories: [engineering, frontend]
---
# Main Content
`
    const result = webNoteProperties(content)
    expect(result.hasFrontmatter).toBe(true)
    expect(result.properties).toEqual([
      { key: "amby-id", value: "01M2G6775PZPKWZ4CFKBAV0AA", valueKind: "text" },
      { key: "title", value: "Project Documentation", valueKind: "text" },
      { key: "priority", value: "1", valueKind: "number" },
      { key: "completed", value: "false", valueKind: "checkbox" },
      { key: "verified", value: "true", valueKind: "checkbox" },
      { key: "tags", value: "- architecture\n- docs", valueKind: "list" },
      { key: "categories", value: "[engineering, frontend]", valueKind: "list" },
    ])
  })

  it("returns empty properties when no frontmatter is found", () => {
    const result = webNoteProperties("# Just content without frontmatter")
    expect(result.hasFrontmatter).toBe(false)
    expect(result.properties).toEqual([])
  })
})

describe("upsertWebFrontmatterProperty & removeWebFrontmatterProperty", () => {
  it("adds property to note without frontmatter by initializing envelope", () => {
    const content = "# Just Body"
    const noteId = "01M2G6775PZPKWZ4CFKBAV0AA"
    const result = upsertWebFrontmatterProperty(content, noteId, "status", "active", "text")
    expect(result).toContain("amby-id: 01M2G6775PZPKWZ4CFKBAV0AA")
    expect(result).toContain("status: active")
    expect(result).toContain("# Just Body")
  })

  it("updates existing property value and removes property cleanly", () => {
    const content = `---\namby-id: 01M2G6775PZPKWZ4CFKBAV0AA\nstatus: draft\npriority: 1\n---\n# Body`
    const noteId = "01M2G6775PZPKWZ4CFKBAV0AA"
    const updated = upsertWebFrontmatterProperty(content, noteId, "status", "published", "text")
    expect(updated).toContain("status: published")
    expect(updated).not.toContain("status: draft")

    const removed = removeWebFrontmatterProperty(updated, "priority")
    expect(removed).not.toContain("priority:")
    expect(removed).toContain("status: published")
    expect(removed).toContain("# Body")
  })
})
