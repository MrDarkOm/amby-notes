"use client"

import * as React from "react"
import { WebviewWindow } from "@tauri-apps/api/webviewWindow"
import { isTauri } from "@/lib/storage"
import { findTreeItem } from "../workspace-tree-utils"
import type { TreeItem } from "../sidebar-tree"

export function useNoteWindows(treeItems: TreeItem[]) {
  const noteIdFromUrl = React.useMemo(() => {
    if (typeof window === "undefined") return null
    return new URLSearchParams(window.location.search).get("ambyFile")
  }, [])

  const handleOpenInNewWindow = React.useCallback(
    (fileId: string) => {
      const item = findTreeItem(treeItems, fileId)
      if (!item || item.type !== "file") return
      const url = `/?ambyFile=${encodeURIComponent(fileId)}`
      if (!isTauri()) {
        window.open(url, "_blank", "noopener,noreferrer")
        return
      }
      const child = new WebviewWindow(`note-${crypto.randomUUID()}`, {
        url,
        title: item.name,
        width: 1120,
        height: 760,
        minWidth: 720,
        minHeight: 480,
        center: true,
        focus: true,
      })
      void child.once("tauri://error", (event) => {
        console.error("Failed to open note window:", event.payload)
      })
    },
    [treeItems],
  )

  return {
    noteIdFromUrl,
    handleOpenInNewWindow,
  }
}
