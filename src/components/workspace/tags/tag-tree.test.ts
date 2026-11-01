import { describe, expect, it } from "vitest"

import { buildTagTree, sortTagTree } from "./tag-tree"

const file = (id: string) => ({ item: id, path: "" })
const entry = (tag: string, files: string[], direct = files) => ({
  tag,
  files: files.map(file),
  direct: direct.map(file),
})

describe("tag tree", () => {
  const entries = [
    entry("inbox", ["a", "b"], []),
    entry("inbox/to-read", ["a"]),
    entry("inbox/done", ["b"]),
    entry("zeta", ["a", "b", "c"]),
  ]

  it("nests tags under their parent and keeps unrelated ones as roots", () => {
    const tree = buildTagTree(entries)
    expect(tree.map((node) => node.tag)).toEqual(["inbox", "zeta"])
    expect(tree[0].children.map((node) => node.label)).toEqual(["to-read", "done"])
  })

  it("keeps a tag whose parent is not listed as a root", () => {
    expect(buildTagTree([entry("a/b", ["x"])]).map((node) => node.tag)).toEqual(["a/b"])
  })

  it("sorts every level by name or by count", () => {
    const byName = sortTagTree(buildTagTree(entries), "name")
    expect(byName[0].children.map((node) => node.label)).toEqual(["done", "to-read"])
    const byCount = sortTagTree(buildTagTree(entries), "count")
    expect(byCount.map((node) => node.tag)).toEqual(["zeta", "inbox"])
  })
})
