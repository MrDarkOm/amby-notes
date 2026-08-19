"use client"

import * as React from "react"
import type { useReactFlow } from "@xyflow/react"
import { isTauri, importAsset, importAssetBytes } from "@/lib/storage"
import { getTreeDragPayload, clearTreeDragPayload } from "@/lib/canvas-dnd"
import { extFromMime } from "./canvas-markdown"
import type { CanvasFlowNode, FileNodeData } from "@/lib/canvas-format"

export function useCanvasDnd({
  vault,
  notePath,
  rf,
  wrapRef,
  setNodes,
  makeNode,
}: {
  vault: string | null
  notePath?: string
  rf: ReturnType<typeof useReactFlow>
  wrapRef: React.RefObject<HTMLDivElement | null>
  setNodes: React.Dispatch<React.SetStateAction<CanvasFlowNode[]>>
  makeNode: (
    type: "text" | "file" | "group",
    pos: { x: number; y: number },
    extra?: Partial<FileNodeData>,
  ) => CanvasFlowNode
}) {
  // ── image paste ──
  React.useEffect(() => {
    async function onPaste(e: ClipboardEvent) {
      const items = Array.from(e.clipboardData?.items ?? []).filter(
        (it) => it.kind === "file" && it.type.startsWith("image/"),
      )
      if (items.length === 0 || !vault || !notePath) return
      e.preventDefault()
      const pos = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      for (const item of items) {
        const file = item.getAsFile()
        if (!file) continue
        const bytes = new Uint8Array(await file.arrayBuffer())
        const res = await importAssetBytes(vault, notePath, bytes, extFromMime(file.type))
        if (res) setNodes((nds) => [...nds, makeNode("file", pos, { file: res.relPath })])
      }
    }
    const el = wrapRef.current
    el?.addEventListener("paste", onPaste)
    return () => el?.removeEventListener("paste", onPaste)
  }, [vault, notePath, rf, setNodes, makeNode, wrapRef])

  // ── Finder file drop (Tauri) ──
  React.useEffect(() => {
    if (!isTauri() || !vault || !notePath) return
    let unlisten: (() => void) | undefined
    let lastPointer = { x: 0, y: 0 }
    const track = (e: PointerEvent) => {
      lastPointer = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener("pointermove", track)
    ;(async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview")
      unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
        const payload = event.payload as { type: string; paths?: string[] }
        if (payload.type !== "drop" || !payload.paths) return
        const pos = rf.screenToFlowPosition(lastPointer)
        for (const src of payload.paths) {
          const res = await importAsset(vault, notePath, src)
          if (res) setNodes((nds) => [...nds, makeNode("file", pos, { file: res.relPath })])
        }
      })
    })()
    return () => {
      window.removeEventListener("pointermove", track)
      unlisten?.()
    }
  }, [vault, notePath, rf, setNodes, makeNode])

  // ── tree-note drop onto canvas ──
  const onPaneDrop = React.useCallback(
    (clientX: number, clientY: number) => {
      const payload = getTreeDragPayload()
      if (!payload) return
      clearTreeDragPayload()
      const pos = rf.screenToFlowPosition({ x: clientX, y: clientY })
      setNodes((nds) => [...nds, makeNode("file", pos, { file: payload.path })])
    },
    [rf, setNodes, makeNode],
  )

  React.useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onUp = (e: PointerEvent) => onPaneDrop(e.clientX, e.clientY)
    el.addEventListener("pointerup", onUp)
    return () => el.removeEventListener("pointerup", onUp)
  }, [onPaneDrop, wrapRef])
}
