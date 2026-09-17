"use client"

import * as React from "react"
import type { useReactFlow } from "@xyflow/react"
import { isTauri, importAsset, importAssetBytes } from "@/lib/storage"
import { getTreeDragPayload, clearTreeDragPayload } from "@/lib/canvas-dnd"
import { extFromMime } from "./canvas-markdown"
import { adoptAsyncDisposer } from "@/lib/async-disposable"
import type { FileNodeData } from "@/lib/canvas-format"

export function useCanvasDnd({
  vault,
  notePath,
  rf,
  wrapRef,
  addNode,
}: {
  vault: string | null
  notePath?: string
  rf: ReturnType<typeof useReactFlow>
  wrapRef: React.RefObject<HTMLDivElement | null>
  addNode: (type: "file", pos: { x: number; y: number }, extra?: Partial<FileNodeData>) => void
}) {
  const addNodeRef = React.useRef(addNode)
  addNodeRef.current = addNode
  const rfRef = React.useRef(rf)
  rfRef.current = rf

  // ── image paste ──
  React.useEffect(() => {
    async function onPaste(e: ClipboardEvent) {
      const items = Array.from(e.clipboardData?.items ?? []).filter(
        (it) => it.kind === "file" && it.type.startsWith("image/"),
      )
      if (items.length === 0 || !vault || !notePath) return
      e.preventDefault()
      const pos = rfRef.current.screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      })
      for (const item of items) {
        const file = item.getAsFile()
        if (!file) continue
        const bytes = new Uint8Array(await file.arrayBuffer())
        const res = await importAssetBytes(vault, notePath, bytes, extFromMime(file.type))
        if (res) addNodeRef.current("file", pos, { file: res.relPath })
      }
    }
    const el = wrapRef.current
    el?.addEventListener("paste", onPaste)
    return () => el?.removeEventListener("paste", onPaste)
  }, [vault, notePath, wrapRef])

  // ── Finder file drop (Tauri) ──
  React.useEffect(() => {
    if (!isTauri() || !vault || !notePath) return
    let lastPointer = { x: 0, y: 0 }
    const track = (e: PointerEvent) => {
      lastPointer = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener("pointermove", track)
    const cleanupListener = adoptAsyncDisposer(
      Promise.resolve().then(async () => {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview")
        return getCurrentWebview().onDragDropEvent(async (event) => {
          const payload = event.payload as { type: string; paths?: string[] }
          if (payload.type !== "drop" || !payload.paths) return
          const pos = rfRef.current.screenToFlowPosition(lastPointer)
          for (const src of payload.paths) {
            const res = await importAsset(vault, notePath, src)
            if (res) addNodeRef.current("file", pos, { file: res.relPath })
          }
        })
      }),
      () => {},
    )
    return () => {
      window.removeEventListener("pointermove", track)
      cleanupListener?.()
    }
  }, [vault, notePath])

  // ── tree-note drop onto canvas ──
  React.useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onUp = (e: PointerEvent) => {
      const payload = getTreeDragPayload()
      if (!payload) return
      clearTreeDragPayload()
      const pos = rfRef.current.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      addNodeRef.current("file", pos, { file: payload.path })
    }
    el.addEventListener("pointerup", onUp)
    return () => el.removeEventListener("pointerup", onUp)
  }, [wrapRef])
}
