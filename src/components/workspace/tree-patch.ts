import type { TreeItem, TreePatch, TreePatchOp } from "@/lib/storage"

// Applies the sidebar-tree patch the backend builds from the disk after a mutation or a watcher
// event (`src-tauri/src/vault/tree_patch.rs`). The backend rebuilds every touched entry with the
// same code that builds the whole tree, so applying its patch gives the tree a full reload would.
// What stays here is the place of an item among its siblings: folders, bundles and databases
// first, then files, each by lower-case name in code point order (what `build_tree` does).
//
// A patch that cannot be applied (its parent is not in the tree, a shallow refresh of an item the
// tree does not have) yields `null`, and the caller reloads the whole tree instead.

function pathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "")
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right)
}

function separatorIndex(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
}

function baseName(path: string): string {
  return path.slice(separatorIndex(path) + 1)
}

function parentDirectory(path: string): string | null {
  const at = separatorIndex(path)
  return at > 0 ? path.slice(0, at) : null
}

function stem(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(0, dot) : name
}

/** The folder an item stands for in the tree, if it stands for one (a bundle stands for its folder). */
function itemDirectory(item: TreeItem, vault: string): string | null {
  if (item.type === "folder" || item.type === "database") return item.path
  const parent = parentDirectory(item.path)
  if (parent && !samePath(parent, vault) && stem(baseName(item.path)) === baseName(parent))
    return parent
  return null
}

interface SortKey {
  directory: boolean
  name: string
}

function sortKey(item: TreeItem, vault: string): SortKey {
  const directory = itemDirectory(item, vault)
  return directory
    ? { directory: true, name: baseName(directory).toLowerCase() }
    : { directory: false, name: baseName(item.path).toLowerCase() }
}

/** UTF-16 order differs from code point order only between astral characters and U+E000..U+FFFF. */
function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    let a = left.charCodeAt(index)
    let b = right.charCodeAt(index)
    if (a === b) continue
    if (a >= 0xe000) a -= 0x800
    else if (a >= 0xd800) a += 0x2000
    if (b >= 0xe000) b -= 0x800
    else if (b >= 0xd800) b += 0x2000
    return a - b
  }
  return left.length - right.length
}

function compareKeys(left: SortKey, right: SortKey): number {
  if (left.directory !== right.directory) return left.directory ? -1 : 1
  return compareCodePoints(left.name, right.name)
}

function sameChildren(left: TreeItem[] | undefined, right: TreeItem[] | undefined): boolean {
  if (left === right) return true
  if (!left || !right || left.length !== right.length) return false
  return left.every((item, index) => sameItem(item, right[index]!))
}

function sameItem(left: TreeItem, right: TreeItem): boolean {
  return (
    left === right ||
    (left.id === right.id &&
      left.path === right.path &&
      left.name === right.name &&
      left.type === right.type &&
      left.icon === right.icon &&
      left.created === right.created &&
      left.modified === right.modified &&
      sameChildren(left.children, right.children))
  )
}

function removeFrom(children: TreeItem[], paths: string[]): TreeItem[] {
  const next = children.filter((child) => !paths.some((path) => samePath(path, child.path)))
  return next.length === children.length ? children : next
}

function upsertInto(
  children: TreeItem[],
  item: TreeItem,
  replaceChildren: boolean,
  vault: string,
): TreeItem[] | null {
  const existingAt = children.findIndex((child) => samePath(child.path, item.path))
  const existing = existingAt === -1 ? undefined : children[existingAt]
  if (!replaceChildren && !existing) return null
  const next: TreeItem =
    replaceChildren || !existing ? item : { ...item, children: existing.children }
  if (existing && sameItem(existing, next)) return children

  const without = existing ? children.filter((_, index) => index !== existingAt) : children.slice()
  const key = sortKey(next, vault)
  let at = without.findIndex((sibling) => compareKeys(sortKey(sibling, vault), key) > 0)
  if (at === -1) at = without.length
  without.splice(at, 0, next)
  return without
}

function isInside(item: TreeItem, path: string, vault: string): boolean {
  const directory = itemDirectory(item, vault)
  if (!directory || !pathKey(path).startsWith(pathKey(directory))) return false
  const next = pathKey(path).charAt(pathKey(directory).length)
  return next === "/"
}

function withChildren(
  items: TreeItem[],
  parentPath: string | null,
  vault: string,
  update: (children: TreeItem[]) => TreeItem[] | null,
): TreeItem[] | null {
  if (parentPath === null) return update(items)
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!
    const own = samePath(item.path, parentPath)
    if (!own && !(item.children && isInside(item, parentPath, vault))) continue
    const children = item.children ?? []
    const next = own ? update(children) : withChildren(children, parentPath, vault, update)
    if (next === null) return null
    if (next === children) return items
    const copy = items.slice()
    copy[index] = { ...item, children: next }
    return copy
  }
  return null
}

function applyOp(items: TreeItem[], op: TreePatchOp, vault: string): TreeItem[] | null {
  return withChildren(items, op.parentPath, vault, (children) =>
    op.kind === "remove"
      ? removeFrom(children, op.paths)
      : upsertInto(children, op.item, op.replaceChildren, vault),
  )
}

/**
 * The tree without any item at one of `paths`, wherever it sits: paths that no longer exist on the
 * disk (a moved or deleted entry may still stand where an optimistic update left it).
 */
export function removePaths(items: TreeItem[], paths: ReadonlySet<string>): TreeItem[] {
  if (paths.size === 0) return items
  const normalizedPaths = new Set([...paths].map(pathKey))
  let changed = false
  const next: TreeItem[] = []
  for (const item of items) {
    if (normalizedPaths.has(pathKey(item.path))) {
      changed = true
      continue
    }
    const children = item.children ? removePaths(item.children, paths) : undefined
    if (children !== item.children) {
      changed = true
      next.push({ ...item, children })
    } else {
      next.push(item)
    }
  }
  return changed ? next : items
}

/** The patch of several mutations that ran one after another, or `null` if one of them has none. */
export function concatTreePatches(patches: Array<TreePatch | null | undefined>): TreePatch | null {
  if (patches.some((patch) => !patch)) return null
  return { ops: (patches as TreePatch[]).flatMap((patch) => patch.ops) }
}

/**
 * The tree after `patch`, or `null` when the patch does not fit the tree. `vault` is the vault
 * folder as the backend spells it. An unchanged tree comes back as the same array.
 */
export function applyTreePatchOps(
  items: TreeItem[],
  patch: TreePatch,
  vault: string,
): TreeItem[] | null {
  let current = items
  for (const op of patch.ops) {
    const next = applyOp(current, op, vault)
    if (next === null) return null
    current = next
  }
  return current
}

/** The items a patch puts into the tree, with their descendants: what tab titles may follow. */
export function patchedItems(patch: TreePatch): TreeItem[] {
  const out: TreeItem[] = []
  const visit = (item: TreeItem) => {
    out.push(item)
    item.children?.forEach(visit)
  }
  for (const op of patch.ops) if (op.kind === "upsert") visit(op.item)
  return out
}
