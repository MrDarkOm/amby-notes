import type { TreeItem } from "./sidebar-tree"

/** Keep cmdk item values unique while preserving name and path search terms. */
export function quickOpenRelativePath(file: TreeItem, vault?: string | null): string {
  const path = (file.path ?? file.name).replace(/\\/g, "/")
  const root = vault?.replace(/\\/g, "/").replace(/\/+$/, "")
  if (root && (path === root || path.startsWith(`${root}/`))) return path.slice(root.length + 1)
  return path
}

export function quickOpenItemValue(file: TreeItem, vault?: string | null): string {
  return [file.name, quickOpenRelativePath(file, vault), file.path ?? "", file.id].join(" ")
}

export function rankQuickOpenFiles(
  files: TreeItem[],
  query: string,
  vault?: string | null,
  limit = 100,
): TreeItem[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return files.slice(0, limit)
  return files
    .map((file, index) => {
      const name = file.name.toLocaleLowerCase()
      const path = quickOpenRelativePath(file, vault).toLocaleLowerCase()
      const full = `${name} ${path}`
      const nameIndex = name.indexOf(normalized)
      const pathIndex = path.indexOf(normalized)
      if (nameIndex === -1 && pathIndex === -1) return null
      const score =
        (name.startsWith(normalized) ? 0 : nameIndex >= 0 ? 10 + nameIndex : 100) +
        (pathIndex >= 0 ? pathIndex : 100) +
        (full.includes(normalized) ? 0 : 1) +
        index / 1_000_000
      return { file, score }
    })
    .filter((entry): entry is { file: TreeItem; score: number } => entry !== null)
    .sort((left, right) => left.score - right.score)
    .slice(0, limit)
    .map((entry) => entry.file)
}
