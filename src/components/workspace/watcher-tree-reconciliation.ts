import type { TreeItem } from "./sidebar-tree"

interface OpenDocumentLocation {
  path: string
  title: string
}

/** Folder events and root-level rescan notifications also cover open descendants. */
export function watcherChangeAffectsDocument(documentPath: string, changedPath: string): boolean {
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "")
  const document = normalize(documentPath)
  const changed = normalize(changedPath)
  return document === changed || document.startsWith(`${changed}/`)
}

export type OpenDocumentTreeChange =
  | { kind: "deleted"; fileId: string }
  | { kind: "relocated"; fileId: string; path: string; title: string }

function indexFiles(
  items: TreeItem[],
  target = new Map<string, TreeItem>(),
): Map<string, TreeItem> {
  for (const item of items) {
    if (item.type === "file") target.set(item.id, item)
    if (item.children) indexFiles(item.children, target)
  }
  return target
}

/**
 * Reconcile open stable-ID documents against a coalesced filesystem refresh.
 * Raw watcher kinds are intentionally absent: macOS can report a move out as
 * `rename`, while other backends may report `remove` + `create`.
 */
export function planOpenDocumentTreeChanges(
  openDocs: Record<string, OpenDocumentLocation>,
  tree: TreeItem[],
): OpenDocumentTreeChange[] {
  const filesById = indexFiles(tree)
  const changes: OpenDocumentTreeChange[] = []
  for (const [fileId, document] of Object.entries(openDocs)) {
    const item = filesById.get(fileId)
    if (!item || item.type !== "file") {
      changes.push({ kind: "deleted", fileId })
    } else if (item.path !== document.path || item.name !== document.title) {
      changes.push({ kind: "relocated", fileId, path: item.path, title: item.name })
    }
  }
  return changes
}
