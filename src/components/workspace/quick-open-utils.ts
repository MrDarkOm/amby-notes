import type { TreeItem } from "./sidebar-tree"

/** Keep cmdk item values unique while preserving name and path search terms. */
export function quickOpenItemValue(file: TreeItem): string {
  return [file.name, file.path ?? "", file.id].join(" ")
}
