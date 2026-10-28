import type * as React from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { isTauri } from "@/lib/storage"

export function handleDragStart(e: React.MouseEvent) {
  if (e.button !== 0) return
  // Skip drag when the click originated on an interactive element.
  // Without this guard the mousedown bubbles from e.g. a sidebar-toggle button
  // up to the drag-region div, startDragging() captures the mouse pointer, and
  // the button's click event never fires.
  if ((e.target as HTMLElement).closest("button, a, input, select, [role='button']")) return
  if (isTauri()) {
    e.preventDefault()
    getCurrentWindow()
      .startDragging()
      .catch(() => {})
  }
}
