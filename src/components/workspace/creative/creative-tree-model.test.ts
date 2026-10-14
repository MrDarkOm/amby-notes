import { describe, expect, it } from "vitest"
import type { TreeItem } from "../tree/tree-types"
import { applyCreativeTree, collectionForFolder } from "./creative-tree-model"
import {
  catalog,
  storySummary,
  workshopSection,
  workshopSummary,
} from "./project-fixtures.test-support"

const VAULT = "/vault"

const folder = (path: string, children: TreeItem[] = [], icon = "folder"): TreeItem => ({
  id: path,
  path: `${VAULT}/${path}`,
  name: path.split("/").pop() ?? path,
  type: "folder",
  icon,
  children,
})

const database = (path: string, id: string, icon = "database"): TreeItem => ({
  id,
  path: `${VAULT}/${path}`,
  name: path.split("/").pop() ?? path,
  type: "database",
  icon,
})

const note = (path: string): TreeItem => ({
  id: path,
  path: `${VAULT}/${path}`,
  name: path.split("/").pop() ?? path,
  type: "file",
  icon: "file",
})

function fixture() {
  const workshop = workshopSummary("pv", {
    path: "PaulooVerse",
    sections: [
      workshopSection("chars", { role: "characters", databaseId: "db_chars" }),
      workshopSection("notes", { role: "notes", databaseId: "db_notes" }),
      workshopSection("loose", { role: "custom", databaseId: "db_loose" }),
    ],
    stories: [
      storySummary("mh", {
        folderPath: "PaulooVerse/MoleHills",
        databaseId: "db_text",
      }),
    ],
  })
  const plain = workshopSummary("shelf", { path: "Shelf" })
  const tree: TreeItem[] = [
    folder("PaulooVerse", [
      database("PaulooVerse/Персонажи", "db_chars"),
      folder("PaulooVerse/MoleHills", [
        database("PaulooVerse/MoleHills/Текст", "db_text"),
        database("PaulooVerse/MoleHills/Заметки", "db_notes"),
        database("PaulooVerse/MoleHills/Прочее", "db_loose"),
      ]),
    ]),
    folder("Shelf"),
    folder("Ordinary", [note("Ordinary/a.md")]),
    note("b.md"),
  ]
  return { cat: catalog([workshop, plain]), tree }
}

const iconOf = (items: TreeItem[] | undefined, id: string): string | undefined => {
  for (const item of items ?? []) {
    if (item.id === id) return item.icon
    const inner = iconOf(item.children, id)
    if (inner !== undefined) return inner
  }
  return undefined
}

describe("applyCreativeTree", () => {
  it("gives a workshop, a story and the sections their own icons", () => {
    const { cat, tree } = fixture()
    const shown = applyCreativeTree(tree, cat, VAULT, true)
    expect(iconOf(shown, "PaulooVerse")).toContain("amby-icon:feather:")
    expect(iconOf(shown, "PaulooVerse/MoleHills")).toContain("amby-icon:book-open:")
    expect(iconOf(shown, "Shelf")).toContain("amby-icon:feather:")
    expect(iconOf(shown, "db_chars")).toContain("amby-icon:users:")
    expect(iconOf(shown, "db_notes")).toContain("amby-icon:sticky-note:")
  })

  it("leaves ordinary folders, notes and sections without a role alone", () => {
    const { cat, tree } = fixture()
    const shown = applyCreativeTree(tree, cat, VAULT, true)
    expect(iconOf(shown, "Ordinary")).toBe("folder")
    expect(iconOf(shown, "db_loose")).toBe("database")
    expect(shown[2]).toBe(tree[2])
    expect(shown[3]).toBe(tree[3])
  })

  it("keeps an icon the author chose", () => {
    const { cat } = fixture()
    const chosen = "amby-icon:rocket:%23ff0000"
    const tree = [
      folder("PaulooVerse", [database("PaulooVerse/Персонажи", "db_chars", chosen)], chosen),
    ]
    const shown = applyCreativeTree(tree, cat, VAULT, true)
    expect(iconOf(shown, "PaulooVerse")).toBe(chosen)
    expect(iconOf(shown, "db_chars")).toBe(chosen)
  })

  it("puts the icon of a workshop and of a story at the end of its row, and nothing on ordinary folders", () => {
    const { cat, tree } = fixture()
    const shown = applyCreativeTree(tree, cat, VAULT, true)
    expect(shown[0].statusIcon).toContain("amby-icon:feather:")
    expect(shown[0].children?.[1].statusIcon).toContain("amby-icon:book-open:")
    expect(shown[2].statusIcon).toBeUndefined()
  })

  it("keeps the icon the author chose, but the end of the row still says what the folder is", () => {
    const { cat } = fixture()
    const chosen = "amby-icon:rocket:%23ff0000"
    const shown = applyCreativeTree([folder("PaulooVerse", [], chosen)], cat, VAULT, true)
    expect(iconOf(shown, "PaulooVerse")).toBe(chosen)
    expect(shown[0].statusIcon).toContain("amby-icon:feather:")
  })

  it("uses the icon of the structure file when the workshop has one", () => {
    const own = workshopSummary("pv", { path: "PaulooVerse", icon: "🪐" })
    const shown = applyCreativeTree([folder("PaulooVerse")], catalog([own]), VAULT, true)
    expect(iconOf(shown, "PaulooVerse")).toBe("🪐")
    expect(shown[0].statusIcon).toBe("🪐")
  })

  it("leaves out a moved section database when switched off, and keeps a missing one out of the index", () => {
    const moved = workshopSummary("pv", {
      path: "PaulooVerse",
      sections: [
        workshopSection("chars", { role: "characters", databaseId: "db_chars", state: "moved" }),
        workshopSection("gone", { role: "locations", databaseId: "db_gone", state: "missing" }),
      ],
    })
    const tree = [
      folder("PaulooVerse"),
      database("Elsewhere/Персонажи", "db_chars"),
      database("Elsewhere/Локации", "db_gone"),
    ]
    const shown = applyCreativeTree(tree, catalog([moved]), VAULT, false)
    expect(shown.map((item) => item.id)).toEqual(["db_gone"])
  })

  it("leaves out every creative folder and section database when switched off", () => {
    const { cat, tree } = fixture()
    const shown = applyCreativeTree(tree, cat, VAULT, false)
    expect(shown.map((item) => item.id)).toEqual(["Ordinary", "b.md"])
  })

  it("returns the same array when there is nothing to change", () => {
    const { tree } = fixture()
    expect(applyCreativeTree(tree, catalog([]), VAULT, false)).toBe(tree)
    expect(applyCreativeTree(tree, null, VAULT, false)).toBe(tree)
    expect(applyCreativeTree(tree, fixture().cat, null, false)).toBe(tree)
    const plainOnly = [folder("Ordinary"), note("b.md")]
    expect(applyCreativeTree(plainOnly, fixture().cat, VAULT, true)).toBe(plainOnly)
  })

  it("does not hide the vault when a workshop sits at its root", () => {
    const root = workshopSummary("root", { path: "" })
    const tree = [folder("Ordinary"), note("b.md")]
    expect(applyCreativeTree(tree, catalog([root]), VAULT, false)).toBe(tree)
  })
})

describe("collectionForFolder", () => {
  it("finds the workshop a folder is", () => {
    const { cat, tree } = fixture()
    expect(collectionForFolder(tree[0], cat, VAULT)?.workshopId).toBe("pv")
    expect(collectionForFolder(tree[1], cat, VAULT)?.workshopId).toBe("shelf")
  })

  it("is nothing for an ordinary folder, a note or a database", () => {
    const { cat, tree } = fixture()
    const story = tree[0].children?.[1] as TreeItem
    expect(collectionForFolder(story, cat, VAULT)).toBeNull()
    expect(collectionForFolder(tree[2], cat, VAULT)).toBeNull()
    expect(collectionForFolder(tree[3], cat, VAULT)).toBeNull()
    expect(collectionForFolder(database("Shelf", "db_x"), cat, VAULT)).toBeNull()
    expect(collectionForFolder(tree[0], null, VAULT)).toBeNull()
    expect(collectionForFolder(tree[0], cat, null)).toBeNull()
  })
})
