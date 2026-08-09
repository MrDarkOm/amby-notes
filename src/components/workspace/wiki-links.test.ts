import { describe, it, expect } from "vitest"
import {
  extractWikiLinks,
  normalizeWikiLinkTarget,
  normalizeLookup,
  findWikiLinkItem,
  buildLinkGraph,
} from "./wiki-links"
import type { TreeItem } from "./sidebar-tree"

const file = (id: string, name: string, path = id): TreeItem => ({
  id,
  path,
  name,
  type: "file",
  icon: "file",
})

// normalizeWikiLinkTarget strips alias and heading/block anchor, preserves case.
// Case-folding for lookup is the separate job of normalizeLookup().
describe("normalizeWikiLinkTarget", () => {
  it("strips heading anchor and .md extension, preserves case", () => {
    expect(normalizeWikiLinkTarget("Note")).toBe("Note")
    expect(normalizeWikiLinkTarget("Note.md")).toBe("Note")
    expect(normalizeWikiLinkTarget("Note#Heading")).toBe("Note")
    expect(normalizeWikiLinkTarget("Note^block-id")).toBe("Note")
  })

  it("strips alias part after |", () => {
    expect(normalizeWikiLinkTarget("Note|Alias")).toBe("Note")
    expect(normalizeWikiLinkTarget("Note#Heading|Alias")).toBe("Note")
  })

  it("normalizes backslashes to forward slashes", () => {
    expect(normalizeWikiLinkTarget("Folder\\Note")).toBe("Folder/Note")
  })
})

describe("normalizeLookup", () => {
  it("lowercases and NFC-normalizes", () => {
    expect(normalizeLookup("Note")).toBe("note")
    expect(normalizeLookup("Заметка")).toBe("заметка")
    // NFC: two representations of the same character must be equal
    const composed = "é" // é precomposed
    const decomposed = "é" // e + combining accent
    expect(normalizeLookup(composed)).toBe(normalizeLookup(decomposed))
  })
})

describe("extractWikiLinks", () => {
  it("extracts raw text, case-preserved target, and label", () => {
    const links = extractWikiLinks("see [[Alpha]] and [[Beta|the beta]] and [[Gamma#Intro]]")
    expect(links).toHaveLength(3)
    // Targets are case-preserved (lowercasing happens in findWikiLinkItem)
    expect(links[0].raw).toBe("Alpha")
    expect(links[0].target).toBe("Alpha")
    expect(links[0].label).toBe("Alpha")
    // Alias replaces label
    expect(links[1].target).toBe("Beta")
    expect(links[1].label).toBe("the beta")
    // Heading anchor stripped from target but raw is kept intact
    expect(links[2].target).toBe("Gamma")
    expect(links[2].raw).toBe("Gamma#Intro")
  })

  it("returns [] for content without wiki links", () => {
    expect(extractWikiLinks("no links here")).toEqual([])
  })

  it("is stateless across successive calls", () => {
    expect(extractWikiLinks("[[One]]")[0].target).toBe("One")
    expect(extractWikiLinks("[[Two]]")[0].target).toBe("Two")
    expect(extractWikiLinks("no links")).toEqual([])
    expect(extractWikiLinks("[[Three]]")[0].target).toBe("Three")
  })

  it("handles unicode note names", () => {
    expect(extractWikiLinks("ссылка [[Заметка]]")[0].target).toBe("Заметка")
  })

  it("ignores links inside YAML, code and Obsidian comments", () => {
    const source =
      "---\nalias: [[Yaml]]\n---\n[[Visible]] `[[Inline]]`\n```md\n[[Fence]]\n```\n%% [[Comment]] %%"
    expect(extractWikiLinks(source).map((link) => link.target)).toEqual(["Visible"])
  })
})

describe("findWikiLinkItem", () => {
  it("matches by name case-insensitively", () => {
    const items: TreeItem[] = [file("/v/Note.md", "Note", "/v/Note.md")]
    // Upper-case search
    expect(findWikiLinkItem(items, "NOTE", "/v")).toBe(items[0])
    // Lower-case search
    expect(findWikiLinkItem(items, "note", "/v")).toBe(items[0])
  })

  it("returns null for unknown targets", () => {
    expect(findWikiLinkItem([], "Ghost", null)).toBeNull()
  })
})

describe("buildLinkGraph", () => {
  it("resolves edges to existing notes and marks missing targets unresolved", () => {
    const items: TreeItem[] = [file("a", "Alpha"), file("b", "Beta")]
    const graph = buildLinkGraph(items, { a: "links to [[Beta]] and [[Ghost]]", b: "" }, null)

    // two real notes + one missing placeholder node
    expect(graph.nodes).toHaveLength(3)

    const resolved = graph.edges.find((e) => e.target === "b")
    expect(resolved?.unresolved).toBe(false)

    const missing = graph.edges.find((e) => e.unresolved)
    expect(missing?.target).toBe("missing:ghost")
  })

  it("resolves an aliased + anchored link to the base note and keeps the alias label", () => {
    const items: TreeItem[] = [file("a", "Alpha"), file("b", "Beta")]
    const graph = buildLinkGraph(items, { a: "[[Beta#Section|see beta]]", b: "" }, null)
    const edge = graph.edges[0]
    expect(edge.target).toBe("b")
    expect(edge.unresolved).toBe(false)
    expect(edge.label).toBe("see beta")
  })
})
