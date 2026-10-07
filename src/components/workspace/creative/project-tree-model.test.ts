import { describe, expect, it } from "vitest"
import { buildProjectTree, groupSections, sectionName } from "./project-tree-model"
import { catalog, project, section, universeCatalog } from "./project-fixtures.test-support"

describe("project tree model", () => {
  it("puts stories under their collection and keeps stand-alone stories at the top", () => {
    const tree = buildProjectTree(universeCatalog())
    expect(tree.map((node) => node.project.projectId)).toEqual(["palooverse", "tale"])
    expect(tree[0].stories.map((node) => node.project.projectId)).toEqual(["molehills"])
    expect(tree[1].stories).toEqual([])
  })

  it("shows a story whose collection is missing from the catalog instead of hiding it", () => {
    const orphan = project("orphan", { collectionId: "gone" })
    expect(buildProjectTree(catalog([orphan])).map((node) => node.project.projectId)).toEqual([
      "orphan",
    ])
  })

  it("gathers sections under the file's groups in the file's order, loose ones last", () => {
    const story = universeCatalog().projects.find((entry) => entry.projectId === "molehills")!
    const groups = groupSections(story)
    expect(groups.map((group) => [group.id, group.name])).toEqual([
      ["work", "Произведение"],
      ["world", "Мир"],
      [null, null],
    ])
    expect(groups[0].sections.map((entry) => entry.id)).toEqual(["notes", "text"])
    expect(groups[2].sections.map((entry) => entry.id)).toEqual(["loose"])
  })

  it("omits empty groups and sends sections of an unknown group to the loose block", () => {
    const entry = project("p", {
      groups: [{ id: "empty", name: "Пусто" }],
      sections: [section("a", { groupId: "unknown" })],
    })
    expect(groupSections(entry).map((group) => group.id)).toEqual([null])
  })

  it("names a section by its database, then by its folder, then by its id", () => {
    expect(sectionName(section("a", { databaseName: " Имя " }))).toBe("Имя")
    expect(sectionName(section("a", { databaseName: null, pathHint: "Dir/Folder" }))).toBe("Folder")
    expect(sectionName(section("a", { databaseName: null, pathHint: "" }))).toBe("a")
  })
})
