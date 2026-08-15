import type { TreeItem } from "./sidebar-tree"

export interface FolderCounts {
  notes: number
  folders: number
}

export function countFolderContents(folder: TreeItem): FolderCounts {
  return (folder.children ?? []).reduce<FolderCounts>(
    (counts, item) => {
      if (item.type === "folder") counts.folders += 1
      if (item.type === "file") counts.notes += 1
      const nested = countFolderContents(item)
      counts.folders += nested.folders
      counts.notes += nested.notes
      return counts
    },
    { notes: 0, folders: 0 },
  )
}
