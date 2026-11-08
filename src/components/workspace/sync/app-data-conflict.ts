// Which conflicts are about the data Amby keeps for itself in `.amby/` (docs/sync-plan.md, Р7, З69).

/** Is `path` a file of a group of note properties (`prop_<x>.jsonl`, `legacy_<x>.jsonl`)? */
export function isPropertyGroupPath(path: string): boolean {
  const normalized = path.replace(/\\/gu, "/").replace(/^\/+/u, "")
  return /^\.amby\/properties\/(?:prop|legacy)_[0-9a-f]\.jsonl$/u.test(normalized)
}

/**
 * A conflict of a file Amby keeps for itself in `.amby/` (the properties of the notes, the
 * layout of the graph): the person sees what it holds, not its path, and chooses one version.
 * "Keep both" would only leave a second JSON file nobody reads, and there is nothing to compare.
 */
export function appDataConflictKind(path: string): "properties" | "graph" | "other" | null {
  const normalized = path.replace(/\\/gu, "/").replace(/^\/+/u, "")
  if (!normalized.startsWith(".amby/")) return null
  if (
    normalized === ".amby/properties.json" ||
    /^\.amby\/properties\/(?:prop|legacy)_[0-9a-f]\.jsonl$/u.test(normalized)
  ) {
    return "properties"
  }
  if (normalized === ".amby/graph-layout.json") return "graph"
  return "other"
}
