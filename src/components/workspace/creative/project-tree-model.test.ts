import { describe, expect, it } from "vitest"
import {
  groupSections,
  listScopes,
  resolveScope,
  sectionName,
  writableCollection,
} from "./project-tree-model"
import { catalog, project, section, universeCatalog } from "./project-fixtures.test-support"

describe("project tree model", () => {
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

describe("creative scopes", () => {
  it("lists the top-level collections in catalog order, not the nested ones", () => {
    const scopes = catalog([
      project("first", { kind: "collection" }),
      project("story"),
      project("inner", { kind: "collection", collectionId: "first" }),
      project("second", { kind: "collection", collectionId: "gone" }),
    ])
    expect(listScopes(scopes).map((entry) => entry.projectId)).toEqual(["first", "second"])
  })

  it("keeps a wanted collection that exists and falls back from one that does not", () => {
    const universe = universeCatalog()
    expect(resolveScope(universe, "palooverse")).toBe("palooverse")
    expect(resolveScope(universe, "gone")).toBe("palooverse")
  })

  it("keeps the stand-alone bucket the author chose, even an empty one", () => {
    expect(resolveScope(universeCatalog(), null)).toBeNull()
    const onlyCollection = catalog([project("c", { kind: "collection" })])
    expect(resolveScope(onlyCollection, null)).toBeNull()
  })

  it("starts on the first collection before any choice", () => {
    expect(resolveScope(universeCatalog(), undefined)).toBe("palooverse")
    expect(resolveScope(catalog([project("tale")]), undefined)).toBeNull()
  })

  it("shows the stand-alone bucket when there is no collection, even empty", () => {
    expect(resolveScope(catalog([project("tale")]), "palooverse")).toBeNull()
    expect(resolveScope(catalog([]), null)).toBeNull()
  })

  it("offers no writable collection for a read-only one", () => {
    const universe = universeCatalog()
    const palooverse = universe.projects.find((entry) => entry.projectId === "palooverse")!
    expect(writableCollection(palooverse)?.projectId).toBe("palooverse")
    expect(writableCollection({ ...palooverse, readOnly: true })).toBeNull()
    expect(writableCollection(null)).toBeNull()
  })
})
