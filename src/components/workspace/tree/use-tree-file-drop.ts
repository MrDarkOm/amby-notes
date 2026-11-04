import * as React from "react"
import { useTranslation } from "react-i18next"

import {
  importFiles,
  isTauri,
  showErrorMessage,
  type ImportFilesResult,
  type TreeItem,
} from "@/lib/storage"
import { logger, errorType } from "@/lib/logger"
import { tauriDropClientPosition } from "../tiptap/media-drop"
import { findTreeItem } from "../workspace-tree-utils"
import { ROOT_DROP_TARGET } from "./tree-types"

const OVER_CLASS = "tree-file-drop-over"

const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "")
const dirname = (path: string) => {
  const value = normalize(path)
  const index = value.lastIndexOf("/")
  return index === -1 ? "" : value.slice(0, index)
}
const basename = (path: string) => normalize(path).split("/").pop() ?? ""
const stem = (path: string) => basename(path).replace(/\.[^.]+$/, "")

/**
 * The vault folder that a drop on `item` lands in: a folder takes it inside, a note puts it
 * beside the note (a note that lives in a folder of its own, its bundle, uses the folder around it).
 */
export function dropFolderFor(item: TreeItem, vault: string): string | null {
  const path = item.path ?? item.id
  const target = item.type === "folder" ? path : dirname(path)
  const folder =
    item.type !== "folder" && basename(target) === stem(path) ? dirname(target) : target
  return normalize(folder) === normalize(vault) ? null : folder
}

/** What a skipped name is told as: the reason in words, the names in one line. */
export function skippedSummary(
  skipped: ImportFilesResult["skipped"],
  reasonText: (reason: string) => string,
): string {
  return skipped.map((entry) => `${entry.name} (${reasonText(entry.reason)})`).join("\n")
}

/**
 * Files and folders dragged from the system onto the file tree are copied into the folder under
 * the pointer (the vault root over empty space). Tauri's webview consumes such drops before the
 * page sees them, so this listens to the window's own drag-and-drop events, like the editor does.
 */
export function useTreeFileDrop({
  containerRef,
  vault,
  treeItems,
}: {
  containerRef: React.RefObject<HTMLElement | null>
  vault: string | null
  treeItems: TreeItem[]
}) {
  const { t } = useTranslation()
  const latest = React.useRef({ vault, treeItems, t })
  React.useEffect(() => {
    latest.current = { vault, treeItems, t }
  }, [vault, treeItems, t])

  React.useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    let unlisten: (() => void) | null = null
    let marked: Element | null = null

    const clearMark = () => {
      marked?.classList.remove(OVER_CLASS)
      marked = null
    }

    /** The folder path (or `null` for the root) under the point, `undefined` outside the tree. */
    const targetAt = (position: {
      x: number
      y: number
    }): { folder: string | null; element: Element | null } | undefined => {
      const container = containerRef.current
      const { vault: currentVault, treeItems: items } = latest.current
      if (!container || !currentVault) return undefined
      const point = tauriDropClientPosition(
        position,
        window.devicePixelRatio || 1,
        navigator.platform,
      )
      const rect = container.getBoundingClientRect()
      if (
        point.x < rect.left ||
        point.x > rect.right ||
        point.y < rect.top ||
        point.y > rect.bottom
      ) {
        return undefined
      }
      const hit = document.elementFromPoint(point.x, point.y)
      const row = hit?.closest("[data-drag-target]") as HTMLElement | null
      const id = row?.getAttribute("data-drag-target")
      if (!row || !id || id === ROOT_DROP_TARGET) return { folder: null, element: container }
      const item = findTreeItem(items, id)
      if (!item) return { folder: null, element: container }
      return { folder: dropFolderFor(item, currentVault), element: row }
    }

    void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      const off = await getCurrentWebview().onDragDropEvent(async (event) => {
        const payload = event.payload as unknown as {
          type: string
          paths?: string[]
          position?: { x: number; y: number }
        }
        if (payload.type === "leave") {
          clearMark()
          return
        }
        if (!payload.position) return
        const target = targetAt(payload.position)
        if (payload.type === "enter" || payload.type === "over") {
          if (marked !== (target?.element ?? null)) {
            clearMark()
            marked = target?.element ?? null
            marked?.classList.add(OVER_CLASS)
          }
          return
        }
        if (payload.type !== "drop") return
        clearMark()
        if (!target || !payload.paths?.length) return
        const { t: translate } = latest.current
        try {
          const result = await importFiles(target.folder ?? null, payload.paths)
          logger.info("tree.import_files", {
            imported: result.imported.length,
            skipped: result.skipped.length,
          })
          if (result.skipped.length > 0) {
            await showErrorMessage(
              `${translate("filesPanel.importSkipped")}\n${skippedSummary(
                result.skipped,
                (reason) =>
                  translate(`filesPanel.importReason.${reason}`, { defaultValue: reason }),
              )}`,
            )
          }
        } catch (error) {
          logger.error("tree.import_files_failed", { error: errorType(error) })
          await showErrorMessage(translate("filesPanel.importFailed")).catch(() => {})
        }
      })
      if (disposed) off()
      else unlisten = off
    })

    return () => {
      disposed = true
      clearMark()
      try {
        unlisten?.()
      } catch {
        // The webview already removed the listener (hot reload).
      }
    }
  }, [containerRef])
}
