import { describe, expect, it } from "vitest"
import { project, section, storySummary } from "./project-fixtures.test-support"
import { hasGaps, workshopGaps } from "./workshop-gaps"

const base = (role: string, extra: Record<string, unknown> = {}) =>
  section(role, {
    role,
    databaseId: `db_${role}`,
    storiesPropertyId: role === "stories" || role === "universes" ? null : "p",
    ...extra,
  })

const text = (anchors: string | null, arcs: string | null) =>
  ({
    databaseId: "db_text",
    properties: { anchors, arcs },
    levels: [],
    formats: [],
    statusOptions: [],
  }) as never

describe("workshopGaps", () => {
  it("is empty for a whole workshop", () => {
    const whole = project("w", {
      sections: [
        base("stories", { universePropertyId: "u" }),
        base("characters"),
        base("locations"),
        base("universes"),
        base("arcs"),
        base("anchors", { arcsPropertyId: "a", universePropertyId: "u" }),
        base("notes"),
      ],
      stories: [storySummary("s", { databaseId: "db_s", text: text("x", "y") })],
    })
    expect(workshopGaps(whole)).toEqual({ roles: [], links: [] })
    expect(hasGaps(workshopGaps(whole))).toBe(false)
  })

  it("names the bases a workshop of the first stages lacks, in the order they are made", () => {
    const early = project("w", {
      sections: [base("stories"), base("characters"), base("locations")],
    })
    expect(workshopGaps(early).roles).toEqual(["universes", "arcs", "anchors", "notes"])
    expect(hasGaps(workshopGaps(early))).toBe(true)
  })

  it("finds the links lacking where both ends exist, and only there", () => {
    const partial = project("w", {
      sections: [
        base("stories"),
        base("characters", { storiesPropertyId: null }),
        base("universes"),
        base("anchors"),
        base("arcs"),
        base("notes"),
      ],
      stories: [storySummary("s", { databaseId: "db_s", text: text(null, null) })],
    })
    const gaps = workshopGaps(partial)
    expect(gaps.roles).toEqual([])
    expect(gaps.links).toEqual(
      expect.arrayContaining([
        "stories:characters",
        "universe",
        "anchors:arcs",
        "anchors:universe",
        "text:s:anchors",
        "text:s:arcs",
      ]),
    )
    // No universes base: nothing to link the stories or the anchors to.
    const noUniverses = project("w", {
      sections: [
        base("stories"),
        base("anchors"),
        base("arcs"),
        base("notes"),
        base("universes", { state: "missing" }),
      ],
    })
    expect(workshopGaps(noUniverses).links).not.toContain("universe")
    expect(workshopGaps(noUniverses).links).not.toContain("anchors:universe")
  })

  it("leaves a section whose database was not found, and a workshop that is read-only", () => {
    const lost = project("w", {
      sections: [
        base("stories"),
        base("characters", { state: "missing", storiesPropertyId: null }),
      ],
    })
    expect(workshopGaps(lost).links).toEqual([])
    const frozen = project("w", { readOnly: true, sections: [base("stories")] })
    expect(workshopGaps(frozen)).toEqual({ roles: [], links: [] })
  })
})
