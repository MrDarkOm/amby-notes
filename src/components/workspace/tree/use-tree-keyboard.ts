"use client"

import * as React from "react"
import type { FlatRow, TreeItem } from "./tree-types"

export function useTreeKeyboard({
  items,
  flatRows,
  closedIds,
  toggleOpen,
  selectedId,
  keyboardFocusId,
  focusRow,
  setEditingId,
  onSelect,
  scrollRef,
}: {
  items: TreeItem[]
  flatRows: FlatRow[]
  closedIds: Set<string>
  toggleOpen: (id: string) => void
  selectedId: string | null
  keyboardFocusId: string | null
  focusRow: (id: string) => void
  setEditingId: (id: string | null) => void
  onSelect: (id: string) => void
  scrollRef: React.RefObject<HTMLDivElement | null>
}) {
  const parentIdFor = React.useCallback(
    (id: string): string | null => {
      function findParent(list: TreeItem[], parentId: string | null): string | null | undefined {
        for (const item of list) {
          if (item.id === id) return parentId
          if (item.children) {
            const found = findParent(item.children, item.id)
            if (found !== undefined) return found
          }
        }
        return undefined
      }
      return findParent(items, null) ?? null
    },
    [items],
  )

  const handleTreeKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement
      if (target.closest("input, textarea, [contenteditable='true']")) return

      const focusedId = target.closest<HTMLElement>("[data-tree-item-id]")?.dataset.treeItemId
      const id = focusedId ?? keyboardFocusId ?? selectedId
      const index = id ? flatRows.findIndex((row) => row.item.id === id) : -1
      const current = index === -1 ? null : flatRows[index]
      const moveTo = (nextIndex: number) => {
        const row = flatRows[nextIndex]
        if (row) focusRow(row.item.id)
      }
      const openContextMenu = () => {
        const row =
          target.closest<HTMLElement>("[data-tree-item-id]") ??
          Array.from(
            scrollRef.current?.querySelectorAll<HTMLElement>("[data-tree-item-id]") ?? [],
          ).find((element) => element.dataset.treeItemId === id)
        if (!row) return
        const rect = row.getBoundingClientRect()
        row.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          }),
        )
      }

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault()
          moveTo(Math.min(index + 1, flatRows.length - 1))
          break
        case "ArrowUp":
          event.preventDefault()
          moveTo(Math.max(index - 1, 0))
          break
        case "Home":
          event.preventDefault()
          moveTo(0)
          break
        case "End":
          event.preventDefault()
          moveTo(flatRows.length - 1)
          break
        case "ArrowRight": {
          if (!current) break
          const hasChildren = current.item.type === "folder" || !!current.item.children?.length
          if (!hasChildren) break
          event.preventDefault()
          if (closedIds.has(current.item.id)) toggleOpen(current.item.id)
          else if (current.item.children?.[0]) focusRow(current.item.children[0].id)
          break
        }
        case "ArrowLeft": {
          if (!current) break
          event.preventDefault()
          if (
            !closedIds.has(current.item.id) &&
            (current.item.type === "folder" || current.item.children?.length)
          ) {
            toggleOpen(current.item.id)
          } else {
            const parentId = parentIdFor(current.item.id)
            if (parentId) focusRow(parentId)
          }
          break
        }
        case "Enter":
        case " ":
          if (!current) break
          event.preventDefault()
          onSelect(current.item.id)
          break
        case "F2":
          if (!current) break
          event.preventDefault()
          setEditingId(current.item.id)
          break
        case "ContextMenu":
          event.preventDefault()
          openContextMenu()
          break
        case "F10":
          if (!event.shiftKey) break
          event.preventDefault()
          openContextMenu()
          break
      }
    },
    [
      closedIds,
      flatRows,
      focusRow,
      keyboardFocusId,
      onSelect,
      parentIdFor,
      scrollRef,
      selectedId,
      setEditingId,
      toggleOpen,
    ],
  )

  return { handleTreeKeyDown }
}
