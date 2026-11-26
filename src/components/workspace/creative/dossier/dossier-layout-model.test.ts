import { describe, expect, it } from "vitest"
import type { DossierLayout } from "@/lib/storage"
import {
  addField,
  addSection,
  fieldsOutsideSections,
  layoutFromBody,
  layoutHints,
  layoutProblem,
  moveSection,
  removeField,
  removeSection,
  sectionOfTitle,
  updateSection,
} from "./dossier-layout-model"

const layout: DossierLayout = {
  version: 1,
  sections: [
    { id: "basic", title: "Основное", hint: "Возраст", fields: ["role"] },
    { id: "look", title: "Внешность", hint: "", fields: ["eyes", "hair"] },
  ],
}

describe("layoutFromBody", () => {
  it("makes a layout of a template without one from its headings and the known hints", () => {
    const made = layoutFromBody(
      "## Основное\n\n## Внешность\nтекст\n## Биография\n",
      new Map([["Основное", "Возраст, занятие"]]),
    )
    expect(made.version).toBe(1)
    expect(made.sections.map((section) => [section.title, section.hint, section.fields])).toEqual([
      ["Основное", "Возраст, занятие", []],
      ["Внешность", "", []],
      ["Биография", "", []],
    ])
    expect(new Set(made.sections.map((section) => section.id)).size).toBe(3)
  })

  it("starts with one section when the body has no headings", () => {
    expect(layoutFromBody("", new Map(), "Основное").sections).toEqual([
      { id: "section-1", title: "Основное", hint: "", fields: [] },
    ])
  })
})

describe("layout edits", () => {
  it("adds a section with its own ID and moves, renames and removes sections", () => {
    const added = addSection(layout, "Голос")
    expect(added.sections.map((section) => section.title)).toEqual([
      "Основное",
      "Внешность",
      "Голос",
    ])
    expect(new Set(added.sections.map((section) => section.id)).size).toBe(3)
    expect(moveSection(added, 2, -1).sections.map((section) => section.title)).toEqual([
      "Основное",
      "Голос",
      "Внешность",
    ])
    expect(moveSection(added, 0, -1)).toBe(added)
    expect(updateSection(added, "look", { title: "Облик", hint: "Рост" }).sections[1]).toEqual({
      id: "look",
      title: "Облик",
      hint: "Рост",
      fields: ["eyes", "hair"],
    })
    expect(removeSection(added, "basic").sections.map((section) => section.id)).not.toContain(
      "basic",
    )
  })

  it("puts a field in one section only, and takes it out", () => {
    const moved = addField(layout, "look", "role")
    expect(moved.sections[0].fields).toEqual([])
    expect(moved.sections[1].fields).toEqual(["eyes", "hair", "role"])
    expect(removeField(moved, "look", "eyes").sections[1].fields).toEqual(["hair", "role"])
  })
})

describe("layout reading", () => {
  it("gives the hints by title and finds the section of a heading, in any case", () => {
    expect(layoutHints(layout)).toEqual(new Map([["Основное", "Возраст"]]))
    expect(sectionOfTitle(layout, " внешность ")?.id).toBe("look")
    expect(sectionOfTitle(layout, "Голос")).toBeNull()
  })

  it("leaves the fields placed in a section out of the header", () => {
    expect(fieldsOutsideSections(layout, ["role", "status", "eyes", "age"])).toEqual([
      "status",
      "age",
    ])
    expect(fieldsOutsideSections(null, ["role"])).toEqual(["role"])
  })
})

describe("layoutProblem", () => {
  it("says what the backend would refuse, before saving", () => {
    expect(layoutProblem(layout)).toBeNull()
    expect(layoutProblem({ ...layout, sections: [] })).toBe("empty")
    expect(layoutProblem({ ...layout, sections: [{ ...layout.sections[0], title: "  " }] })).toBe(
      "title",
    )
    expect(
      layoutProblem({
        ...layout,
        sections: [layout.sections[0], { ...layout.sections[1], title: "основное" }],
      }),
    ).toBe("duplicate")
    expect(
      layoutProblem({ ...layout, sections: [{ ...layout.sections[0], title: "# Имя" }] }),
    ).toBe("title")
  })
})
