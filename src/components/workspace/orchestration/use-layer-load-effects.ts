import { canvasLayerPath, sketchLayerPath, wsPathStem } from "../workspace-tree-utils"
import * as React from "react"
import type { EditorLayer } from "../use-view-state-store"
import type { TreeItem } from "../sidebar-tree"

interface UseLayerLoadEffectsParams {
  currentDocId: string | null
  currentDocPath: string | null
  activeLayers: Record<string, EditorLayer>
  currentDocDefaultLayer: EditorLayer
  openCanvases: Record<string, string>
  loadCanvasBuffer: (path: string) => Promise<string>
  setOpenCanvases: (
    update: Record<string, string> | ((previous: Record<string, string>) => Record<string, string>),
  ) => void
  openSketches: Record<string, string>
  loadSketchBuffer: (path: string) => Promise<string>
  setOpenSketches: (
    update: Record<string, string> | ((previous: Record<string, string>) => Record<string, string>),
  ) => void
  treeItems: TreeItem[]
  handleOpenInNewTab: (fileId: string) => Promise<void>
}

export function useLayerLoadEffects({
  currentDocId,
  currentDocPath,
  activeLayers,
  currentDocDefaultLayer,
  openCanvases,
  loadCanvasBuffer,
  setOpenCanvases,
  openSketches,
  loadSketchBuffer,
  setOpenSketches,
  treeItems,
  handleOpenInNewTab,
}: UseLayerLoadEffectsParams) {
  // Lazily load the canvas layer file when the canvas layer becomes active.
  React.useEffect(() => {
    if (!currentDocId || !currentDocPath) return
    const currentLayer = activeLayers[currentDocId] ?? currentDocDefaultLayer
    if (currentLayer !== "canvas") return
    const path = currentDocPath.endsWith(".canvas")
      ? currentDocPath
      : canvasLayerPath(currentDocPath)
    if (openCanvases[path] !== undefined) return
    let cancelled = false
    loadCanvasBuffer(path).then((content) => {
      if (!cancelled) {
        setOpenCanvases((prev) => (prev[path] !== undefined ? prev : { ...prev, [path]: content }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    currentDocId,
    currentDocPath,
    activeLayers,
    currentDocDefaultLayer,
    loadCanvasBuffer,
    openCanvases,
    setOpenCanvases,
  ])

  // Lazily load the sketch layer file when the sketch layer becomes active.
  React.useEffect(() => {
    if (!currentDocId || !currentDocPath) return
    const currentLayer = activeLayers[currentDocId] ?? currentDocDefaultLayer
    if (currentLayer !== "sketch") return
    const path = currentDocPath.endsWith(".excalidraw")
      ? currentDocPath
      : sketchLayerPath(currentDocPath)
    if (openSketches[path] !== undefined) return
    let cancelled = false
    loadSketchBuffer(path).then((content) => {
      if (!cancelled) {
        setOpenSketches((prev) => (prev[path] !== undefined ? prev : { ...prev, [path]: content }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    currentDocId,
    currentDocPath,
    activeLayers,
    currentDocDefaultLayer,
    loadSketchBuffer,
    openSketches,
    setOpenSketches,
  ])

  // Resolve an Obsidian vault-relative file ref to a tree item and open it in a new tab.
  const handleOpenCanvasNote = React.useCallback(
    (file: string) => {
      if (!file) return
      const norm = file.replace(/\\/g, "/")
      const stem = wsPathStem(norm)
      function find(items: typeof treeItems): (typeof treeItems)[number] | null {
        for (const it of items) {
          const p = (it.path ?? it.id).replace(/\\/g, "/")
          if (
            it.type === "file" &&
            (p === norm || p.endsWith(`/${norm}`) || wsPathStem(p) === stem)
          ) {
            return it
          }
          if (it.children) {
            const found = find(it.children)
            if (found) return found
          }
        }
        return null
      }
      const target = find(treeItems)
      if (target) handleOpenInNewTab(target.id)
    },
    [handleOpenInNewTab, treeItems],
  )
  return { handleOpenCanvasNote }
}
