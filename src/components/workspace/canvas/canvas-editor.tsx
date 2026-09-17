"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { useTheme } from "next-themes"
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  SelectionMode,
  useReactFlow,
  type Node,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { CANVAS_UI_THEME_COLORS } from "@/themes"
import { CanvasCtx, type CanvasCtxValue } from "./canvas-context"
import { TextNode, FileNode, GroupNode } from "./canvas-nodes"
import { CanvasEdge } from "./canvas-edges"
import {
  CanvasObjectsToolbar,
  CanvasAreaControls,
  CanvasSelectionBar,
  CanvasContextMenu,
  type MenuState,
} from "./canvas-toolbar"
import { CanvasMinimapPanel } from "./canvas-minimap-panel"
import { CanvasNotePickerModal } from "./canvas-note-picker-modal"
import {
  createSketchFile,
  importAsset,
  importAssetBytes,
  isTauri,
  pickAssetFile,
} from "@/lib/storage"
import { extFromMime, toRelativeVaultPath } from "./canvas-markdown"
import { useCanvasDocument } from "./use-canvas-document"
import { useCanvasDnd } from "./use-canvas-dnd"
import { getNodeRect, snapPosition } from "./canvas-alignment"
import {
  createProcessTemplate,
  createTopicMapTemplate,
  createProjectOverviewTemplate,
} from "./canvas-templates"
import { CanvasMermaidDialog } from "./canvas-mermaid-dialog"
import type { CanvasEdgeData, CanvasFlowNode } from "@/lib/canvas-format"
import type { Edge } from "@xyflow/react"
import type { TreeItem } from "../tree/tree-types"

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
  onLocalEdit?: () => void
  vault: string | null
  notePath?: string
  onOpenNote?: (file: string) => void
  treeItems?: TreeItem[]
  isLocked?: boolean
  onToggleLock?: () => void
}

function CanvasEditorInner({
  value,
  onChange,
  onLocalEdit,
  vault,
  notePath,
  onOpenNote,
  treeItems,
  isLocked: propIsLocked,
  onToggleLock,
}: CanvasEditorProps) {
  const { t } = useTranslation()
  const { resolvedTheme } = useTheme()
  const themeMode = resolvedTheme === "dark" ? "dark" : "light"
  const themeColors = CANVAS_UI_THEME_COLORS[themeMode]

  const wrapRef = React.useRef<HTMLDivElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const rf = useReactFlow()

  const [mode, setMode] = React.useState<"select" | "hand">("select")
  const [connectorActive, setConnectorActive] = React.useState(false)
  const [connectorSourceId, setConnectorSourceId] = React.useState<string | null>(null)
  const [internalLocked, setInternalLocked] = React.useState(false)
  const isLocked = propIsLocked !== undefined ? propIsLocked : internalLocked
  const handleToggleLock = onToggleLock ?? (() => setInternalLocked((prev) => !prev))
  const [snapGrid, setSnapGrid] = React.useState(false)
  const [snapGuides, setSnapGuides] = React.useState(true)
  const [bgVariant, setBgVariant] = React.useState<BackgroundVariant | "none">(
    BackgroundVariant.Dots,
  )
  const [isSpaceDown, setIsSpaceDown] = React.useState(false)
  const [menu, setMenu] = React.useState<MenuState | null>(null)
  const [mermaidOpen, setMermaidOpen] = React.useState(false)
  const [notePickerOpen, setNotePickerOpen] = React.useState(false)
  const [minimapOpen, setMinimapOpen] = React.useState<boolean>(() => {
    try {
      if (notePath) {
        const stored = localStorage.getItem(`amby:canvas:minimap:${notePath}`)
        if (stored !== null) return stored === "true"
      }
      const globalStored = localStorage.getItem("amby:canvas:minimap")
      if (globalStored !== null) return globalStored === "true"
    } catch {
      /* ignore */
    }
    return true
  })

  const handleToggleMinimap = React.useCallback(() => {
    setMinimapOpen((prev) => {
      const next = !prev
      try {
        if (notePath) {
          localStorage.setItem(`amby:canvas:minimap:${notePath}`, String(next))
        }
        localStorage.setItem("amby:canvas:minimap", String(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [notePath])

  // Alignment guide lines state
  const [guideLines, setGuideLines] = React.useState<{
    vertical: number | null
    horizontal: number | null
  }>({ vertical: null, horizontal: null })

  const doc = useCanvasDocument({ value, onChange, onLocalEdit, wrapRef })

  useCanvasDnd({
    vault,
    notePath,
    rf,
    wrapRef,
    addNode: doc.addNode,
  })

  const ctx = React.useMemo<CanvasCtxValue>(
    () => ({
      vault,
      onOpenNote,
      updateNodeData: doc.updateNodeData,
      setEdgeLabel: doc.setEdgeLabel,
      isLocked,
      connectorMode: connectorActive,
    }),
    [vault, onOpenNote, doc.updateNodeData, doc.setEdgeLabel, isLocked, connectorActive],
  )

  // Spacebar pan, mode hotkeys, and escape handler
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      const isEditable = target?.isContentEditable || tag === "INPUT" || tag === "TEXTAREA"
      if (isEditable) return

      if (e.code === "Space" && !e.repeat) {
        e.preventDefault()
        setIsSpaceDown(true)
      } else if (e.key.toLowerCase() === "v" && !e.metaKey && !e.ctrlKey) {
        setMode("select")
        setConnectorActive(false)
        setConnectorSourceId(null)
      } else if (e.key.toLowerCase() === "h" && !e.metaKey && !e.ctrlKey) {
        setMode("hand")
        setConnectorActive(false)
        setConnectorSourceId(null)
      } else if (e.key === "Escape") {
        setConnectorActive(false)
        setConnectorSourceId(null)
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setIsSpaceDown(false)
      }
    }

    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
    }
  }, [])

  const effectiveMode = isSpaceDown ? "hand" : mode

  const openMenu = (e: React.MouseEvent, kind: MenuState["kind"], targetId?: string) => {
    e.preventDefault()
    if (isLocked) return
    setMenu({
      x: e.clientX,
      y: e.clientY,
      kind,
      targetId,
      flow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
    })
  }

  const closeMenu = () => setMenu(null)

  // Connector toggle and node click connect handlers
  const handleToggleConnector = () => {
    const selected = doc.nodes.filter((n) => n.selected)
    if (selected.length === 2) {
      doc.onConnect({
        source: selected[0].id,
        target: selected[1].id,
        sourceHandle: null,
        targetHandle: null,
      })
      setConnectorActive(false)
      setConnectorSourceId(null)
      return
    }
    setConnectorActive((prev) => !prev)
    setConnectorSourceId(null)
  }

  const handleNodeClick = (_e: React.MouseEvent, node: Node) => {
    if (!connectorActive || isLocked) return
    if (!connectorSourceId) {
      setConnectorSourceId(node.id)
    } else if (connectorSourceId !== node.id) {
      doc.onConnect({
        source: connectorSourceId,
        target: node.id,
        sourceHandle: null,
        targetHandle: null,
      })
      setConnectorSourceId(null)
    }
  }

  // Snapping on drag
  const onNodeDrag = (e: MouseEvent | TouchEvent, node: Node) => {
    if (isLocked) return
    doc.onNodeDrag(e, node)
    if (!snapGuides) {
      setGuideLines({ vertical: null, horizontal: null })
      return
    }
    const all = rf.getNodes() as CanvasFlowNode[]
    const otherRects = all.filter((n) => n.id !== node.id).map(getNodeRect)
    const activeRect = getNodeRect(node as CanvasFlowNode)
    const snap = snapPosition(activeRect, otherRects, 6)
    setGuideLines({ vertical: snap.verticalLine, horizontal: snap.horizontalLine })
  }

  const onNodeDragStop = () => {
    setGuideLines({ vertical: null, horizontal: null })
    doc.onNodeDragStop()
  }

  // Note picker select handler
  const handleSelectNote = (selectedPath: string) => {
    const center = rf.screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    })
    const relPath = toRelativeVaultPath(selectedPath, vault)
    doc.addNode("file", center, { file: relPath })
  }

  // Brush / Sketch creation handler
  const handleAddBrush = async () => {
    const center = rf.screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    })
    if (vault) {
      try {
        const title = t("canvas.sketchCardTitle") || "Drawing"
        const sketchPath = await createSketchFile(vault, null, title)
        const relPath = toRelativeVaultPath(sketchPath, vault)
        doc.addNode("file", center, { file: relPath })
        return
      } catch (err) {
        console.error("Failed to create sketch file for canvas:", err)
      }
    }
    doc.addNode("text", center, { text: `🎨 **${t("canvas.sketchCardTitle")}**` })
  }

  // Image upload / insert handler
  const handleAddImage = async () => {
    if (isTauri() && vault) {
      try {
        const picked = await pickAssetFile(true)
        if (!picked) return
        const imported = await importAsset(vault, notePath ?? "canvas.canvas", picked)
        if (imported?.relPath) {
          const center = rf.screenToFlowPosition({
            x: window.innerWidth / 2,
            y: window.innerHeight / 2,
          })
          doc.addNode("file", center, { file: imported.relPath })
        }
        return
      } catch (err) {
        console.error("Native asset pick failed, falling back to file input:", err)
      }
    }
    fileInputRef.current?.click()
  }

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const imported = await importAssetBytes(
        vault ?? "",
        notePath ?? "canvas.canvas",
        bytes,
        extFromMime(file.type),
      )
      if (imported?.relPath) {
        const center = rf.screenToFlowPosition({
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        })
        doc.addNode("file", center, { file: imported.relPath })
      }
    } catch (err) {
      console.error("Failed to import image bytes:", err)
    } finally {
      e.target.value = ""
    }
  }

  // Templates handler
  const handleOpenTemplates = (kind: "process" | "topic" | "project") => {
    const center = rf.screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    })
    let res: { nodes: CanvasFlowNode[]; edges: Edge[] }
    if (kind === "process") {
      res = createProcessTemplate(center, t)
    } else if (kind === "topic") {
      res = createTopicMapTemplate(center, t)
    } else {
      res = createProjectOverviewTemplate(center, t)
    }
    doc.addNodesAndEdges(res.nodes, res.edges)
  }

  // Selection counts
  const selectedNodes = doc.nodes.filter((n) => n.selected)
  const selectedEdges = doc.edges.filter((e) => e.selected)

  // Guide line screen positions
  const containerRect = wrapRef.current?.getBoundingClientRect()
  const vScreenX =
    guideLines.vertical !== null && containerRect
      ? rf.flowToScreenPosition({ x: guideLines.vertical, y: 0 }).x - containerRect.left
      : null
  const hScreenY =
    guideLines.horizontal !== null && containerRect
      ? rf.flowToScreenPosition({ x: 0, y: guideLines.horizontal }).y - containerRect.top
      : null

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      className={`relative h-full w-full outline-none ${
        effectiveMode === "hand" ? (isSpaceDown ? "cursor-grab" : "cursor-grab") : "cursor-default"
      }`}
    >
      <CanvasCtx.Provider value={ctx}>
        <ReactFlow
          nodes={doc.nodes as Node[]}
          edges={doc.edges}
          onNodesChange={doc.onNodesChange}
          onEdgesChange={doc.onEdgesChange}
          onConnect={doc.onConnect}
          onReconnect={doc.onReconnect}
          defaultEdgeOptions={{ reconnectable: true }}
          onNodeDragStart={doc.onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onSelectionDragStop={doc.onSelectionDragStop}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          colorMode={themeMode}
          fitView
          panOnDrag={effectiveMode === "hand" ? true : [1, 2]}
          selectionOnDrag={effectiveMode === "select"}
          selectionMode={SelectionMode.Partial}
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={["Backspace", "Delete"]}
          multiSelectionKeyCode={["Meta", "Control", "Shift"]}
          selectNodesOnDrag={false}
          nodesDraggable={!isLocked}
          nodesConnectable={!isLocked}
          elementsSelectable={!isLocked}
          snapToGrid={snapGrid}
          snapGrid={[20, 20]}
          onNodeClick={handleNodeClick}
          onPaneClick={closeMenu}
          onPaneContextMenu={(e) => openMenu(e as React.MouseEvent, "pane")}
          onNodeContextMenu={(e, n) => openMenu(e, "node", n.id)}
          onEdgeContextMenu={(e, ed) => openMenu(e, "edge", ed.id)}
          className="bg-background"
        >
          {bgVariant !== "none" ? (
            <Background
              variant={bgVariant}
              gap={bgVariant === BackgroundVariant.Lines ? 24 : 20}
              size={bgVariant === BackgroundVariant.Cross ? 6 : 1}
              color={themeColors.backgroundDots}
            />
          ) : null}
        </ReactFlow>

        {/* Snapping guide lines overlay */}
        {(vScreenX !== null || hScreenY !== null) && containerRect ? (
          <svg className="pointer-events-none absolute inset-0 z-30 h-full w-full overflow-visible">
            {vScreenX !== null ? (
              <line
                x1={vScreenX}
                y1={0}
                x2={vScreenX}
                y2={containerRect.height}
                stroke={themeColors.guideLine}
                strokeWidth={1.5}
                strokeDasharray="4 4"
              />
            ) : null}
            {hScreenY !== null ? (
              <line
                x1={0}
                y1={hScreenY}
                x2={containerRect.width}
                y2={hScreenY}
                stroke={themeColors.guideLine}
                strokeWidth={1.5}
                strokeDasharray="4 4"
              />
            ) : null}
          </svg>
        ) : null}

        {/* Section 2: Objects / Creation Toolbar (Bottom-Left) */}
        {!isLocked ? (
          <CanvasObjectsToolbar
            mode={mode}
            onModeChange={(m) => {
              setMode(m)
              setConnectorActive(false)
              setConnectorSourceId(null)
            }}
            connectorActive={connectorActive}
            onToggleConnector={handleToggleConnector}
            onAddText={() => doc.addNode("text")}
            onAddNote={() => setNotePickerOpen(true)}
            onAddBrush={handleAddBrush}
            onAddImage={handleAddImage}
            onAddGroup={() => doc.addNode("group")}
            onOpenTemplates={handleOpenTemplates}
            onOpenMermaid={() => setMermaidOpen(true)}
            onAutoLayout={() => doc.autoLayout()}
          />
        ) : null}

        {/* Section 1: Area & Viewport Controls (Bottom-Right) */}
        <CanvasAreaControls
          canUndo={doc.canUndo}
          canRedo={doc.canRedo}
          onUndo={doc.undo}
          onRedo={doc.redo}
          onZoomIn={() => rf.zoomIn()}
          onZoomOut={() => rf.zoomOut()}
          onZoomReset={() => rf.zoomTo(1)}
          onFitView={() => rf.fitView({ padding: 0.2 })}
          isLocked={isLocked}
          onToggleLock={handleToggleLock}
          snapGrid={snapGrid}
          onSnapGridChange={setSnapGrid}
          snapGuides={snapGuides}
          onSnapGuidesChange={setSnapGuides}
          bgVariant={bgVariant}
          onBgVariantChange={setBgVariant}
        />

        {/* Section 3: Minimap Panel (Bottom-Right) */}
        <CanvasMinimapPanel
          maskColor={themeColors.minimapMask}
          nodeColor={themeColors.minimapNode}
          isOpen={minimapOpen}
          onToggle={handleToggleMinimap}
        />

        {/* Contextual Selection Action Bar */}
        {!isLocked ? (
          <CanvasSelectionBar
            selectedNodeCount={selectedNodes.length}
            selectedEdgeCount={selectedEdges.length}
            onSetColor={(color) => {
              if (selectedNodes.length > 0) {
                for (const n of selectedNodes) doc.setNodeColor(n.id, color)
              } else if (selectedEdges.length > 0) {
                for (const e of selectedEdges) doc.setEdgeColor(e.id, color)
              }
            }}
            onGroupSelection={doc.groupSelection}
            onAlign={doc.alignSelection}
            onDistribute={doc.distributeSelection}
            onDuplicate={doc.duplicateSelection}
            onBringToFront={() => {
              if (selectedNodes[0]) doc.bringTo(selectedNodes[0].id, "front")
            }}
            onSendToBack={() => {
              if (selectedNodes[0]) doc.bringTo(selectedNodes[0].id, "back")
            }}
            onDelete={doc.removeSelected}
            edgeId={selectedEdges[0]?.id}
            edgeLabel={(selectedEdges[0]?.data as CanvasEdgeData | undefined)?.label}
            onCycleArrows={(cycleMode) => {
              if (selectedEdges[0]) doc.cycleArrows(selectedEdges[0].id, cycleMode)
            }}
          />
        ) : null}

        {/* Context Menu */}
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
          onAutoLayout={() => doc.autoLayout()}
        />

        {/* Mermaid Import Dialog */}
        <CanvasMermaidDialog
          open={mermaidOpen}
          onOpenChange={setMermaidOpen}
          onInsert={(nodes, edges) => doc.addNodesAndEdges(nodes, edges)}
          flowCenter={rf.screenToFlowPosition({
            x: window.innerWidth / 2,
            y: window.innerHeight / 2,
          })}
        />

        {/* Vault Note Picker Modal */}
        <CanvasNotePickerModal
          open={notePickerOpen}
          onOpenChange={setNotePickerOpen}
          treeItems={treeItems ?? []}
          vault={vault}
          onSelectNote={handleSelectNote}
        />

        {/* Hidden Image File Input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileInputChange}
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
