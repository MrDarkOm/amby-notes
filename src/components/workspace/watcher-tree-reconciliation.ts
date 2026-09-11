import type { TreeItem } from "./sidebar-tree"
import type { FsMutationResult } from "@/lib/storage"

const LOCAL_MUTATION_TTL_MS = 2_000
const recentLocalMutationPaths = new Map<string, number>()
let activeLocalTreeMutations = 0

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "")
}

function parentPath(path: string): string | null {
  const normalized = normalizePath(path)
  const index = normalized.lastIndexOf("/")
  return index > 0 ? normalized.slice(0, index) : null
}

/** Keep watcher refreshes queued until the originating renderer finishes its mutation. */
export function beginLocalTreeMutation(): () => void {
  activeLocalTreeMutations += 1
  let finished = false
  return () => {
    if (finished) return
    finished = true
    activeLocalTreeMutations = Math.max(0, activeLocalTreeMutations - 1)
  }
}

export function hasActiveLocalTreeMutation(): boolean {
  return activeLocalTreeMutations > 0
}

export function recordLocalTreePaths(paths: Iterable<string>, now = Date.now()): void {
  const expiresAt = now + LOCAL_MUTATION_TTL_MS
  for (const rawPath of paths) {
    if (!rawPath) continue
    const path = normalizePath(rawPath)
    recentLocalMutationPaths.set(path, expiresAt)
    const parent = parentPath(path)
    if (parent) recentLocalMutationPaths.set(parent, expiresAt)
  }
}

/** Record the exact files and containing directories already applied to the local tree. */
export function recordLocalTreeMutation(result: FsMutationResult, now = Date.now()): void {
  recordLocalTreePaths(
    [
      result.primaryPath ?? "",
      ...result.pathChanges.flatMap((change) => [change.oldPath, change.newPath]),
      ...result.deletedPaths,
    ],
    now,
  )
}

export function filterLocalTreeWatcherChanges<
  T extends { path: string; duringLocalMutation?: boolean },
>(changes: T[], now = Date.now()): T[] {
  for (const [path, expiresAt] of recentLocalMutationPaths) {
    if (expiresAt <= now) recentLocalMutationPaths.delete(path)
  }
  return changes.filter(
    (change) =>
      !change.duringLocalMutation || !recentLocalMutationPaths.has(normalizePath(change.path)),
  )
}

interface OpenDocumentLocation {
  path: string
  title: string
}

/** Folder events and root-level rescan notifications also cover open descendants. */
export function watcherChangeAffectsDocument(documentPath: string, changedPath: string): boolean {
  const document = normalizePath(documentPath)
  const changed = normalizePath(changedPath)
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
