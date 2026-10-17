"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { animate, type AnimationPlaybackControls } from "motion/react"
import {
  ChevronLeft,
  ChevronRight,
  LocateFixed,
  Lock,
  LockOpen,
  Maximize2,
  Minimize2,
  Network,
  RefreshCw,
  Settings2,
} from "lucide-react"
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceCollide,
  type ForceLink,
  type ForceManyBody,
  type ForceX,
  type ForceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force"
import { listTags } from "@/lib/storage"
import type { LinkGraph } from "./panel-registry"
import type { TreeItem } from "./sidebar-tree"
import { flattenFileItems } from "./workspace-tree-utils"
import { findTabTreeItem } from "./tab-target"
import { ToolbarButton } from "./common/toolbar-button"
import {
  buildGraphView,
  DEFAULT_GRAPH_SETTINGS,
  TAG_NODE_PREFIX,
  groupColorFor,
  parseGraphQuery,
  type GraphNodeKind,
  type GraphSettings,
} from "./graph/graph-settings"
import { useGraphSettingsStore } from "./graph/graph-settings-store"
import { GraphSettingsPanel } from "./graph/graph-settings-panel"
import { GraphMoreMenu, GraphResetDialog } from "./graph/graph-controls"
import { useGraphLayoutStore, type GraphPoint } from "./graph/graph-layout-store"

interface GraphTabViewProps {
  graph?: LinkGraph
  selectedId?: string | null
  onSelect: (id: string) => void
  /** Used to read tags of notes for tag nodes and `tag:` queries. */
  vault?: string | null
  /** Gives note paths for `path:` queries. */
  treeItems?: TreeItem[]
  /** The graph is a page in the tab history: these step through it like a note's header. */
  onBack?: () => void
  onForward?: () => void
  canGoBack?: boolean
  canGoForward?: boolean
  /** Cmd/Ctrl-click on a node opens its note in a new tab. */
  onOpenInNewTab?: (id: string) => void
  /** A click on a tag node shows that tag in the tags panel. */
  onTagClick?: (tag: string) => void
  /** Reads the links again from the index. */
  onRefresh?: () => void
  isFocusMode?: boolean
  onToggleFocusMode?: () => void
}

interface SimNode extends SimulationNodeDatum {
  id: string
  label: string
  kind: GraphNodeKind
  /** Radius at node size 1; grows with the number of links. */
  baseRadius: number
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: string | SimNode
  target: string | SimNode
  unresolved?: boolean
}

const ZOOM_MIN = 0.1
const ZOOM_MAX = 4
/** Above this many nodes labels wait for a closer zoom: text is most of the SVG cost. */
const LARGE_GRAPH = 200
/** Opacity of everything outside the hovered node and its neighbours. */
const HOVER_DIM = 0.12
/** How much a hovered node swells. */
const HOVER_GROW = 1.35
/** Share of the remaining way to the target zoom covered each frame of a wheel zoom. */
const ZOOM_EASE = 0.28
/**
 * While the layout is far from settled (opening, Refresh, Animate) the simulation runs this
 * many extra steps per frame, so the graph unfolds at a lively pace and only the last gentle
 * settling runs in real time. Very large graphs keep one step per frame.
 */
const FAST_STEPS = 2
const FAST_ALPHA = 0.15
const FAST_MAX_NODES = 1500
/** A pointer that moved less than this many pixels on a node clicked it instead of dragging. */
const CLICK_SLOP = 4

interface Viewport {
  tx: number
  ty: number
  zoom: number
}

const clampZoom = (zoom: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom))

/**
 * Where the nodes stood when the graph was last shown. Going Back to the graph from a note
 * mounts it again; the layout continues from here instead of starting over.
 */
const lastPositions = new Map<string, { x: number; y: number }>()
/** The view the graph was last shown with (its centre point and zoom), restored the same way. */
let lastCamera: { cx: number; cy: number; zoom: number } | null = null

/** Solid fills (see `.amby-graph` in the theme): a translucent node let its links show through. */
const NODE_CLASS: Record<GraphNodeKind, string> = {
  note: "graph-node-note",
  tag: "graph-node-tag",
  attachment: "graph-node-attachment",
  missing: "graph-node-missing",
}

/** A hub is only a little larger than a leaf, so a busy note does not swallow its neighbours. */
function nodeRadius(degree: number, size: number): number {
  return size * (4.5 + Math.min(5, Math.sqrt(degree)))
}

const LABEL_LENGTH = 30

function shortLabel(label: string): string {
  return label.length > LABEL_LENGTH ? `${label.slice(0, LABEL_LENGTH - 1).trimEnd()}…` : label
}

/** UI values are kept in the familiar ranges; these are the d3-force strengths they stand for. */
function forceParams(settings: GraphSettings) {
  return {
    // Roomy defaults (Obsidian-like): neighbours of a hub stand far enough apart for their labels.
    distance: settings.linkDistance * 0.5,
    linkStrength: settings.linkForce,
    charge: -settings.repelForce * 30,
    center: settings.centerForce * 0.16,
  }
}

function relativePath(path: string, vault: string | null | undefined): string {
  const normalized = path.replace(/\\/gu, "/")
  const root = vault?.replace(/\\/gu, "/").replace(/\/+$/u, "")
  return root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized
}

export function GraphTabView({
  graph,
  selectedId,
  onSelect,
  vault,
  treeItems,
  onBack,
  onForward,
  canGoBack = false,
  canGoForward = false,
  onOpenInNewTab,
  onTagClick,
  onRefresh,
  isFocusMode = false,
  onToggleFocusMode,
}: GraphTabViewProps) {
  const { t } = useTranslation()
  const containerRef = React.useRef<HTMLDivElement>(null)
  const svgRef = React.useRef<SVGSVGElement>(null)
  const [size, setSize] = React.useState({ w: 800, h: 600 })
  const settings = useGraphSettingsStore((s) => s.settings)
  const updateSettings = useGraphSettingsStore((s) => s.update)
  const resetSettings = useGraphSettingsStore((s) => s.reset)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [confirmReset, setConfirmReset] = React.useState(false)
  // A locked graph keeps every node where it was pinned; only new nodes find a place.
  const locked = useGraphLayoutStore((s) => s.locked)
  const pinned = useGraphLayoutStore((s) => s.positions)
  const lockedRef = React.useRef(locked)
  lockedRef.current = locked

  React.useEffect(() => {
    void useGraphSettingsStore.getState().load()
    void useGraphLayoutStore.getState().load()
  }, [vault])

  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setSize({ w: Math.max(200, r.width), h: Math.max(200, r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Tags come from the index, refreshed whenever the link graph is.
  const [noteTags, setNoteTags] = React.useState<ReadonlyMap<string, string[]>>(new Map())
  const [tagsRequest, setTagsRequest] = React.useState(0)
  React.useEffect(() => {
    if (!vault) return
    let cancelled = false
    listTags(vault)
      .then((entries) => {
        if (cancelled) return
        const next = new Map<string, string[]>()
        for (const entry of entries) {
          const tag = entry.tag.replace(/^#/u, "").toLowerCase()
          for (const note of entry.notes) {
            const list = next.get(note.id) ?? []
            if (!list.includes(tag)) list.push(tag)
            next.set(note.id, list)
          }
        }
        setNoteTags(next)
      })
      .catch(() => {
        /* the index may be rebuilding; the graph is drawn without tags */
      })
    return () => {
      cancelled = true
    }
  }, [graph, vault, tagsRequest])

  const notePaths = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const item of flattenFileItems(treeItems ?? [])) {
      map.set(item.id, relativePath(item.path ?? item.id, vault))
    }
    return map
  }, [treeItems, vault])

  // Only the filters change what is drawn; display and force settings must not rebuild the layout.
  const { search, showTags, showAttachments, existingOnly, showOrphans } = settings
  const view = React.useMemo(
    () =>
      buildGraphView(
        graph,
        { ...DEFAULT_GRAPH_SETTINGS, search, showTags, showAttachments, existingOnly, showOrphans },
        noteTags,
        notePaths,
      ),
    [graph, search, showTags, showAttachments, existingOnly, showOrphans, noteTags, notePaths],
  )
  const groupColors = React.useMemo(() => {
    const groups = settings.groups.map((g) => ({ color: g.color, terms: parseGraphQuery(g.query) }))
    const colors = new Map<string, string>()
    if (!groups.some((g) => g.terms)) return colors
    for (const node of view.nodes) {
      const color = node.kind === "note" ? groupColorFor(node, groups) : undefined
      if (color) colors.set(node.id, color)
    }
    return colors
  }, [settings.groups, view])

  // What a click on a node opens. A link the index could not resolve to a note may still name a
  // folder, a canvas or another file of the tree; a link to nothing at all opens nothing.
  const clickTargets = React.useMemo(() => {
    const targets = new Map<string, { kind: "item"; id: string } | { kind: "tag"; tag: string }>()
    for (const node of view.nodes) {
      if (node.kind === "note") targets.set(node.id, { kind: "item", id: node.id })
      else if (node.kind === "tag")
        targets.set(node.id, { kind: "tag", tag: node.id.slice(TAG_NODE_PREFIX.length) })
      else {
        const target = node.label.split(/[#|]/u)[0].trim()
        const item = target ? findTabTreeItem(treeItems ?? [], target, vault) : null
        if (item) targets.set(node.id, { kind: "item", id: item.id })
      }
    }
    return targets
  }, [treeItems, vault, view])

  const rawNodeCount = graph?.nodes.length ?? 0
  const rawEdgeCount = graph?.edges.length ?? 0

  // Keep stable refs to node objects across re-renders so positions persist.
  const nodeMapRef = React.useRef<Map<string, SimNode>>(new Map())
  React.useEffect(
    () => () => {
      lastPositions.clear()
      nodeMapRef.current.forEach((n) => {
        if (n.x != null && n.y != null) lastPositions.set(n.id, { x: n.x, y: n.y })
      })
    },
    [],
  )
  const simRef = React.useRef<Simulation<SimNode, SimLink> | null>(null)
  const nodeElementRef = React.useRef<Map<string, SVGGElement>>(new Map())
  const edgeElementRef = React.useRef<Map<string, SVGLineElement>>(new Map())
  // Labels live in their own layer above every node and link, so nothing covers the text.
  const labelElementRef = React.useRef<Map<string, SVGTextElement>>(new Map())
  // D3 owns coordinates during a simulation. React owns topology and UI state.
  const rafRef = React.useRef<number | null>(null)
  const settingsRef = React.useRef(settings)
  settingsRef.current = settings

  // Build / sync sim nodes and links whenever the drawn graph changes.
  const { simNodes, simLinks, startAlpha } = React.useMemo(() => {
    const degree = new Map<string, number>()
    for (const edge of view.edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
    }
    const next = new Map<string, SimNode>()
    let placedAtRandom = 0
    let kept = 0
    view.nodes.forEach((n) => {
      const baseRadius = nodeRadius(degree.get(n.id) ?? 0, 1)
      const prev = nodeMapRef.current.get(n.id)
      const pin = locked ? pinned.get(n.id) : undefined
      if (prev) {
        kept += 1
        prev.label = n.label
        prev.kind = n.kind
        prev.baseRadius = baseRadius
        next.set(n.id, prev)
      } else {
        const last = pin ?? lastPositions.get(n.id)
        if (!last) placedAtRandom += 1
        next.set(n.id, {
          id: n.id,
          label: n.label,
          kind: n.kind,
          baseRadius,
          x: last?.x ?? (Math.random() - 0.5) * 60,
          y: last?.y ?? (Math.random() - 0.5) * 60,
        })
      }
      const node = next.get(n.id)!
      if (pin) {
        node.x = node.fx = pin.x
        node.y = node.fy = pin.y
      } else {
        node.fx = null
        node.fy = null
      }
    })
    nodeMapRef.current = next
    const simNodes = Array.from(next.values())
    const simLinks: SimLink[] = view.edges.flatMap((e) => {
      const source = next.get(e.source)
      const target = next.get(e.target)
      return source && target ? [{ source, target, unresolved: e.unresolved }] : []
    })
    // New nodes need a full layout; a changed graph that is already on screen only settles; a
    // graph shown again exactly where it was left does not move at all.
    const startAlpha = placedAtRandom > 0 ? 1 : kept > 0 ? 0.3 : 0
    return { simNodes, simLinks, startAlpha }
  }, [view, locked, pinned])

  const linkKey = React.useCallback(
    (edge: SimLink, index: number) =>
      `${typeof edge.source === "string" ? edge.source : edge.source.id}-${typeof edge.target === "string" ? edge.target : edge.target.id}-${index}`,
    [],
  )

  const { showArrows, nodeSize } = settings
  const applyScenePositions = React.useCallback(() => {
    simNodes.forEach((node) => {
      const element = nodeElementRef.current.get(node.id)
      if (!element || node.x == null || node.y == null) return
      const transform = `translate(${node.x} ${node.y})`
      element.setAttribute("transform", transform)
      labelElementRef.current.get(node.id)?.setAttribute("transform", transform)
    })
    simLinks.forEach((edge, index) => {
      const element = edgeElementRef.current.get(linkKey(edge, index))
      const source = edge.source as SimNode
      const target = edge.target as SimNode
      if (!element || source.x == null || source.y == null || target.x == null || target.y == null)
        return
      let x2 = target.x
      let y2 = target.y
      // An arrow head must stop at the rim of its node instead of hiding under it.
      if (showArrows) {
        const dx = target.x - source.x
        const dy = target.y - source.y
        const length = Math.hypot(dx, dy)
        const rim = target.baseRadius * nodeSize + 1
        if (length > rim) {
          x2 = target.x - (dx / length) * rim
          y2 = target.y - (dy / length) * rim
        }
      }
      element.setAttribute("x1", String(source.x))
      element.setAttribute("y1", String(source.y))
      element.setAttribute("x2", String(x2))
      element.setAttribute("y2", String(y2))
    })
  }, [linkKey, nodeSize, showArrows, simLinks, simNodes])
  const applyRef = React.useRef(applyScenePositions)
  applyRef.current = applyScenePositions

  // Create / restart simulation.
  React.useEffect(() => {
    if (simNodes.length === 0) return
    const params = forceParams(settingsRef.current)
    const sim = forceSimulation<SimNode>(simNodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(params.distance)
          .strength(params.linkStrength),
      )
      .force("charge", forceManyBody().strength(params.charge))
      .force("center", forceCenter(0, 0).strength(1))
      .force("x", forceX(0).strength(params.center))
      .force("y", forceY(0).strength(params.center))
      .force(
        "collide",
        forceCollide<SimNode>((d) => d.baseRadius * settingsRef.current.nodeSize + 6),
      )
      .alpha(startAlpha)
      // d3's own slow cooling: the layout glides into place instead of snapping.
      .alphaDecay(0.0228)
      .velocityDecay(0.35)
      .on("tick", () => {
        // A held node (alphaTarget) keeps real-time steps so dragging stays direct.
        if (
          sim.alpha() > FAST_ALPHA &&
          sim.alphaTarget() === 0 &&
          simNodes.length <= FAST_MAX_NODES
        ) {
          sim.tick(FAST_STEPS)
        }
        // Throttle direct SVG attribute writes to one animation frame. The
        // simulation no longer causes a React render/commit per tick.
        if (rafRef.current !== null) return
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null
          applyRef.current()
        })
      })

    simRef.current = sim
    const frame = requestAnimationFrame(() => applyRef.current())
    return () => {
      cancelAnimationFrame(frame)
      sim.stop()
      if (simRef.current === sim) simRef.current = null
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [simLinks, simNodes, startAlpha])

  // Moving a force slider retunes the running simulation instead of rebuilding it.
  const { linkDistance, linkForce, repelForce, centerForce } = settings
  React.useEffect(() => {
    const sim = simRef.current
    if (!sim) return
    const params = forceParams({
      ...settingsRef.current,
      linkDistance,
      linkForce,
      repelForce,
      centerForce,
    })
    ;(sim.force("link") as ForceLink<SimNode, SimLink> | undefined)
      ?.distance(params.distance)
      .strength(params.linkStrength)
    ;(sim.force("charge") as ForceManyBody<SimNode> | undefined)?.strength(params.charge)
    ;(sim.force("x") as ForceX<SimNode> | undefined)?.strength(params.center)
    ;(sim.force("y") as ForceY<SimNode> | undefined)?.strength(params.center)
    ;(sim.force("collide") as ForceCollide<SimNode> | undefined)?.radius(
      (d) => d.baseRadius * nodeSize + 6,
    )
    sim.alpha(Math.max(sim.alpha(), 0.3)).restart()
  }, [linkDistance, linkForce, repelForce, centerForce, nodeSize])

  React.useEffect(() => {
    applyScenePositions()
  }, [applyScenePositions])

  // ── Viewport ──────────────────────────────────────────────────────────────
  // Pan and zoom write straight to the scene and to CSS variables, never through React state:
  // re-rendering every node on each pointer move is what made the view stutter.
  const sceneRef = React.useRef<SVGGElement>(null)
  const viewRef = React.useRef<Viewport>(
    lastCamera
      ? {
          zoom: lastCamera.zoom,
          tx: size.w / 2 - lastCamera.cx * lastCamera.zoom,
          ty: size.h / 2 - lastCamera.cy * lastCamera.zoom,
        }
      : { tx: size.w / 2, ty: size.h / 2, zoom: 1 },
  )
  const sizeRef = React.useRef(size)
  sizeRef.current = size
  React.useEffect(
    () => () => {
      const v = viewRef.current
      const { w, h } = sizeRef.current
      lastCamera = { cx: (w / 2 - v.tx) / v.zoom, cy: (h / 2 - v.ty) / v.zoom, zoom: v.zoom }
    },
    [],
  )
  const nodeCountRef = React.useRef(0)
  nodeCountRef.current = simNodes.length

  const applyViewport = React.useCallback(() => {
    const svg = svgRef.current
    const scene = sceneRef.current
    if (!svg || !scene) return
    const { tx, ty, zoom } = viewRef.current
    scene.setAttribute("transform", `translate(${tx} ${ty}) scale(${zoom})`)
    const current = settingsRef.current
    // Labels fade in around a zoom set by the threshold; large graphs wait for a closer zoom.
    const fadeZoom =
      0.5 * 2 ** current.textFadeThreshold * (nodeCountRef.current > LARGE_GRAPH ? 2.2 : 1)
    const labels = Math.min(1, Math.max(0, (zoom - fadeZoom) / (fadeZoom * 0.6)))
    svg.style.setProperty("--graph-label-opacity", String(labels))
    svg.style.setProperty("--graph-label-display", labels > 0 ? "inline" : "none")
    // Text grows a little as you zoom in, like Obsidian's, but stays within readable bounds.
    const screenFont = Math.min(16, Math.max(12, 12.5 * zoom ** 0.4))
    svg.style.setProperty("--graph-font", `${screenFont / zoom}px`)
    // A label keeps a small, constant gap on screen below its node at any zoom.
    svg.style.setProperty("--graph-gap", `${3 / zoom}px`)
    svg.style.setProperty("--graph-stroke", `${(1.2 * current.linkThickness) / zoom}px`)
  }, [])

  // Settings and new nodes arrive through renders; the viewport is re-applied after each one.
  React.useLayoutEffect(() => {
    applyViewport()
  })

  // A resize keeps the point that was in the middle of the view in the middle.
  const lastSizeRef = React.useRef(size)
  React.useEffect(() => {
    const last = lastSizeRef.current
    lastSizeRef.current = size
    if (last.w === size.w && last.h === size.h) return
    const v = viewRef.current
    viewRef.current = {
      ...v,
      tx: v.tx + (size.w - last.w) / 2,
      ty: v.ty + (size.h - last.h) / 2,
    }
    applyViewport()
  }, [applyViewport, size])

  // Wheel zoom eases toward its target around the point under the pointer.
  const zoomTargetRef = React.useRef<{
    sx: number
    sy: number
    gx: number
    gy: number
    zoom: number
  } | null>(null)
  const zoomFrameRef = React.useRef<number | null>(null)
  const flightRef = React.useRef<AnimationPlaybackControls | null>(null)

  const stopCamera = React.useCallback(() => {
    flightRef.current?.stop()
    flightRef.current = null
    zoomTargetRef.current = null
    if (zoomFrameRef.current !== null) cancelAnimationFrame(zoomFrameRef.current)
    zoomFrameRef.current = null
  }, [])
  React.useEffect(() => stopCamera, [stopCamera])

  const stepZoom = React.useCallback(() => {
    const target = zoomTargetRef.current
    if (!target) {
      zoomFrameRef.current = null
      return
    }
    const current = viewRef.current.zoom
    // Interpolating the logarithm makes zooming in and out feel equally fast.
    let zoom = current * (target.zoom / current) ** ZOOM_EASE
    const done = Math.abs(Math.log(target.zoom / zoom)) < 0.002
    if (done) zoom = target.zoom
    viewRef.current = { zoom, tx: target.sx - target.gx * zoom, ty: target.sy - target.gy * zoom }
    applyViewport()
    if (done) {
      zoomTargetRef.current = null
      zoomFrameRef.current = null
      return
    }
    zoomFrameRef.current = requestAnimationFrame(stepZoom)
  }, [applyViewport])

  /** Glides the camera to another viewport. */
  const flyTo = React.useCallback(
    (to: Viewport) => {
      stopCamera()
      const from = viewRef.current
      flightRef.current = animate(0, 1, {
        duration: 0.5,
        ease: [0.16, 1, 0.3, 1],
        onUpdate: (p) => {
          const zoom = from.zoom * (to.zoom / from.zoom) ** p
          viewRef.current = {
            zoom,
            tx: from.tx + (to.tx - from.tx) * p,
            ty: from.ty + (to.ty - from.ty) * p,
          }
          applyViewport()
        },
        onComplete: () => {
          flightRef.current = null
        },
      })
    },
    [applyViewport, stopCamera],
  )

  // One container in both states, so the size observer keeps measuring the element on screen.
  const isEmpty = rawNodeCount === 0 || (rawEdgeCount === 0 && !settings.showTags)
  React.useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    // React's wheel listener is passive; a native one may stop the page (or a pinch) from zooming.
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      flightRef.current?.stop()
      flightRef.current = null
      const rect = svg!.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1
      // A trackpad pinch arrives as a wheel with Ctrl held and small deltas.
      const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.012 : 0.0022))
      const v = viewRef.current
      const base = zoomTargetRef.current?.zoom ?? v.zoom
      zoomTargetRef.current = {
        sx,
        sy,
        gx: (sx - v.tx) / v.zoom,
        gy: (sy - v.ty) / v.zoom,
        zoom: clampZoom(base * factor),
      }
      if (zoomFrameRef.current === null) zoomFrameRef.current = requestAnimationFrame(stepZoom)
    }
    svg.addEventListener("wheel", onWheel, { passive: false })
    return () => svg.removeEventListener("wheel", onWheel)
  }, [isEmpty, stepZoom])

  /** The viewport that shows every node with a margin, no closer than natural size. */
  function fittedViewport(): Viewport {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    nodeMapRef.current.forEach((n) => {
      if (n.x == null || n.y == null) return
      const r = n.baseRadius * settingsRef.current.nodeSize
      minX = Math.min(minX, n.x - r)
      minY = Math.min(minY, n.y - r)
      maxX = Math.max(maxX, n.x + r)
      maxY = Math.max(maxY, n.y + r + 16)
    })
    if (!Number.isFinite(minX)) return { tx: size.w / 2, ty: size.h / 2, zoom: 1 }
    const margin = 64
    const zoom = clampZoom(
      Math.min(
        1.2,
        (size.w - margin * 2) / Math.max(1, maxX - minX),
        (size.h - margin * 2) / Math.max(1, maxY - minY),
      ),
    )
    return {
      zoom,
      tx: size.w / 2 - ((minX + maxX) / 2) * zoom,
      ty: size.h / 2 - ((minY + maxY) / 2) * zoom,
    }
  }

  // ── Hover: the node, its neighbours and their links stay lit, the rest fades ──
  const neighbors = React.useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const edge of simLinks) {
      const a = (edge.source as SimNode).id
      const b = (edge.target as SimNode).id
      if (!map.has(a)) map.set(a, new Set())
      if (!map.has(b)) map.set(b, new Set())
      map.get(a)!.add(b)
      map.get(b)!.add(a)
    }
    return map
  }, [simLinks])
  const hoveredRef = React.useRef<string | null>(null)
  const dimAnimationRef = React.useRef<AnimationPlaybackControls | null>(null)
  const dimRef = React.useRef(1)
  const growAnimationRef = React.useRef<AnimationPlaybackControls | null>(null)
  const shrinkAnimationRef = React.useRef<AnimationPlaybackControls | null>(null)
  const growRef = React.useRef(1)

  /** Elements of one node: its circle group and its label. */
  const nodeParts = React.useCallback((id: string) => {
    const parts: Element[] = []
    const node = nodeElementRef.current.get(id)
    const label = labelElementRef.current.get(id)
    if (node) parts.push(node)
    if (label) parts.push(label)
    return parts
  }, [])

  /** The hovered node swells with a little spring; the one left behind settles back. */
  const swell = React.useCallback(
    (previous: string | null, next: string | null) => {
      const svg = svgRef.current
      if (!svg) return
      shrinkAnimationRef.current?.stop()
      svg.querySelectorAll("[data-leaving]").forEach((el) => el.removeAttribute("data-leaving"))
      if (previous) {
        const parts = nodeParts(previous)
        parts.forEach((el) => el.setAttribute("data-leaving", ""))
        shrinkAnimationRef.current = animate(growRef.current, 1, {
          duration: 0.22,
          ease: "easeOut",
          onUpdate: (value) => svg.style.setProperty("--graph-shrink", String(value)),
          onComplete: () => parts.forEach((el) => el.removeAttribute("data-leaving")),
        })
      }
      growAnimationRef.current?.stop()
      growRef.current = 1
      svg.style.setProperty("--graph-grow", "1")
      if (next) {
        growAnimationRef.current = animate(1, HOVER_GROW, {
          type: "spring",
          stiffness: 520,
          damping: 18,
          onUpdate: (value) => {
            growRef.current = value
            svg.style.setProperty("--graph-grow", String(value))
          },
        })
      }
    },
    [nodeParts],
  )

  const markHover = React.useCallback(
    (id: string | null) => {
      const near = id ? (neighbors.get(id) ?? new Set<string>()) : null
      nodeElementRef.current.forEach((element, nodeId) => {
        const lit = id !== null && (nodeId === id || near!.has(nodeId))
        const label = labelElementRef.current.get(nodeId)
        for (const target of label ? [element, label] : [element]) {
          target.toggleAttribute("data-hovered", nodeId === id)
          target.toggleAttribute("data-near", id !== null && lit && nodeId !== id)
          if (id !== null) target.toggleAttribute("data-dim", !lit)
        }
      })
      simLinks.forEach((edge, index) => {
        const element = edgeElementRef.current.get(linkKey(edge, index))
        if (!element) return
        const touches =
          id !== null && ((edge.source as SimNode).id === id || (edge.target as SimNode).id === id)
        element.toggleAttribute("data-lit", touches)
        if (id !== null) element.toggleAttribute("data-dim", !touches)
      })
    },
    [linkKey, neighbors, simLinks],
  )

  const setHover = React.useCallback(
    (id: string | null) => {
      if (hoveredRef.current === id) return
      const previous = hoveredRef.current
      hoveredRef.current = id
      markHover(id)
      swell(previous, id)
      const svg = svgRef.current
      dimAnimationRef.current?.stop()
      dimAnimationRef.current = animate(dimRef.current, id ? HOVER_DIM : 1, {
        duration: id ? 0.18 : 0.3,
        ease: "easeOut",
        onUpdate: (value) => {
          dimRef.current = value
          svg?.style.setProperty("--graph-dim", String(value))
        },
        onComplete: () => {
          dimAnimationRef.current = null
          // Once everything is back to full strength the marks can go.
          if (hoveredRef.current === null) {
            svg?.querySelectorAll("[data-dim]").forEach((el) => el.removeAttribute("data-dim"))
          }
        },
      })
    },
    [markHover, swell],
  )
  React.useEffect(
    () => () => {
      dimAnimationRef.current?.stop()
      growAnimationRef.current?.stop()
      shrinkAnimationRef.current?.stop()
    },
    [],
  )
  // New or rebuilt elements take over the current hover.
  React.useEffect(() => {
    if (hoveredRef.current && !nodeMapRef.current.has(hoveredRef.current)) setHover(null)
    else markHover(hoveredRef.current)
  }, [markHover, setHover])

  // ── Pointer: pan the background, drag or click a node ─────────────────────
  const panStateRef = React.useRef<{
    startX: number
    startY: number
    baseTx: number
    baseTy: number
  } | null>(null)
  const dragStateRef = React.useRef<{
    nodeId: string
    pointerId: number
    startX: number
    startY: number
    dragging: boolean
  } | null>(null)

  function screenToGraph(clientX: number, clientY: number): { x: number; y: number } {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    const v = viewRef.current
    return { x: (clientX - rect.left - v.tx) / v.zoom, y: (clientY - rect.top - v.ty) / v.zoom }
  }

  function handleBgPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if ((e.target as Element).closest("[data-node-id]")) return
    stopCamera()
    const v = viewRef.current
    panStateRef.current = { startX: e.clientX, startY: e.clientY, baseTx: v.tx, baseTy: v.ty }
    e.currentTarget.setAttribute("data-panning", "")
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const drag = dragStateRef.current
    if (drag) {
      const node = nodeMapRef.current.get(drag.nodeId)
      if (!node) return
      if (!drag.dragging) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < CLICK_SLOP) return
        drag.dragging = true
        // A locked graph only cancels the click; its nodes stay where they were pinned.
        if (lockedRef.current) return
        // Keep the simulation warm while the node is held, so its neighbours follow it.
        simRef.current?.alphaTarget(0.3).restart()
      }
      if (lockedRef.current) return
      const g = screenToGraph(e.clientX, e.clientY)
      node.fx = g.x
      node.fy = g.y
      return
    }
    const pan = panStateRef.current
    if (pan) {
      viewRef.current = {
        ...viewRef.current,
        tx: pan.baseTx + (e.clientX - pan.startX),
        ty: pan.baseTy + (e.clientY - pan.startY),
      }
      applyViewport()
    }
  }

  function handlePointerUp(e: React.PointerEvent<SVGSVGElement>) {
    const drag = dragStateRef.current
    if (drag) {
      const node = nodeMapRef.current.get(drag.nodeId)
      if (node && !lockedRef.current) {
        node.fx = null
        node.fy = null
      }
      if (drag.dragging) simRef.current?.alphaTarget(0)
      else {
        const target = clickTargets.get(drag.nodeId)
        if (target?.kind === "tag") onTagClick?.(target.tag)
        else if (target?.kind === "item") {
          if ((e.metaKey || e.ctrlKey) && onOpenInNewTab) onOpenInNewTab(target.id)
          else onSelect(target.id)
        }
      }
      dragStateRef.current = null
      const over = (document.elementFromPoint(e.clientX, e.clientY) as Element | null)
        ?.closest("[data-node-id]")
        ?.getAttribute("data-node-id")
      setHover(over ?? null)
    }
    panStateRef.current = null
    e.currentTarget.removeAttribute("data-panning")
    try {
      ;(e.currentTarget as Element).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  function handleNodePointerDown(e: React.PointerEvent, nodeId: string) {
    e.stopPropagation()
    stopCamera()
    dragStateRef.current = {
      nodeId,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
    }
    const node = nodeMapRef.current.get(nodeId)
    if (node && !lockedRef.current) {
      node.fx = node.x
      node.fy = node.y
    }
    ;(svgRef.current as Element | null)?.setPointerCapture(e.pointerId)
  }

  function handleNodeEnter(nodeId: string) {
    if (panStateRef.current || dragStateRef.current) return
    setHover(nodeId)
  }

  function handleNodeLeave(nodeId: string) {
    // Pointer capture during a drag fires a leave; the held node stays lit.
    if (dragStateRef.current || hoveredRef.current !== nodeId) return
    setHover(null)
  }

  function recenter() {
    flyTo(fittedViewport())
  }

  /** Rebuilds the graph: links and tags are read again and, unless locked, the layout restarts. */
  function refresh() {
    onRefresh?.()
    setTagsRequest((n) => n + 1)
    if (!locked) replayLayout()
  }

  const [lockBusy, setLockBusy] = React.useState(false)
  /** Pins every node where it stands and remembers the view, or frees the graph again. */
  async function toggleLock() {
    if (lockBusy) return
    setLockBusy(true)
    try {
      if (locked) {
        await useGraphLayoutStore.getState().unlock()
        simRef.current?.alpha(0.3).restart()
      } else {
        const positions = new Map<string, GraphPoint>()
        nodeMapRef.current.forEach((n) => {
          if (n.x != null && n.y != null) positions.set(n.id, { x: n.x, y: n.y })
        })
        const v = viewRef.current
        await useGraphLayoutStore.getState().lock(positions, {
          cx: (size.w / 2 - v.tx) / v.zoom,
          cy: (size.h / 2 - v.ty) / v.zoom,
          zoom: v.zoom,
        })
        simRef.current?.stop()
      }
    } catch (error) {
      console.error("Failed to save the graph layout:", error)
    } finally {
      setLockBusy(false)
    }
  }

  // Opening a locked graph shows it the way it was when it was locked.
  const lockedCamera = useGraphLayoutStore((s) => s.camera)
  // Within a session the last view wins; the locked view is restored when the app starts.
  const cameraRestoredRef = React.useRef(lastCamera !== null)
  React.useEffect(() => {
    if (cameraRestoredRef.current || !locked || !lockedCamera) return
    cameraRestoredRef.current = true
    viewRef.current = {
      zoom: lockedCamera.zoom,
      tx: size.w / 2 - lockedCamera.cx * lockedCamera.zoom,
      ty: size.h / 2 - lockedCamera.cy * lockedCamera.zoom,
    }
    applyViewport()
  }, [applyViewport, locked, lockedCamera, size.h, size.w])

  /** Gathers every node in the middle and lets the forces spread them out again. */
  function replayLayout() {
    nodeMapRef.current.forEach((n) => {
      n.fx = null
      n.fy = null
      n.x = (Math.random() - 0.5) * 20
      n.y = (Math.random() - 0.5) * 20
      n.vx = 0
      n.vy = 0
    })
    applyScenePositions()
    simRef.current?.alpha(1).restart()
    flyTo({ tx: size.w / 2, ty: size.h / 2, zoom: 1 })
  }

  const historyNav =
    onBack || onForward ? (
      <div className="amby-graph-toolbar pointer-events-auto flex items-center gap-0.5 rounded-lg">
        <button
          type="button"
          title={t("graph.back")}
          aria-label={t("graph.back")}
          onClick={onBack}
          disabled={!canGoBack}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronLeft className="size-3.5" />
        </button>
        <button
          type="button"
          title={t("graph.forward")}
          aria-label={t("graph.forward")}
          onClick={onForward}
          disabled={!canGoForward}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronRight className="size-3.5" />
        </button>
      </div>
    ) : null

  // The bar has the geometry of a note's header (40px high, 8px side padding), so the buttons
  // sit exactly where they do above a note.
  const headerClass =
    "pointer-events-none absolute inset-x-0 top-0 z-10 flex h-10 items-center justify-between px-2"

  if (isEmpty) {
    return (
      <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-transparent">
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
          <Network className="size-12 text-muted-foreground" />
          <p className="text-[14px] text-muted-foreground">{t("graph.noLinks")}</p>
          <p className="text-[12px] text-muted-foreground">{t("graph.noLinksHint")}</p>
        </div>
        <div className={headerClass}>{historyNav ?? <span />}</div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-transparent">
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        className="amby-graph block touch-none select-none"
        onPointerDown={handleBgPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => {
          if (!dragStateRef.current) setHover(null)
        }}
      >
        {showArrows ? (
          <defs>
            <marker
              id="amby-graph-arrow"
              viewBox="0 0 10 10"
              refX={10}
              refY={5}
              markerWidth={5}
              markerHeight={5}
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" className="graph-arrow" />
            </marker>
          </defs>
        ) : null}
        <g ref={sceneRef}>
          {simLinks.map((edge, i) => {
            const s = edge.source as SimNode
            const tg = edge.target as SimNode
            if (s.x == null || s.y == null || tg.x == null || tg.y == null) return null
            const key = linkKey(edge, i)
            return (
              <line
                key={key}
                ref={(element) => {
                  if (element) edgeElementRef.current.set(key, element)
                  else edgeElementRef.current.delete(key)
                }}
                x1={s.x}
                y1={s.y}
                x2={tg.x}
                y2={tg.y}
                className={edge.unresolved ? "graph-edge-unresolved" : "graph-edge"}
                markerEnd={showArrows ? "url(#amby-graph-arrow)" : undefined}
              />
            )
          })}
          {simNodes.map((node) => {
            if (node.x == null || node.y == null) return null
            const selected = node.id === selectedId
            const r = node.baseRadius * nodeSize * (selected ? 1.4 : 1)
            const color = selected ? undefined : groupColors.get(node.id)
            return (
              <g
                key={node.id}
                ref={(element) => {
                  if (element) nodeElementRef.current.set(node.id, element)
                  else nodeElementRef.current.delete(node.id)
                }}
                transform={`translate(${node.x} ${node.y})`}
                data-node-id={node.id}
                className={clickTargets.has(node.id) ? "cursor-pointer" : "cursor-default"}
                onPointerDown={(e) => handleNodePointerDown(e, node.id)}
                onPointerEnter={() => handleNodeEnter(node.id)}
                onPointerLeave={() => handleNodeLeave(node.id)}
              >
                <circle
                  cx={0}
                  cy={0}
                  r={r}
                  className={selected ? "fill-primary" : color ? undefined : NODE_CLASS[node.kind]}
                  style={color ? { fill: color } : undefined}
                />
              </g>
            )
          })}
          <g>
            {simNodes.map((node) => {
              if (node.x == null || node.y == null) return null
              const selected = node.id === selectedId
              const r = node.baseRadius * nodeSize * (selected ? 1.4 : 1)
              return (
                <text
                  key={node.id}
                  ref={(element) => {
                    if (element) labelElementRef.current.set(node.id, element)
                    else labelElementRef.current.delete(node.id)
                  }}
                  transform={`translate(${node.x} ${node.y})`}
                  x={0}
                  y={r}
                  dominantBaseline="hanging"
                  textAnchor="middle"
                  data-focus={selected || undefined}
                  // The hover swell moves the label down by as much as the node grows.
                  style={{ "--graph-r": r } as React.CSSProperties}
                >
                  {shortLabel(node.label)}
                </text>
              )
            })}
          </g>
        </g>
      </svg>

      {simNodes.length === 0 ? (
        <p className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[13px] text-muted-foreground">
          {t("graph.nothingMatches")}
        </p>
      ) : null}

      <div className={headerClass}>
        {historyNav ?? <span />}
        <div className="amby-graph-toolbar pointer-events-auto flex items-center gap-0.5 rounded-lg">
          <TopButton title={t("graph.fit")} onClick={recenter}>
            <LocateFixed className="size-3.5" />
          </TopButton>
          {onRefresh ? (
            <TopButton title={t("graph.refresh")} onClick={refresh}>
              <RefreshCw className="size-3.5" />
            </TopButton>
          ) : null}
          {onToggleFocusMode ? (
            <TopButton
              title={isFocusMode ? t("docEditor.focusModeExit") : t("docEditor.focusModeEnter")}
              onClick={onToggleFocusMode}
            >
              {isFocusMode ? (
                <Minimize2 className="size-3.5" />
              ) : (
                <Maximize2 className="size-3.5" />
              )}
            </TopButton>
          ) : null}
          <TopButton
            title={t("graph.settings.open")}
            active={settingsOpen}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <Settings2 className="size-3.5" />
          </TopButton>
          <GraphMoreMenu
            settings={settings}
            locked={locked}
            onChange={updateSettings}
            onFit={recenter}
            onRefresh={onRefresh ? refresh : undefined}
            onAnimate={replayLayout}
            onOpenSettings={() => setSettingsOpen(true)}
            onReset={() => setConfirmReset(true)}
          />
        </div>
      </div>

      <div className="pointer-events-none absolute top-10 right-2 bottom-14 z-10 flex flex-col items-end">
        {settingsOpen ? (
          <div className="pointer-events-auto flex min-h-0 flex-col">
            <GraphSettingsPanel
              settings={settings}
              onChange={updateSettings}
              onReset={() => setConfirmReset(true)}
              onClose={() => setSettingsOpen(false)}
              onAnimate={replayLayout}
              animateDisabled={locked}
            />
          </div>
        ) : null}
      </div>

      <GraphResetDialog
        open={confirmReset}
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false)
          resetSettings()
        }}
      />

      <div className="pointer-events-none absolute right-4 bottom-2 z-10 max-w-[calc(100%-2rem)] select-none">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl border border-border/80 bg-card/90 p-1 shadow-md backdrop-blur-md">
          <span className="px-1.5 text-[11px] text-muted-foreground">
            {t("graph.stats", { nodes: simNodes.length, edges: simLinks.length })}
          </span>
          <div className="mx-0.5 h-3.5 w-px bg-border/80" />
          <ToolbarButton
            title={locked ? t("graph.unlock") : t("graph.lock")}
            aria-pressed={locked}
            active={locked}
            disabled={lockBusy}
            onClick={() => void toggleLock()}
          >
            {locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
          </ToolbarButton>
          <ToolbarButton
            title={t("graph.settings.open")}
            active={settingsOpen}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <Settings2 className="size-3.5" />
          </ToolbarButton>
        </div>
      </div>
    </div>
  )
}

function TopButton({
  title,
  active = false,
  onClick,
  children,
}: {
  title: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active || undefined}
      onClick={onClick}
      className={
        active
          ? "flex size-7 items-center justify-center rounded-md bg-accent text-foreground"
          : "flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      }
    >
      {children}
    </button>
  )
}
