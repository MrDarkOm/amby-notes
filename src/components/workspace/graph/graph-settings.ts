import { GRAPH_GROUP_COLORS } from "@/themes/palettes"
import type { LinkGraph } from "../panel-registry"

/** A colour group: every node matched by `query` is painted with `color`. */
export interface GraphGroup {
  id: string
  query: string
  color: string
}

/** What the link graph shows and how it lays out; saved per vault in `moduleSettings.graph`. */
export interface GraphSettings {
  search: string
  showTags: boolean
  showAttachments: boolean
  existingOnly: boolean
  showOrphans: boolean
  groups: GraphGroup[]
  showArrows: boolean
  /** Zoom at which labels fade in, as a power of two: 0 is the default, -3..3. */
  textFadeThreshold: number
  nodeSize: number
  linkThickness: number
  centerForce: number
  repelForce: number
  linkForce: number
  linkDistance: number
}

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  search: "",
  showTags: false,
  showAttachments: false,
  existingOnly: false,
  showOrphans: true,
  groups: [],
  showArrows: false,
  textFadeThreshold: 0,
  nodeSize: 1,
  linkThickness: 1,
  centerForce: 0.5,
  repelForce: 10,
  linkForce: 1,
  linkDistance: 250,
}

/** Slider ranges; values read from disk are clamped into them. */
export const GRAPH_RANGES = {
  textFadeThreshold: { min: -3, max: 3, step: 0.1 },
  nodeSize: { min: 0.1, max: 5, step: 0.05 },
  linkThickness: { min: 0.1, max: 5, step: 0.05 },
  centerForce: { min: 0, max: 1, step: 0.01 },
  repelForce: { min: 0, max: 20, step: 0.1 },
  linkForce: { min: 0, max: 1, step: 0.01 },
  linkDistance: { min: 30, max: 500, step: 1 },
} as const

export type GraphRangeKey = keyof typeof GRAPH_RANGES

/** Colours offered to a new group in turn. */
export const GROUP_COLORS: readonly string[] = GRAPH_GROUP_COLORS

function clamp(value: unknown, key: GraphRangeKey): number {
  const { min, max } = GRAPH_RANGES[key]
  const fallback = DEFAULT_GRAPH_SETTINGS[key]
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

/** Reads saved settings defensively: unknown or broken fields fall back to the defaults. */
export function normalizeGraphSettings(raw: unknown): GraphSettings {
  const saved = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const d = DEFAULT_GRAPH_SETTINGS
  const groups = Array.isArray(saved.groups)
    ? saved.groups.flatMap((group, index): GraphGroup[] => {
        if (!group || typeof group !== "object") return []
        const g = group as Record<string, unknown>
        return [
          {
            id: typeof g.id === "string" && g.id ? g.id : `group-${index}`,
            query: typeof g.query === "string" ? g.query : "",
            color:
              typeof g.color === "string" && /^#[0-9a-f]{6}$/iu.test(g.color)
                ? g.color
                : GROUP_COLORS[index % GROUP_COLORS.length],
          },
        ]
      })
    : []
  return {
    search: typeof saved.search === "string" ? saved.search : d.search,
    showTags: bool(saved.showTags, d.showTags),
    showAttachments: bool(saved.showAttachments, d.showAttachments),
    existingOnly: bool(saved.existingOnly, d.existingOnly),
    showOrphans: bool(saved.showOrphans, d.showOrphans),
    groups,
    showArrows: bool(saved.showArrows, d.showArrows),
    textFadeThreshold: clamp(saved.textFadeThreshold, "textFadeThreshold"),
    nodeSize: clamp(saved.nodeSize, "nodeSize"),
    linkThickness: clamp(saved.linkThickness, "linkThickness"),
    centerForce: clamp(saved.centerForce, "centerForce"),
    repelForce: clamp(saved.repelForce, "repelForce"),
    linkForce: clamp(saved.linkForce, "linkForce"),
    linkDistance: clamp(saved.linkDistance, "linkDistance"),
  }
}

export type GraphNodeKind = "note" | "tag" | "attachment" | "missing"

export interface GraphViewNode {
  id: string
  label: string
  kind: GraphNodeKind
  /** Tags of a note, without `#`, lower-case. */
  tags: string[]
  path?: string
}

export interface GraphViewEdge {
  source: string
  target: string
  unresolved?: boolean
}

export interface GraphView {
  nodes: GraphViewNode[]
  edges: GraphViewEdge[]
}

const NOTE_EXTENSION = /\.(md|markdown)$/iu
const FILE_EXTENSION = /\.[a-z0-9]{1,8}$/iu

/** An unresolved link that names a file other than a note points at an attachment. */
function linkKind(unresolved: boolean | undefined, label: string): GraphNodeKind {
  if (!unresolved) return "note"
  const target = label.split(/[#|]/u)[0].trim()
  return FILE_EXTENSION.test(target) && !NOTE_EXTENSION.test(target) ? "attachment" : "missing"
}

export const TAG_NODE_PREFIX = "tag:"

/**
 * Builds the graph that is drawn: the link graph, tag nodes when asked for, then the filters.
 * `noteTags` maps a note id to its tags; `notePaths` gives the vault path used by `path:` queries.
 */
export function buildGraphView(
  graph: LinkGraph | undefined,
  settings: GraphSettings,
  noteTags: ReadonlyMap<string, string[]> = new Map(),
  notePaths: ReadonlyMap<string, string> = new Map(),
): GraphView {
  const nodes: GraphViewNode[] = (graph?.nodes ?? []).map((node) => ({
    id: node.id,
    label: node.label,
    kind: linkKind(node.unresolved, node.label),
    tags: noteTags.get(node.id) ?? [],
    path: notePaths.get(node.id),
  }))
  const edges: GraphViewEdge[] = (graph?.edges ?? []).map((edge) => ({
    source: edge.source,
    target: edge.target,
    unresolved: edge.unresolved,
  }))

  if (settings.showTags) {
    const tagIds = new Set<string>()
    for (const node of nodes) {
      if (node.kind !== "note") continue
      for (const tag of node.tags) {
        const id = `${TAG_NODE_PREFIX}${tag}`
        tagIds.add(id)
        edges.push({ source: node.id, target: id })
      }
    }
    for (const id of tagIds) {
      const tag = id.slice(TAG_NODE_PREFIX.length)
      nodes.push({ id, label: `#${tag}`, kind: "tag", tags: [tag] })
    }
  }

  const search = parseGraphQuery(settings.search)
  const kept = new Set(
    nodes
      .filter((node) => {
        if (node.kind === "attachment" && !settings.showAttachments) return false
        if (node.kind === "missing" && settings.existingOnly) return false
        if (search && node.kind !== "tag" && !matchesGraphQuery(node, search)) return false
        return true
      })
      .map((node) => node.id),
  )
  const keptEdges = edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target))
  if (!settings.showOrphans) {
    const linked = new Set<string>()
    for (const edge of keptEdges) {
      linked.add(edge.source)
      linked.add(edge.target)
    }
    for (const id of kept) if (!linked.has(id)) kept.delete(id)
  }
  // A tag that lost all its notes to the search has nothing to say.
  const tagged = new Set(keptEdges.map((edge) => edge.target))
  return {
    nodes: nodes.filter(
      (node) => kept.has(node.id) && (node.kind !== "tag" || tagged.has(node.id)),
    ),
    edges: keptEdges,
  }
}

interface GraphQueryTerm {
  field: "text" | "tag" | "path"
  value: string
}

/**
 * A query is a list of terms that must all match: `tag:#name`, `path:folder` or plain words
 * searched in the title. Matching ignores case.
 */
export function parseGraphQuery(query: string): GraphQueryTerm[] | null {
  const terms = query
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((raw): GraphQueryTerm => {
      const lower = raw.toLowerCase()
      if (lower.startsWith("tag:"))
        return { field: "tag", value: lower.slice(4).replace(/^#/u, "") }
      if (lower.startsWith("path:")) return { field: "path", value: lower.slice(5) }
      if (lower.startsWith("#") && lower.length > 1) return { field: "tag", value: lower.slice(1) }
      return { field: "text", value: lower }
    })
    .filter((term) => term.value.length > 0)
  return terms.length ? terms : null
}

export function matchesGraphQuery(node: GraphViewNode, terms: GraphQueryTerm[]): boolean {
  return terms.every((term) => {
    if (term.field === "tag")
      return node.tags.some((tag) => tag === term.value || tag.startsWith(`${term.value}/`))
    if (term.field === "path") return (node.path ?? "").toLowerCase().includes(term.value)
    return node.label.toLowerCase().includes(term.value)
  })
}

/** The colour of the first group whose query matches the node, if any. */
export function groupColorFor(
  node: GraphViewNode,
  groups: ReadonlyArray<{ color: string; terms: GraphQueryTerm[] | null }>,
): string | undefined {
  return groups.find((group) => group.terms && matchesGraphQuery(node, group.terms))?.color
}
