import type { Edge } from "@xyflow/react"
import { newCanvasId, arrowMarker, type CanvasFlowNode } from "@/lib/canvas-format"
import { computeAutoLayout } from "./canvas-layout"

export interface MermaidDiagnostic {
  line: number
  message: string
  severity: "error" | "warning"
}

export interface ParsedMermaidNode {
  id: string
  label: string
  shape: "rect" | "rounded" | "stadium" | "subroutine" | "cylinder" | "circle" | "asymmetric"
}

export interface ParsedMermaidEdge {
  source: string
  target: string
  label?: string
  arrow: "none" | "arrow" | "both"
}

export interface MermaidParseResult {
  direction: "TD" | "TB" | "LR" | "RL" | "BT"
  nodes: Map<string, ParsedMermaidNode>
  edges: ParsedMermaidEdge[]
  diagnostics: MermaidDiagnostic[]
  isValid: boolean
}

export function parseMermaidFlowchart(code: string): MermaidParseResult {
  const lines = code.split("\n")
  const nodes = new Map<string, ParsedMermaidNode>()
  const edges: ParsedMermaidEdge[] = []
  const diagnostics: MermaidDiagnostic[] = []

  let direction: MermaidParseResult["direction"] = "TD"
  let headerFound = false

  function ensureNode(rawId: string, label?: string, shape: ParsedMermaidNode["shape"] = "rect") {
    const id = rawId.trim()
    if (!id) return
    const existing = nodes.get(id)
    if (!existing) {
      nodes.set(id, {
        id,
        label: label !== undefined ? label : id,
        shape,
      })
    } else if (label !== undefined && existing.label === existing.id) {
      existing.label = label
      existing.shape = shape
    }
  }

  function parseNodeToken(
    token: string,
  ): { id: string; label: string; shape: ParsedMermaidNode["shape"] } | null {
    const trimmed = token.trim()
    if (!trimmed) return null

    // 1. Stadium: id([label])
    const stadium = /^([a-zA-Z0-9_-]+)\(\[(.*?)\]\)$/.exec(trimmed)
    if (stadium) return { id: stadium[1], label: stadium[2], shape: "stadium" }

    // 2. Subroutine: id[[label]]
    const subr = /^([a-zA-Z0-9_-]+)\[\[(.*?)\]\]$/.exec(trimmed)
    if (subr) return { id: subr[1], label: subr[2], shape: "subroutine" }

    // 3. Cylinder: id[(label)]
    const cyl = /^([a-zA-Z0-9_-]+)\[\((.*?)\)\]$/.exec(trimmed)
    if (cyl) return { id: cyl[1], label: cyl[2], shape: "cylinder" }

    // 4. Circle: id((label))
    const circle = /^([a-zA-Z0-9_-]+)\(\((.*?)\)\)$/.exec(trimmed)
    if (circle) return { id: circle[1], label: circle[2], shape: "circle" }

    // 5. Rounded: id(label)
    const rounded = /^([a-zA-Z0-9_-]+)\((.*?)\)$/.exec(trimmed)
    if (rounded) return { id: rounded[1], label: rounded[2], shape: "rounded" }

    // 6. Asymmetric: id>label]
    const asym = /^([a-zA-Z0-9_-]+)>(.*?)\]$/.exec(trimmed)
    if (asym) return { id: asym[1], label: asym[2], shape: "asymmetric" }

    // 7. Rect: id[label]
    const rect = /^([a-zA-Z0-9_-]+)\[(.*?)\]$/.exec(trimmed)
    if (rect) return { id: rect[1], label: rect[2], shape: "rect" }

    // 8. Plain ID
    const plain = /^[a-zA-Z0-9_-]+$/.exec(trimmed)
    if (plain) return { id: plain[0], label: plain[0], shape: "rect" }

    return null
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const lineNum = i + 1
    const trimmed = rawLine.trim()

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("%%")) continue

    // Check header
    if (!headerFound) {
      const headerMatch = /^(?:flowchart|graph)\s+([A-Z]{2})/i.exec(trimmed)
      if (headerMatch) {
        const dir = headerMatch[1].toUpperCase()
        if (["TD", "TB", "LR", "RL", "BT"].includes(dir)) {
          direction = dir as MermaidParseResult["direction"]
          headerFound = true
          continue
        }
      }
    }

    // Check unsupported keywords: subgraph, end, click, style, classDef, class
    const unsupportedMatch = /^(subgraph|end|click|style|classDef|class)\b/i.exec(trimmed)
    if (unsupportedMatch) {
      if (unsupportedMatch[1].toLowerCase() !== "end") {
        diagnostics.push({
          line: lineNum,
          message: `Unsupported construct: "${unsupportedMatch[1]}" will be skipped.`,
          severity: "warning",
        })
      }
      continue
    }

    // Edge check with arrow and optional label:
    // Try longer / labeled patterns first!
    const edgeRegex =
      /^(.*?)\s*(-->\|(.*?)\||---\|(.*?)\|-->|--\s*(.*?)\s*-->|-->|---|--|-\.->|==>)\s*(.*)$/

    const edgeMatch = edgeRegex.exec(trimmed)
    if (edgeMatch) {
      const leftToken = edgeMatch[1].trim()
      const rawArrow = edgeMatch[2].trim()
      const labelPipe = edgeMatch[3]
      const labelPipeLine = edgeMatch[4]
      const labelDashes = edgeMatch[5]
      const rightToken = edgeMatch[6].trim()

      const leftParsed = parseNodeToken(leftToken)
      const rightParsed = parseNodeToken(rightToken)

      if (!leftParsed) {
        diagnostics.push({
          line: lineNum,
          message: `Invalid node syntax on left side: "${leftToken}"`,
          severity: "error",
        })
        continue
      }
      if (!rightParsed) {
        diagnostics.push({
          line: lineNum,
          message: `Invalid node syntax on right side: "${rightToken}"`,
          severity: "error",
        })
        continue
      }

      ensureNode(leftParsed.id, leftParsed.label, leftParsed.shape)
      ensureNode(rightParsed.id, rightParsed.label, rightParsed.shape)

      let edgeLabel: string | undefined = labelPipe ?? labelPipeLine ?? labelDashes
      if (edgeLabel) edgeLabel = edgeLabel.trim()

      const isArrow = rawArrow.includes(">")
      edges.push({
        source: leftParsed.id,
        target: rightParsed.id,
        label: edgeLabel && edgeLabel.length > 0 ? edgeLabel : undefined,
        arrow: isArrow ? "arrow" : "none",
      })
      continue
    }

    // Standalone node check: e.g. A[Label]
    const singleNode = parseNodeToken(trimmed)
    if (singleNode) {
      ensureNode(singleNode.id, singleNode.label, singleNode.shape)
      continue
    }

    // If neither edge nor node, report error
    diagnostics.push({
      line: lineNum,
      message: `Unrecognized line: "${trimmed}"`,
      severity: "error",
    })
  }

  const hasErrors = diagnostics.some((d) => d.severity === "error")
  return {
    direction,
    nodes,
    edges,
    diagnostics,
    isValid: !hasErrors && nodes.size > 0,
  }
}

export function convertMermaidToCanvas(
  result: MermaidParseResult,
  center: { x: number; y: number },
): { nodes: CanvasFlowNode[]; edges: Edge[] } {
  if (!result.isValid || result.nodes.size === 0) {
    return { nodes: [], edges: [] }
  }

  const idMap = new Map<string, string>()
  const nodes: CanvasFlowNode[] = []
  const edges: Edge[] = []

  const isHorizontal = result.direction === "LR" || result.direction === "RL"

  // Create canvas flow nodes
  for (const [mId, mNode] of result.nodes) {
    const flowId = newCanvasId()
    idMap.set(mId, flowId)

    // Calculate initial dimensions based on label length
    const lines = mNode.label.split("\n")
    const maxLineLen = Math.max(...lines.map((l) => l.length), 4)
    const width = Math.max(160, Math.min(320, maxLineLen * 11 + 40))
    const height = Math.max(80, Math.min(240, lines.length * 24 + 48))

    nodes.push({
      id: flowId,
      type: "text",
      position: { x: center.x, y: center.y },
      width,
      height,
      style: { width, height },
      selected: true,
      data: {
        text: mNode.label,
        __canvasNodeType: "text",
      },
      zIndex: 1,
    })
  }

  // Create canvas edges
  for (const mEdge of result.edges) {
    const sId = idMap.get(mEdge.source)
    const tId = idMap.get(mEdge.target)
    if (!sId || !tId) continue

    edges.push({
      id: newCanvasId(),
      type: "canvasEdge",
      source: sId,
      target: tId,
      sourceHandle: isHorizontal ? "s-right" : "s-bottom",
      targetHandle: isHorizontal ? "t-left" : "t-top",
      markerEnd: arrowMarker(mEdge.arrow === "arrow" ? "arrow" : "none"),
      selected: true,
      data: {
        toEnd: mEdge.arrow === "arrow" ? "arrow" : "none",
        fromEnd: "none",
        label: mEdge.label,
      },
    })
  }

  // Compute auto-layout
  const layoutedNodes = computeAutoLayout(nodes, edges, {
    direction: isHorizontal ? "LR" : "TB",
    gapX: 48,
    gapY: 56,
  })

  return { nodes: layoutedNodes, edges }
}
