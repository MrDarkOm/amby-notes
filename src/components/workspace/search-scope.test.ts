import { describe, expect, it } from "vitest"
import { isInSearchScope, searchScopesFor, topLevelSearchScopes } from "./search-scope"
import type { TreeItem } from "./sidebar-tree"

const tree: TreeItem[] = [
  { id: "root.md", path: "/v/root.md", name: "root", type: "file" },
  {
    id: "work",
    path: "/v/work",
    name: "work",
    type: "folder",
    children: [
      { id: "work/plan.md", path: "/v/work/plan.md", name: "plan", type: "file" },
      {
        id: "work/old",
        path: "/v/work/old",
        name: "old",
        type: "folder",
        children: [{ id: "work/old/a.md", path: "/v/work/old/a.md", name: "a", type: "file" }],
      },
    ],
  },
]

describe("searchScopesFor", () => {
  it("offers the folders around the open note, nearest first, nested notes included", () => {
    const scopes = searchScopesFor(tree, "work/old/a.md")
    expect(scopes.map((scope) => scope.name)).toEqual(["old", "work"])
    expect(isInSearchScope(scopes[1]!, { id: "work/old/a.md", path: "" })).toBe(true)
    expect(isInSearchScope(scopes[1]!, { id: "root.md", path: "/v/root.md" })).toBe(false)
  })

  it("tells where each folder sits and how much it holds", () => {
    const [old, work] = searchScopesFor(tree, "work/old/a.md")
    expect([old?.path, old?.itemCount]).toEqual(["work", 1])
    expect([work?.path, work?.itemCount]).toEqual(["", 2])
  })

  it("starts from an open folder itself", () => {
    expect(searchScopesFor(tree, "work/old").map((scope) => scope.name)).toEqual(["old", "work"])
  })

  it("matches a note by path when the index reports a different id", () => {
    const [scope] = searchScopesFor(tree, "work/old")
    expect(isInSearchScope(scope!, { id: "other", path: "/v/work/old/a.md" })).toBe(true)
  })

  it("leaves out a folder that holds the whole vault", () => {
    const wrapped: TreeItem[] = [
      { id: "all", path: "/v/all", name: "all", type: "folder", children: tree },
    ]
    expect(searchScopesFor(wrapped, "work/plan.md").map((scope) => scope.name)).toEqual(["work"])
  })

  it("has nothing to offer for a note at the vault root or an unknown item", () => {
    expect(searchScopesFor(tree, "root.md")).toEqual([])
    expect(searchScopesFor(tree, "missing")).toEqual([])
    expect(searchScopesFor(tree, null)).toEqual([])
  })
})

describe("topLevelSearchScopes", () => {
  it("offers the folders at the top of the vault, not one that holds all of it", () => {
    expect(topLevelSearchScopes(tree).map((scope) => scope.name)).toEqual(["work"])
    const wrapped: TreeItem[] = [
      { id: "all", path: "/v/all", name: "all", type: "folder", children: tree },
    ]
    expect(topLevelSearchScopes(wrapped)).toEqual([])
  })
})
