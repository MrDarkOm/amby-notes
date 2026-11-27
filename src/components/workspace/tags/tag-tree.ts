export type TagSort = "name" | "count"

export interface TagFile<T> {
  item: T
  path: string
}

/** A tag with the notes that carry it, `direct` being those tagged with exactly this tag. */
export interface TagNode<T> {
  tag: string
  /** The last segment of a nested tag (`to-read` of `inbox/to-read`). */
  label: string
  files: Array<TagFile<T>>
  direct: Array<TagFile<T>>
  children: Array<TagNode<T>>
}

interface TagInput<T> {
  tag: string
  files: Array<TagFile<T>>
  direct: Array<TagFile<T>>
}

/** Nests tags under their parent (`inbox` holds `inbox/to-read`); a tag with no listed parent is a root. */
export function buildTagTree<T>(entries: Array<TagInput<T>>): Array<TagNode<T>> {
  const nodes = new Map<string, TagNode<T>>()
  for (const entry of entries) {
    nodes.set(entry.tag, {
      ...entry,
      label: entry.tag.slice(entry.tag.lastIndexOf("/") + 1),
      children: [],
    })
  }
  const roots: Array<TagNode<T>> = []
  for (const node of nodes.values()) {
    const cut = node.tag.lastIndexOf("/")
    const parent = cut === -1 ? undefined : nodes.get(node.tag.slice(0, cut))
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

/** Sorts every level of the tree; ties by count fall back to the name. */
export function sortTagTree<T>(nodes: Array<TagNode<T>>, sort: TagSort): Array<TagNode<T>> {
  const byName = (a: TagNode<T>, b: TagNode<T>) => a.tag.localeCompare(b.tag)
  const compare =
    sort === "count"
      ? (a: TagNode<T>, b: TagNode<T>) => b.files.length - a.files.length || byName(a, b)
      : byName
  return [...nodes].sort(compare).map((node) => ({
    ...node,
    children: sortTagTree(node.children, sort),
  }))
}
