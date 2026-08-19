"use client"

import * as React from "react"
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  type Node,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { CANVAS_UI_COLORS } from "@/lib/themes"
import { CanvasCtx, type CanvasCtxValue } from "./canvas-context"
import { TextNode, FileNode, GroupNode } from "./canvas-nodes"
import { CanvasEdge } from "./canvas-edges"
import { CanvasToolbar, CanvasContextMenu, type MenuState } from "./canvas-toolbar"
import { useCanvasDocument } from "./use-canvas-document"
import { useCanvasDnd } from "./use-canvas-dnd"

const NODE_TYPES = {
  text: TextNode,
  file: FileNode,
  group: GroupNode,
}

const EDGE_TYPES = {
  canvasEdge: CanvasEdge,
}

export interface CanvasEditorProps {
  value: string
  onChange: (json: string) => void
  vault: string | null
  notePath?: string
  onOpenNote?: (file: string) => void
}

function CanvasEditorInner({ value, onChange, vault, notePath, onOpenNote }: CanvasEditorProps) {
  const wrapRef = React.useRef<HTMLDivElement>(null)
  const rf = useReactFlow()
  const [menu, setMenu] = React.useState<MenuState | null>(null)

  const doc = useCanvasDocument({ value, onChange, wrapRef })

  useCanvasDnd({
    vault,
    notePath,
    rf,
    wrapRef,
    setNodes: doc.setNodes,
    makeNode: doc.makeNode,
  })

  const ctx = React.useMemo<CanvasCtxValue>(
    () => ({ vault, onOpenNote, updateNodeData: doc.updateNodeData }),
    [vault, onOpenNote, doc.updateNodeData],
  )

  const openMenu = (e: React.MouseEvent, kind: MenuState["kind"], targetId?: string) => {
    e.preventDefault()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      kind,
      targetId,
      flow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
    })
  }

  const closeMenu = () => setMenu(null)

  return (
    <div ref={wrapRef} tabIndex={0} className="relative h-full w-full outline-none">
      <CanvasCtx.Provider value={ctx}>
        <ReactFlow
          nodes={doc.nodes as Node[]}
          edges={doc.edges}
          onNodesChange={doc.onNodesChange}
          onEdgesChange={doc.onEdgesChange}
          onConnect={doc.onConnect}
          onNodeDragStart={doc.onNodeDragStart}
          onNodeDrag={doc.onNodeDrag}
          onNodeDragStop={doc.onNodeDragStop}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          colorMode="dark"
          fitView
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={["Backspace", "Delete"]}
          multiSelectionKeyCode={["Meta", "Control", "Shift"]}
          selectNodesOnDrag={false}
          onPaneClick={closeMenu}
          onPaneContextMenu={(e) => openMenu(e as React.MouseEvent, "pane")}
          onNodeContextMenu={(e, n) => openMenu(e, "node", n.id)}
          onEdgeContextMenu={(e, ed) => openMenu(e, "edge", ed.id)}
          className="bg-background"
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color={CANVAS_UI_COLORS.backgroundDots}
          />
          <Controls className="!border-border !bg-card" />
          <MiniMap
            className="!bg-card"
            maskColor={CANVAS_UI_COLORS.minimapMask}
            nodeColor={CANVAS_UI_COLORS.minimapNode}
            pannable
            zoomable
          />
        </ReactFlow>

        <CanvasToolbar
          onAddText={() => doc.addNode("text")}
          onAddFile={() => doc.addNode("file")}
          onAddGroup={() => doc.addNode("group")}
        />

        <CanvasContextMenu
          menu={menu}
          onClose={closeMenu}
          onAddNode={(type, flowPos) => doc.addNode(type, flowPos)}
          hasClipboard={doc.hasClipboard}
          onPasteClipboard={doc.pasteClipboard}
          onDuplicateNode={doc.duplicateNode}
          onBringToFront={(id) => doc.bringTo(id, "front")}
          onSendToBack={(id) => doc.bringTo(id, "back")}
          onSetNodeColor={doc.setNodeColor}
          onRemoveNode={doc.removeNode}
          onCycleArrows={doc.cycleArrows}
          onSetEdgeColor={doc.setEdgeColor}
          onRemoveEdge={doc.removeEdge}
        />
      </CanvasCtx.Provider>
    </div>
  )
}

export function CanvasEditor(props: CanvasEditorProps) {
  return (
    <ReactFlowProvider>
      <CanvasEditorInner {...props} />
    </ReactFlowProvider>
  )
}
