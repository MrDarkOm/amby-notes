import type { TreeItem } from "../sidebar-tree"

export interface BreadcrumbSegment {
  id: string
  name: string
  kind: "file" | "folder"
}

export function stripMdExt(name: string): string {
  return name.replace(/\.md$/iu, "")
}

export function relativeToVault(path: string, vault: string): string {
  const normalizedPath = path.replace(/\\/gu, "/")
  const normalizedVault = vault.replace(/\\/gu, "/").replace(/\/+$/u, "")
  return normalizedPath.startsWith(`${normalizedVault}/`)
    ? normalizedPath.slice(normalizedVault.length + 1)
    : normalizedPath
}

export function findBreadcrumbTrail(items: TreeItem[], targetId: string): TreeItem[] | null {
  for (const item of items) {
    if (item.id === targetId) return [item]
    if (item.children) {
      const sub = findBreadcrumbTrail(item.children, targetId)
      if (sub) return [item, ...sub]
    }
  }
  return null
}

export function flattenTree(items: TreeItem[]): TreeItem[] {
  const result: TreeItem[] = []
  for (const item of items) {
    result.push(item)
    if (item.children) result.push(...flattenTree(item.children))
  }
  return result
}

export function buildBreadcrumb(
  treeItems: TreeItem[] | undefined,
  docId: string | undefined,
): BreadcrumbSegment[] {
  if (!treeItems || !docId) return []
  const trail = findBreadcrumbTrail(treeItems, docId)
  if (!trail) return []
  const segments: BreadcrumbSegment[] = []
  for (let i = 0; i < trail.length; i++) {
    const item = trail[i]
    const next = trail[i + 1]
    if (
      next &&
      item.type === "folder" &&
      next.type === "file" &&
      stripMdExt(item.name) === stripMdExt(next.name)
    ) {
      continue
    }
    segments.push({
      id: item.id,
      name: stripMdExt(item.name),
      kind: item.type === "folder" ? "folder" : "file",
    })
  }
  return segments
}
