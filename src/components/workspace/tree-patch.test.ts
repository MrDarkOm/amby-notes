import { describe, expect, it } from "vitest"
import type { TreeItem, TreePatch } from "@/lib/storage"
import { applyTreePatchOps, concatTreePatches, patchedItems, removePaths } from "./tree-patch"

const V = "/vault"

function note(path: string, id = path): TreeItem {
  const name = path.split("/").pop()!.replace(/\.md$/u, "")
  return { id, path, name, type: "file", icon: "file", created: 1, modified: 1 }
}

function folder(path: string, children: TreeItem[] = []): TreeItem {
  return {
    id: `folder:${path}`,
    path,
    name: path.split("/").pop()!,
    type: "folder",
    icon: "folder",
    created: 1,
    modified: 1,
    children,
  }
}

/** A bundle: its main note stands for the folder. */
function bundle(dir: string, children: TreeItem[] = []): TreeItem {
  const name = dir.split("/").pop()!
  return { ...note(`${dir}/${name}.md`), children }
}

const upsert = (
  parentPath: string | null,
  item: TreeItem,
  replaceChildren = true,
): TreePatch["ops"][number] => ({ kind: "upsert", parentPath, item, replaceChildren })

const names = (items: TreeItem[] | undefined) => (items ?? []).map((item) => item.name)

describe("applyTreePatchOps", () => {
  it("puts a new file in its sorted place: case-insensitive, folders and bundles first", () => {
    const tree = [
      bundle(`${V}/beta`),
      folder(`${V}/Zeta`),
      note(`${V}/Alpha.md`),
      note(`${V}/delta.md`),
    ]
    const next = applyTreePatchOps(
      tree,
      { ops: [upsert(null, note(`${V}/Charlie.md`)), upsert(null, folder(`${V}/alpha folder`))] },
      V,
    )
    // Folders and bundles are one group by directory name; files follow.
    expect(names(next!)).toEqual(["alpha folder", "beta", "Zeta", "Alpha", "Charlie", "delta"])
  })

  it("removes an entry by any of its alternative paths", () => {
    const tree = [folder(`${V}/F`, [bundle(`${V}/F/Old`), note(`${V}/F/Keep.md`)])]
    const next = applyTreePatchOps(
      tree,
      {
        ops: [
          {
            kind: "remove",
            parentPath: `${V}/F`,
            paths: [`${V}/F/Old`, `${V}/F/Old/Old.md`, `${V}/F/Old/Old.canvas`],
          },
        ],
      },
      V,
    )
    expect(names(next![0]!.children)).toEqual(["Keep"])
  })

  it("replaces a whole subtree when children are replaced, and keeps them otherwise", () => {
    const tree = [folder(`${V}/F`, [note(`${V}/F/a.md`), note(`${V}/F/b.md`)])]
    const rebuilt = { ...folder(`${V}/F`, [note(`${V}/F/c.md`)]), modified: 9 }
    const replaced = applyTreePatchOps(tree, { ops: [upsert(null, rebuilt)] }, V)
    expect(names(replaced![0]!.children)).toEqual(["c"])

    const shallow = { ...folder(`${V}/F`), modified: 9, children: undefined }
    const refreshed = applyTreePatchOps(tree, { ops: [upsert(null, shallow, false)] }, V)
    expect(refreshed![0]!.modified).toBe(9)
    expect(names(refreshed![0]!.children)).toEqual(["a", "b"])
  })

  it("finds a parent inside a bundle and inside a folder in a bundle", () => {
    const inner = folder(`${V}/B/Inner`, [note(`${V}/B/Inner/x.md`)])
    const tree = [bundle(`${V}/B`, [inner])]
    const next = applyTreePatchOps(
      tree,
      { ops: [upsert(`${V}/B/Inner`, note(`${V}/B/Inner/a.md`))] },
      V,
    )
    expect(names(next![0]!.children![0]!.children)).toEqual(["a", "x"])
    const intoBundle = applyTreePatchOps(
      tree,
      { ops: [upsert(`${V}/B/B.md`, note(`${V}/B/child.md`))] },
      V,
    )
    expect(names(intoBundle![0]!.children)).toEqual(["Inner", "child"])
  })

  it("does not apply a patch that does not fit, so the caller reloads", () => {
    const tree = [folder(`${V}/F`)]
    expect(
      applyTreePatchOps(tree, { ops: [upsert(`${V}/Missing`, note(`${V}/Missing/a.md`))] }, V),
    ).toBeNull()
    expect(
      applyTreePatchOps(tree, { ops: [upsert(null, folder(`${V}/Unknown`), false)] }, V),
    ).toBeNull()
  })

  it("orders by code point, not by UTF-16 unit (an emoji sorts after a CJK name)", () => {
    const tree = [folder(`${V}/日本語`)]
    const next = applyTreePatchOps(tree, { ops: [upsert(null, folder(`${V}/🔥`))] }, V)
    expect(names(next!)).toEqual(["日本語", "🔥"])
  })

  it("is the same array when nothing changes", () => {
    const tree = [folder(`${V}/F`, [note(`${V}/F/a.md`)])]
    const same = applyTreePatchOps(
      tree,
      {
        ops: [
          { kind: "remove", parentPath: `${V}/F`, paths: [`${V}/F/none.md`] },
          upsert(`${V}/F`, note(`${V}/F/a.md`)),
        ],
      },
      V,
    )
    expect(same).toBe(tree)
  })

  it("applies operations in order: a removal first, then the insert at the new place", () => {
    const tree = [folder(`${V}/A`, [note(`${V}/A/n.md`)]), folder(`${V}/B`)]
    const moved = note(`${V}/B/n.md`)
    const next = applyTreePatchOps(
      tree,
      {
        ops: [
          { kind: "remove", parentPath: `${V}/A`, paths: [`${V}/A/n.md`] },
          upsert(`${V}/B`, moved),
        ],
      },
      V,
    )
    expect(names(next![0]!.children)).toEqual([])
    expect(names(next![1]!.children)).toEqual(["n"])
  })

  it("treats a note named like the vault folder at the root as a plain file", () => {
    const tree = [folder(`${V}/F`)]
    const next = applyTreePatchOps(tree, { ops: [upsert(null, note(`${V}/vault.md`))] }, V)
    expect(names(next!)).toEqual(["F", "vault"])
  })
})

describe("patchedItems", () => {
  it("lists upserted items with their descendants", () => {
    const patch: TreePatch = {
      ops: [
        { kind: "remove", parentPath: null, paths: ["x"] },
        upsert(null, folder(`${V}/F`, [note(`${V}/F/a.md`)])),
      ],
    }
    expect(patchedItems(patch).map((item) => item.name)).toEqual(["F", "a"])
  })
})

describe("removePaths", () => {
  it("drops items wherever they sit and keeps untouched branches", () => {
    const keep = folder(`${V}/Keep`, [note(`${V}/Keep/a.md`)])
    const tree = [keep, folder(`${V}/F`, [note(`${V}/F/ghost.md`), note(`${V}/F/stay.md`)])]
    const next = removePaths(tree, new Set([`${V}/F/ghost.md`]))
    expect(next[0]).toBe(keep)
    expect(names(next[1]!.children)).toEqual(["stay"])
  })

  it("is the same array when nothing matches", () => {
    const tree = [folder(`${V}/F`)]
    expect(removePaths(tree, new Set(["/nowhere"]))).toBe(tree)
    expect(removePaths(tree, new Set())).toBe(tree)
  })
})

describe("concatTreePatches", () => {
  it("joins the patches of consecutive mutations in order", () => {
    const first: TreePatch = { ops: [{ kind: "remove", parentPath: null, paths: ["a"] }] }
    const second: TreePatch = { ops: [{ kind: "remove", parentPath: null, paths: ["b"] }] }
    expect(concatTreePatches([first, second])).toEqual({ ops: [...first.ops, ...second.ops] })
  })

  it("has no patch when one mutation had none", () => {
    expect(concatTreePatches([{ ops: [] }, null])).toBeNull()
    expect(concatTreePatches([undefined])).toBeNull()
  })
})
