import { describe, expect, it } from "vitest"
import type { TreeItem } from "@/lib/storage"
import { dropFolderFor, skippedSummary } from "./use-tree-file-drop"

const item = (type: string, path: string) => ({ id: path, name: "x", type, path }) as TreeItem

describe("dropFolderFor", () => {
  it("takes a drop on a folder inside it", () => {
    expect(dropFolderFor(item("folder", "/v/Ideas"), "/v")).toBe("/v/Ideas")
  })
  it("puts a drop on a note beside the note", () => {
    expect(dropFolderFor(item("file", "/v/Ideas/a.md"), "/v")).toBe("/v/Ideas")
  })
  it("uses the folder around a note that has a folder of its own", () => {
    expect(dropFolderFor(item("file", "/v/Ideas/a/a.md"), "/v")).toBe("/v/Ideas")
  })
  it("means the root for a note at the root, with Windows separators too", () => {
    expect(dropFolderFor(item("file", "/v/a.md"), "/v")).toBeNull()
    expect(dropFolderFor(item("file", "C:\\v\\Ideas\\a.md"), "C:\\v")).toBe("C:/v/Ideas")
    expect(dropFolderFor(item("file", "C:\\v\\a.md"), "C:\\v")).toBeNull()
  })
})

describe("skippedSummary", () => {
  it("lists every name with its reason", () => {
    expect(
      skippedSummary(
        [
          { name: "a.md", reason: "hidden" },
          { name: "b.bin", reason: "too_large" },
        ],
        (reason) => `<${reason}>`,
      ),
    ).toBe("a.md (<hidden>)\nb.bin (<too_large>)")
  })
})
