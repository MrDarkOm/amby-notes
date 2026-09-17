import type { TFunction } from "i18next"
import type { Edge } from "@xyflow/react"
import { newCanvasId, arrowMarker, type CanvasFlowNode } from "@/lib/canvas-format"

export interface CanvasTemplateResult {
  nodes: CanvasFlowNode[]
  edges: Edge[]
}

export function createProcessTemplate(
  center: { x: number; y: number },
  t: TFunction,
): CanvasTemplateResult {
  const steps = [
    t("canvas.stepStart"),
    t("canvas.stepAnalysis"),
    t("canvas.stepDevelopment"),
    t("canvas.stepRelease"),
  ]

  const width = 200
  const height = 100
  const gap = 60
  const totalWidth = steps.length * width + (steps.length - 1) * gap
  const startX = Math.round(center.x - totalWidth / 2)
  const startY = Math.round(center.y - height / 2)

  const nodes: CanvasFlowNode[] = []
  const edges: Edge[] = []

  let prevId: string | null = null
  for (let i = 0; i < steps.length; i++) {
    const id = newCanvasId()
    const x = startX + i * (width + gap)
    nodes.push({
      id,
      type: "text",
      position: { x, y: startY },
      width,
      height,
      style: { width, height },
      selected: true,
      data: {
        text: `### ${steps[i]}\n\n`,
        __canvasNodeType: "text",
      },
      zIndex: 1,
    })

    if (prevId) {
      edges.push({
        id: newCanvasId(),
        type: "canvasEdge",
        source: prevId,
        target: id,
        sourceHandle: "s-right",
        targetHandle: "t-left",
        markerEnd: arrowMarker("arrow"),
        selected: true,
        data: {
          toEnd: "arrow",
          fromEnd: "none",
        },
      })
    }
    prevId = id
  }

  return { nodes, edges }
}

export function createTopicMapTemplate(
  center: { x: number; y: number },
  t: TFunction,
): CanvasTemplateResult {
  const centerId = newCanvasId()
  const centerWidth = 240
  const centerHeight = 120
  const cX = Math.round(center.x - centerWidth / 2)
  const cY = Math.round(center.y - centerHeight / 2)

  const nodes: CanvasFlowNode[] = [
    {
      id: centerId,
      type: "text",
      position: { x: cX, y: cY },
      width: centerWidth,
      height: centerHeight,
      style: { width: centerWidth, height: centerHeight },
      selected: true,
      data: {
        text: `## ${t("canvas.mainTopic")}\n\n`,
        color: "6", // purple
        __canvasNodeType: "text",
      },
      zIndex: 1,
    },
  ]
  const edges: Edge[] = []

  const branchWidth = 180
  const branchHeight = 90
  const dist = 180

  const satellites = [
    {
      dx: 0,
      dy: -(centerHeight / 2 + dist + branchHeight / 2),
      sHandle: "s-top",
      tHandle: "t-bottom",
      label: `${t("canvas.subtopic")} 1`,
    },
    {
      dx: centerWidth / 2 + dist + branchWidth / 2,
      dy: 0,
      sHandle: "s-right",
      tHandle: "t-left",
      label: `${t("canvas.subtopic")} 2`,
    },
    {
      dx: 0,
      dy: centerHeight / 2 + dist + branchHeight / 2,
      sHandle: "s-bottom",
      tHandle: "t-top",
      label: `${t("canvas.subtopic")} 3`,
    },
    {
      dx: -(centerWidth / 2 + dist + branchWidth / 2),
      dy: 0,
      sHandle: "s-left",
      tHandle: "t-right",
      label: `${t("canvas.subtopic")} 4`,
    },
  ]

  for (const sat of satellites) {
    const satId = newCanvasId()
    const x = Math.round(center.x + sat.dx - branchWidth / 2)
    const y = Math.round(center.y + sat.dy - branchHeight / 2)

    nodes.push({
      id: satId,
      type: "text",
      position: { x, y },
      width: branchWidth,
      height: branchHeight,
      style: { width: branchWidth, height: branchHeight },
      selected: true,
      data: {
        text: `### ${sat.label}\n\n`,
        __canvasNodeType: "text",
      },
      zIndex: 1,
    })

    edges.push({
      id: newCanvasId(),
      type: "canvasEdge",
      source: centerId,
      target: satId,
      sourceHandle: sat.sHandle,
      targetHandle: sat.tHandle,
      markerEnd: arrowMarker("arrow"),
      selected: true,
      data: {
        toEnd: "arrow",
        fromEnd: "none",
      },
    })
  }

  return { nodes, edges }
}

export function createProjectOverviewTemplate(
  center: { x: number; y: number },
  t: TFunction,
): CanvasTemplateResult {
  const groups = [
    { title: t("canvas.todoGroup"), color: "3" }, // yellow
    { title: t("canvas.inProgressGroup"), color: "2" }, // orange
    { title: t("canvas.doneGroup"), color: "4" }, // green
  ]

  const groupWidth = 280
  const groupHeight = 400
  const gap = 32
  const totalWidth = groups.length * groupWidth + (groups.length - 1) * gap
  const startX = Math.round(center.x - totalWidth / 2)
  const startY = Math.round(center.y - groupHeight / 2)

  const nodes: CanvasFlowNode[] = []

  for (let i = 0; i < groups.length; i++) {
    const grp = groups[i]
    const gX = startX + i * (groupWidth + gap)
    const groupId = newCanvasId()

    nodes.push({
      id: groupId,
      type: "group",
      position: { x: gX, y: startY },
      width: groupWidth,
      height: groupHeight,
      style: { width: groupWidth, height: groupHeight },
      selected: true,
      data: {
        label: grp.title,
        color: grp.color,
        __canvasNodeType: "group",
      },
      zIndex: 0,
    })

    // Add a starter card inside each group
    const cardId = newCanvasId()
    const cardWidth = 240
    const cardHeight = 80
    nodes.push({
      id: cardId,
      type: "text",
      position: { x: gX + 20, y: startY + 50 },
      width: cardWidth,
      height: cardHeight,
      style: { width: cardWidth, height: cardHeight },
      selected: true,
      data: {
        text: `Task in ${grp.title}`,
        __canvasNodeType: "text",
      },
      zIndex: 1,
    })
  }

  return { nodes, edges: [] }
}
