import { describe, expect, it } from "vitest"
import fixtures from "../../tests/fixtures/markdown-compatibility.json"
import { extractDocumentTags, protectedMarkdownRanges } from "@/components/workspace/markdown-tags"
import {
  extractWikiLinks,
  normalizeLookup,
  normalizeWikiLinkTarget,
} from "@/components/workspace/wiki-links"

interface CompatibilityFixture {
  name: string
  markdown: string
  expectedTags: string[]
  expectedLinks: Array<{
    raw: string
    target: string
    label: string
  }>
  excludedRegions: Array<{
    from: number
    to: number
  }>
}

describe("Markdown index compatibility fixtures (TypeScript)", () => {
  const cases = fixtures as CompatibilityFixture[]

  for (const fixture of cases) {
    describe(`fixture: ${fixture.name}`, () => {
      it("extracts expected excluded regions", () => {
        const ranges = protectedMarkdownRanges(fixture.markdown)
        expect(ranges).toEqual(fixture.excludedRegions)
      })

      it("extracts expected tags", () => {
        const tags = extractDocumentTags(fixture.markdown)
        expect(tags).toEqual(fixture.expectedTags)
      })

      it("extracts expected wiki links", () => {
        const links = extractWikiLinks(fixture.markdown).map((link) => ({
          raw: link.raw,
          target: normalizeLookup(normalizeWikiLinkTarget(link.target)),
          label: link.label,
        }))
        expect(links).toEqual(fixture.expectedLinks)
      })
    })
  }
})
