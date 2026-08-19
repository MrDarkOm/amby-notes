"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { FileText } from "lucide-react"
import { useVirtualizer } from "@tanstack/react-virtual"

import { cn } from "@/lib/utils"
import {
  flattenVisible,
  ROOT_DROP_TARGET,
  type SidebarTreeProps,
  type TreeItem,
} from "./tree-types"
import { TreeNode } from "./tree-row"
import { useTreeKeyboard } from "./use-tree-keyboard"
import { useTreeDnd } from "./use-tree-dnd"

export function SidebarTree({
  items,
  selectedId,
  onSelect,
  onRename,
  onDelete,
  onNewFile,
  onAttachCanvas,
  onOpenInNewTab,
  onOpenInNewWindow,
  onCloneFile,
  onOpenInExplorer,
  onMoveItem,
  onSetIcon,
  triggerRenameId,
  folderResetKey,
  folderTargetOpen,
  favorites,
  onToggleFavorite,
  onAttachLayer,
  linkedLayersByDoc,
  findActiveKey,
}: SidebarTreeProps) {
  const { t } = useTranslation()
  const [closedIds, setClosedIds] = React.useState<Set<string>>(() => new Set())
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [keyboardFocusId, setKeyboardFocusId] = React.useState<string | null>(selectedId)

  const toggleOpen = React.useCallback((id: string) => {
    setClosedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // ── Respond to external expand/collapse trigger ─────────────────────────────
  const prevFolderResetKeyRef = React.useRef<number | undefined>(undefined)
  React.useEffect(() => {
    if (folderResetKey === undefined || folderResetKey === prevFolderResetKeyRef.current) return
    prevFolderResetKeyRef.current = folderResetKey
    if (folderTargetOpen === false) {
      const ids = new Set<string>()
      function collect(list: TreeItem[]) {
        for (const it of list) {
          ids.add(it.id)
          if (it.children) collect(it.children)
        }
      }
      collect(items)
      setClosedIds(ids)
    } else {
      setClosedIds(new Set())
    }
  }, [folderResetKey, folderTargetOpen, items])

  // ── Respond to external rename trigger ─────────────────────────────────────
  React.useEffect(() => {
    if (!triggerRenameId) return
    const timer = setTimeout(() => setEditingId(triggerRenameId), 80)
    return () => clearTimeout(timer)
  }, [triggerRenameId])

  // ── Flat visible row list ───────────────────────────────────────────────────
  const flatRows = React.useMemo(() => flattenVisible(items, closedIds), [items, closedIds])

  // ── Virtualizer ─────────────────────────────────────────────────────────────
  const scrollRef = React.useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 29,
    overscan: 6,
  })

  const focusRow = React.useCallback(
    (id: string) => {
      setKeyboardFocusId(id)
      const index = flatRows.findIndex((row) => row.item.id === id)
      if (index !== -1) virtualizer.scrollToIndex(index, { align: "auto" })
    },
    [flatRows, virtualizer],
  )

  React.useEffect(() => {
    if (!keyboardFocusId) return
    const index = flatRows.findIndex((row) => row.item.id === keyboardFocusId)
    if (index === -1) return
    virtualizer.scrollToIndex(index, { align: "auto" })
    const frame = requestAnimationFrame(() => {
      const row = Array.from(
        scrollRef.current?.querySelectorAll<HTMLElement>("[data-tree-item-id]") ?? [],
      ).find((element) => element.dataset.treeItemId === keyboardFocusId)
      row?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [flatRows, keyboardFocusId, virtualizer])

  const { handleTreeKeyDown } = useTreeKeyboard({
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
  })

  // Scroll selected item into view when selection changes or "find active" fires.
  const prevSelectedIdRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (selectedId === prevSelectedIdRef.current) return
    prevSelectedIdRef.current = selectedId
    if (!selectedId) return
    const idx = flatRows.findIndex((r) => r.item.id === selectedId)
    if (idx !== -1) virtualizer.scrollToIndex(idx, { align: "auto" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const prevFindActiveKeyRef = React.useRef<number | undefined>(undefined)
  React.useEffect(() => {
    if (findActiveKey === undefined || findActiveKey === prevFindActiveKeyRef.current) return
    prevFindActiveKeyRef.current = findActiveKey
    if (!selectedId) return
    const idx = flatRows.findIndex((r) => r.item.id === selectedId)
    if (idx !== -1) virtualizer.scrollToIndex(idx, { align: "center" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findActiveKey])

  const { ptrDrag, onPtrDragStart } = useTreeDnd({ onMoveItem })

  const totalSize = virtualizer.getTotalSize()

  return (
    <>
      {/* Scroll container — owns the ref the virtualizer needs */}
      <div
        ref={scrollRef}
        data-drag-target={ROOT_DROP_TARGET}
        role="tree"
        aria-label={t("panels.files")}
        tabIndex={keyboardFocusId ? -1 : 0}
        onKeyDown={handleTreeKeyDown}
        className="h-full overflow-y-auto select-none focus:outline-none"
        style={{ cursor: ptrDrag ? "grabbing" : undefined }}
      >
        {/* Virtualized content — absolute-positioned rows inside a sized container */}
        <div style={{ height: totalSize, position: "relative", padding: "6px" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = flatRows[virtualRow.index]
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${virtualRow.start}px)`,
                  padding: "0 0 1px",
                }}
              >
                <TreeNode
                  item={row.item}
                  level={row.level}
                  isOpen={!closedIds.has(row.item.id)}
                  onToggleOpen={() => toggleOpen(row.item.id)}
                  isEditing={editingId === row.item.id}
                  onStartEdit={() => setEditingId(row.item.id)}
                  onFinishEdit={(newName) => {
                    if (newName) onRename?.(row.item.id, newName)
                    setEditingId(null)
                  }}
                  selectedId={selectedId}
                  isKeyboardFocused={keyboardFocusId === row.item.id}
                  onKeyboardFocus={setKeyboardFocusId}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  onNewFile={onNewFile}
                  onAttachCanvas={onAttachCanvas}
                  onOpenInNewTab={onOpenInNewTab}
                  onOpenInNewWindow={onOpenInNewWindow}
                  onCloneFile={onCloneFile}
                  onOpenInExplorer={onOpenInExplorer}
                  onSetIcon={onSetIcon}
                  onPtrDragStart={onPtrDragStart}
                  ptrDragSourceId={ptrDrag?.sourceId ?? null}
                  ptrDragTargetId={ptrDrag?.targetId ?? null}
                  favorites={favorites}
                  onToggleFavorite={onToggleFavorite}
                  onAttachLayer={onAttachLayer}
                  linkedLayersByDoc={linkedLayersByDoc}
                />
              </div>
            )
          })}
        </div>

        {/* Root-level drop zone shown at the bottom of the list */}
        <div
          className={cn(
            "mx-1.5 mt-1 min-h-10 rounded border border-transparent",
            ptrDrag?.targetId === ROOT_DROP_TARGET && "border-blue-500 bg-blue-900/20",
          )}
        />
      </div>

      {ptrDrag?.active && (
        <div
          style={{
            position: "fixed",
            left: ptrDrag.ghostX + 14,
            top: ptrDrag.ghostY + 10,
            pointerEvents: "none",
            zIndex: 9999,
          }}
          className="flex items-center gap-1.5 rounded bg-accent px-2 py-1 text-[12px] text-foreground shadow-xl ring-1 ring-border"
        >
          <FileText className="size-3.5 shrink-0" />
          <span className="max-w-32 truncate">{ptrDrag.sourceName}</span>
        </div>
      )}
    </>
  )
}
