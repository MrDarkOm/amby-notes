import { describe, expect, it } from "vitest"
import i18n from "@/lib/i18n"
import {
  creativeFileId,
  creativeHistoryTarget,
  creativeTabTarget,
  isCreativeFileId,
  parseCreativeFileId,
} from "./creative-history"
import { catalog, storySummary, workshopSummary } from "./project-fixtures.test-support"

describe("workshop pages in a tab's history", () => {
  it("names the overview by the project alone and a section tab by `#<section>`", () => {
    expect(creativeFileId("story-1")).toBe("creative:story-1")
    expect(creativeFileId("story-1", "characters")).toBe("creative:story-1#characters")
    // The overview pseudo-section of the page's own memory is the entry without a section.
    expect(creativeFileId("story-1", "overview")).toBe("creative:story-1")
    expect(creativeFileId("story-1", null)).toBe("creative:story-1")
  })

  it("reads an entry an earlier version wrote unchanged", () => {
    expect(parseCreativeFileId("creative:story-1")).toEqual({
      projectId: "story-1",
      sectionId: null,
    })
    expect(parseCreativeFileId("creative:universe:u1")).toEqual({
      projectId: "universe:u1",
      sectionId: null,
    })
    expect(parseCreativeFileId("creative:standalone:w")).toEqual({
      projectId: "standalone:w",
      sectionId: null,
    })
  })

  it("reads the section back from every shape of project", () => {
    for (const projectId of ["story-1", "universe:u1", "standalone:w"]) {
      expect(parseCreativeFileId(creativeFileId(projectId, "notes"))).toEqual({
        projectId,
        sectionId: "notes",
      })
    }
  })

  it("does not take a note or the graph for a workshop page", () => {
    expect(isCreativeFileId("note-1")).toBe(false)
    expect(parseCreativeFileId("__graph__")).toBeNull()
    expect(parseCreativeFileId("creative:")).toBeNull()
    expect(parseCreativeFileId("creative:#characters")).toBeNull()
  })

  it("titles the tab with the page's name, section or not", () => {
    const stories = catalog([
      workshopSummary("w1", {
        name: "Моя мастерская",
        stories: [storySummary("hills", { name: "Холмы", workshopId: "w1" })],
      }),
    ])
    expect(creativeTabTarget(stories, i18n.t, "hills")).toEqual({
      kind: "creative",
      fileId: "creative:hills",
      title: "Холмы",
    })
    expect(creativeHistoryTarget("creative:hills#notes", stories, i18n.t)).toEqual({
      kind: "creative",
      fileId: "creative:hills#notes",
      title: "Холмы",
    })
    expect(creativeHistoryTarget("note-1", stories, i18n.t)).toBeNull()
  })
})
