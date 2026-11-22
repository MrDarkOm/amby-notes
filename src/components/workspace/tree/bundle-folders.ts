import type { TreeItem } from "@/lib/storage/types"
import { wsPathBase, wsPathDir } from "../workspace-tree-utils"

/** The filesystem tree remains canonical for watcher patches and mutation reconciliation. */
export function projectBundleFolders(items: TreeItem[]): TreeItem[] {
  let changed = false
  const projected = items.map((item): TreeItem => {
    const children = item.children ? projectBundleFolders(item.children) : undefined
    if (!item.bundleMembers) {
      if (children === item.children) return item
      changed = true
      return { ...item, children }
    }

    changed = true
    // A database container represents the directory. Its manifest is a member.
    const path = item.type === "database" ? item.path : wsPathDir(item.path)
    const members = item.bundleMembers.map((member): TreeItem => ({
      ...member,
      bundleMember: true,
    }))
    if (item.type !== "database") {
      members.unshift({
        ...item,
        icon: item.type,
        children: undefined,
        bundleMembers: undefined,
        bundleMember: true,
      })
    }
    return {
      id: `folder:${path}`,
      path,
      name: wsPathBase(path),
      type: "folder",
      icon: "folder",
      created: item.created,
      modified: item.modified,
      children: [...(children ?? []), ...members],
    }
  })
  return changed ? projected : items
}
