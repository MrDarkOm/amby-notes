// Pure wiki-link parsing + link-graph helpers, extracted from workspace.tsx so
// they can be unit-tested in isolation (no React/Tauri imports). The graph is
// normally computed in Rust (get_link_graph); buildLinkGraph here backs the
// browser-only dev fallback and the tests.

import type { TreeItem } from "./sidebar-tree"
import type { LinkGraph, LinkGraphNode, LinkGraphEdge } from "@/lib/storage"
import { protectedMarkdownRanges } from "./markdown-tags"

const WIKI_LINK_RE = /\[\[([^\]\r\n]+)\]\]/gu

/**
 * Strip alias (`|`) and in-note anchors (`#heading`, `^block-id`) to get the
 * target note name. Mirrors vault_index::normalize_wiki_target on the Rust side.
 * Preserves original casing; use normalizeLookup() for case-insensitive lookup.
 */
export function normalizeWikiLinkTarget(raw: string): string {
  return raw
    .split("|")[0]
    .split(/[#^]/)[0] // strip both heading anchors (#) and block anchors (^)
    .trim()
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
}

/** Case/locale-insensitive, NFC-normalized key for matching note names. */
export function normalizeLookup(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase()
}

export function extractWikiLinks(
  content: string,
): Array<{ raw: string; target: string; label: string }> {
  const links: Array<{ raw: string; target: string; label: string }> = []
  const protectedRanges = protectedMarkdownRanges(content)
  WIKI_LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WIKI_LINK_RE.exec(content)) !== null) {
    if (protectedRanges.some((range) => m!.index >= range.from && m!.index < range.to)) continue
    const raw = m[1]
    const [targetPart, aliasPart] = raw.split("|")
    const target = normalizeWikiLinkTarget(targetPart ?? "")
    if (!target) continue
    links.push({ raw, target, label: (aliasPart ?? targetPart ?? target).trim() || target })
  }
  return links
}

function collectFileItems(items: TreeItem[]): TreeItem[] {
  const files: TreeItem[] = []
  const walk = (list: TreeItem[]) => {
    for (const item of list) {
      if (item.type === "file") files.push(item)
      if (item.children) walk(item.children)
    }
  }
  walk(items)
  return files
}

export function findWikiLinkItem(
  items: TreeItem[],
  target: string,
  vault: string | null,
): TreeItem | null {
  const normalizedTarget = normalizeLookup(normalizeWikiLinkTarget(target))
  if (!normalizedTarget) return null
  const normalizedVault = vault?.replace(/\\/g, "/") ?? ""

  function walk(list: TreeItem[]): TreeItem | null {
    for (const item of list) {
      if (item.type === "file") {
        const id = (item.path ?? item.id).replace(/\\/g, "/")
        const relativePath =
          normalizedVault && id.startsWith(normalizedVault + "/")
            ? id.slice(normalizedVault.length + 1)
            : (id.split("/").pop() ?? id)
        const pathWithoutExt = relativePath.replace(/\.md$/i, "")
        if (
          normalizeLookup(item.name) === normalizedTarget ||
          normalizeLookup(pathWithoutExt) === normalizedTarget
        ) {
          return item
        }
      }
      if (item.children) {
        const found = walk(item.children)
        if (found) return found
      }
    }
    return null
  }

  return walk(items)
}

export function buildLinkGraph(
  items: TreeItem[],
  contents: Record<string, string>,
  vault: string | null,
): LinkGraph {
  const files = collectFileItems(items)
  const nodes = new Map<string, LinkGraphNode>()
  const edges: LinkGraphEdge[] = []

  for (const file of files) nodes.set(file.id, { id: file.id, label: file.name })

  for (const file of files) {
    const content = contents[file.id] ?? ""
    for (const link of extractWikiLinks(content)) {
      const targetItem = findWikiLinkItem(items, link.target, vault)
      const targetId = targetItem?.id ?? `missing:${normalizeLookup(link.target)}`
      if (!nodes.has(targetId)) {
        nodes.set(targetId, { id: targetId, label: link.target, unresolved: true })
      }
      edges.push({ source: file.id, target: targetId, label: link.label, unresolved: !targetItem })
    }
  }

  return { nodes: [...nodes.values()], edges }
}
