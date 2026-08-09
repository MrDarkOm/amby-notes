import { describe, expect, it } from "vitest"

import {
  extractObsidianTags,
  isValidObsidianTag,
  protectedMarkdownRanges,
  tagIncludes,
} from "./markdown-tags"

describe("Obsidian tags", () => {
  it("accepts Unicode, nested and mixed tags", () => {
    const source = "#meeting #inbox/to-read #Проект_2026 #1984a"
    expect(extractObsidianTags(source).map((tag) => tag.display)).toEqual([
      "meeting",
      "inbox/to-read",
      "Проект_2026",
      "1984a",
    ])
  })

  it("rejects numeric-only, empty hierarchy and in-word tags", () => {
    expect(extractObsidianTags("#1984 foo#bar #a//b #a/ #/a")).toEqual([])
    expect(isValidObsidianTag("1984")).toBe(false)
  })

  it("ignores YAML, code, comments and escaped hashes", () => {
    const source = [
      "---",
      "tags:",
      "  - yaml-only",
      "---",
      "#visible",
      "`#inline-code`",
      "```md",
      "#fenced-code",
      "```",
      "%% #commented %%",
      "\\#escaped",
    ].join("\n")
    expect(extractObsidianTags(source).map((tag) => tag.display)).toEqual(["visible"])
  })

  it("protects an unterminated comment through EOF", () => {
    const source = "before %% hidden #tag"
    expect(protectedMarkdownRanges(source)).toContainEqual({ from: 7, to: source.length })
    expect(extractObsidianTags(source)).toEqual([])
  })

  it("matches parent tags against descendants case-insensitively", () => {
    expect(tagIncludes("Inbox", "inbox/to-read")).toBe(true)
    expect(tagIncludes("in", "inbox")).toBe(false)
  })
})
