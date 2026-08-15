import { describe, expect, it } from "vitest"
import { countFolderContents } from "./folder-view-utils"
import type { TreeItem } from "./sidebar-tree"

describe("countFolderContents", () => {
  it("counts notes and folders through the complete nested tree", () => {
    const folder: TreeItem = {
      id: "projects",
      path: "/vault/projects",
      name: "Projects",
      type: "folder",
      children: [
        {
          id: "projects/active",
          path: "/vault/projects/active",
          name: "Active",
          type: "folder",
          children: [
            {
              id: "note-1",
              path: "/vault/projects/active/one.md",
              name: "One.md",
              type: "file",
            },
          ],
        },
        {
          id: "supernote",
          path: "/vault/projects/supernote.md",
          name: "Supernote.md",
          type: "file",
          children: [
            {
              id: "nested-note",
              path: "/vault/projects/supernote/nested.md",
              name: "Nested.md",
              type: "file",
            },
          ],
        },
        {
          id: "canvas",
          path: "/vault/projects/map.canvas",
          name: "Map.canvas",
          type: "canvas",
        },
      ],
    }

    expect(countFolderContents(folder)).toEqual({ notes: 3, folders: 1 })
  })
})
