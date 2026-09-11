"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { FileText } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { useVirtualizer } from "@tanstack/react-virtual"

import { cn } from "@/lib/utils"
import { motionTransitions } from "@/lib/motion-config"
import {
  flattenVisible,
  ROOT_DROP_TARGET,
  treeBranchGradientColor,
  treeItemHasChildren,
  type SidebarTreeProps,
} from "./tree-types"
import { useSettingsStore } from "../use-settings-store"
import { useViewStateStore } from "../use-view-state-store"
import { TreeNode } from "./tree-row"
import { useTreeKeyboard } from "./use-tree-keyboard"
import { useTreeDnd } from "./use-tree-dnd"

export function SidebarTree({
  items,
  selectedId,
  onSelect,
  onRename,
  onDelete,
  onDeleteMany,
  onNewFile,
  onAttachCanvas,
  onOpenInNewTab,
  onOpenInNewWindow,
  onCloneFile,
  onOpenInExplorer,
  onMoveItem,
  onReorderItems,
  onSetIcon,
  onContextMenuSelect,
  triggerRenameId,
  favorites,
  onToggleFavorite,
  onAttachLayer,
  canCreateDatabaseLayer,
  linkedLayersByDoc,
  findActiveKey,
}: SidebarTreeProps) {
  const { t } = useTranslation()
  const closedIds = useViewStateStore((s) => s.closedTreeIds)
  const toggleOpen = useViewStateStore((s) => s.toggleTreeItem)
  const rainbowTree = useSettingsStore((s) => s.prefs.rainbowTree)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [keyboardFocusId, setKeyboardFocusId] = React.useState<string | null>(selectedId)
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() =>
    selectedId ? new Set([selectedId]) : new Set(),
  )
  const selectionAnchorRef = React.useRef<string | null>(selectedId)
  const handledRenameTriggerRef = React.useRef<string | null>(null)

  // Opening a different note from another part of the app starts a new
  // selection, while modifier-clicks inside the tree stay local to this view.
  React.useEffect(() => {
    setSelectedIds(selectedId ? new Set([selectedId]) : new Set())
    selectionAnchorRef.current = selectedId
  }, [selectedId])

  // ── Flat visible row list ───────────────────────────────────────────────────
  const flatRows = React.useMemo(() => flattenVisible(items, closedIds), [items, closedIds])
  const rootBranchCount = React.useMemo(
    () => items.filter((item) => item.type === "folder" || treeItemHasChildren(item)).length,
    [items],
  )
  const flatRowsRef = React.useRef(flatRows)
  flatRowsRef.current = flatRows

  // ── Virtualizer ─────────────────────────────────────────────────────────────
  const scrollRef = React.useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 29,
    overscan: 6,
  })

  // A newly created item may be outside the virtualized viewport. Select it,
  // scroll it into view, and only then enter rename mode so its input can take
  // focus reliably regardless of where the note was created.
  React.useEffect(() => {
    if (!triggerRenameId) {
      handledRenameTriggerRef.current = null
      return
    }
    if (handledRenameTriggerRef.current === triggerRenameId) return
    const normalizePath = (path: string) => path.replace(/\\/gu, "/").replace(/\/+$/u, "")
    const normalizedTrigger = normalizePath(triggerRenameId)
    const target = flatRowsRef.current.find(
      (row) =>
        row.item.id === triggerRenameId || normalizePath(row.item.path) === normalizedTrigger,
    )
    if (!target) return
    handledRenameTriggerRef.current = triggerRenameId
    const index = flatRowsRef.current.findIndex((row) => row.item.id === target.item.id)
    if (index !== -1) virtualizer.scrollToIndex(index, { align: "auto" })
    setSelectedIds(new Set([target.item.id]))
    selectionAnchorRef.current = target.item.id
    setKeyboardFocusId(target.item.id)
    setEditingId(target.item.id)
  }, [flatRows, triggerRenameId, virtualizer])

  const handleSelect = React.useCallback(
    (id: string, event?: React.MouseEvent<HTMLElement>) => {
      const currentRows = flatRowsRef.current
      const additive = Boolean(event?.metaKey || event?.ctrlKey)
      const anchor = selectionAnchorRef.current
      const anchorIndex = anchor ? currentRows.findIndex((row) => row.item.id === anchor) : -1
      const currentIndex = currentRows.findIndex((row) => row.item.id === id)

      if (event?.shiftKey && anchorIndex !== -1 && currentIndex !== -1) {
        const from = Math.min(anchorIndex, currentIndex)
        const to = Math.max(anchorIndex, currentIndex)
        setSelectedIds(new Set(currentRows.slice(from, to + 1).map((row) => row.item.id)))
        return
      }

      if (additive) {
        setSelectedIds((current) => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
        selectionAnchorRef.current = id
        return
      }

      setSelectedIds(new Set([id]))
      selectionAnchorRef.current = id
      onSelect(id)
    },
    [onSelect],
  )

  const handleKeyboardSelect = React.useCallback((id: string) => handleSelect(id), [handleSelect])

  const focusRow = React.useCallback(
    (id: string) => {
      setKeyboardFocusId(id)
      const index = flatRows.findIndex((row) => row.item.id === id)
      if (index !== -1) virtualizer.scrollToIndex(index, { align: "auto" })
    },
    [flatRows, virtualizer],
  )

  React.useEffect(() => {
    // While renaming, the input owns focus. Cancelling the pending row-focus
    // frame is essential for nested creation: focusing the parent row after
    // the input mounts would blur it and immediately commit the default name.
    if (!keyboardFocusId || editingId) return
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
  }, [editingId, flatRows, keyboardFocusId, virtualizer])

  const { handleTreeKeyDown } = useTreeKeyboard({
    items,
    flatRows,
    closedIds,
    toggleOpen,
    selectedId,
    keyboardFocusId,
    focusRow,
    setEditingId,
    onSelect: handleKeyboardSelect,
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

  const { ptrDrag, onPtrDragStart } = useTreeDnd({
    onMoveItem,
    onReorderItems,
    selectedIds,
  })
  const ptrDragSourceIds = React.useMemo(
    () => new Set(ptrDrag?.sourceIds ?? []),
    [ptrDrag?.sourceIds],
  )

  const totalSize = virtualizer.getTotalSize()
  const handleToggleOpen = React.useCallback((id: string) => toggleOpen(id), [toggleOpen])
  const handleStartEdit = React.useCallback((id: string) => setEditingId(id), [])
  const handleContextMenuSelect = React.useCallback(
    (id: string) => {
      setSelectedIds(new Set([id]))
      selectionAnchorRef.current = id
      onContextMenuSelect?.(id)
    },
    [onContextMenuSelect],
  )
  const handleFinishEdit = React.useCallback(
    (id: string, newName: string | null) => {
      if (newName) onRename?.(id, newName)
      setEditingId(null)
    },
    [onRename],
  )

  return (
    <>
      {/* Scroll container — owns the ref the virtualizer needs */}
      <div
        ref={scrollRef}
        data-drag-target={ROOT_DROP_TARGET}
        role="tree"
        aria-multiselectable="true"
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
            const treeBranchColor =
              rainbowTree && row.branchIndex !== null
                ? treeBranchGradientColor(row.branchIndex, rootBranchCount)
                : undefined
            return (
              <div
                key={virtualRow.key}
                className="amby-tree-virtual-row"
                data-index={virtualRow.index}
                data-tree-level={row.level}
                data-tree-branch={row.branchIndex === null ? undefined : row.branchIndex}
                ref={virtualizer.measureElement}
                style={
                  {
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${virtualRow.start}px)`,
                    padding: "0 0 1px",
                    "--tree-level": row.level,
                    ...(treeBranchColor ? { "--tree-branch-color": treeBranchColor } : {}),
                  } as React.CSSProperties
                }
              >
                <TreeNode
                  item={row.item}
                  level={row.level}
                  isOpen={!closedIds.has(row.item.id)}
                  onToggleOpen={handleToggleOpen}
                  isEditing={editingId === row.item.id}
                  onStartEdit={handleStartEdit}
                  onFinishEdit={handleFinishEdit}
                  selectedIds={selectedIds}
                  isKeyboardFocused={keyboardFocusId === row.item.id}
                  onKeyboardFocus={setKeyboardFocusId}
                  onSelect={handleSelect}
                  onDelete={onDelete}
                  onDeleteMany={onDeleteMany}
                  onNewFile={onNewFile}
                  onAttachCanvas={onAttachCanvas}
                  onOpenInNewTab={onOpenInNewTab}
                  onOpenInNewWindow={onOpenInNewWindow}
                  onCloneFile={onCloneFile}
                  onOpenInExplorer={onOpenInExplorer}
                  onSetIcon={onSetIcon}
                  onContextMenuSelect={handleContextMenuSelect}
                  onPtrDragStart={onPtrDragStart}
                  isPtrDragSource={ptrDragSourceIds.has(row.item.id)}
                  isPtrDragTarget={
                    ptrDrag?.targetId === row.item.id && ptrDrag.dropPosition === null
                  }
                  favorites={favorites}
                  onToggleFavorite={onToggleFavorite}
                  onAttachLayer={onAttachLayer}
                  canCreateDatabaseLayer={canCreateDatabaseLayer}
                  linkedLayersByDoc={linkedLayersByDoc}
                />
                {ptrDrag?.targetId === row.item.id &&
                  ptrDrag.dropPosition !== null &&
                  ptrDrag.dropPosition !== "end" && (
                    <motion.div
                      layoutId="amby-tree-drop-indicator"
                      className="amby-tree-drop-indicator"
                      data-position={ptrDrag.dropPosition}
                      initial={{ opacity: 0, scaleX: 0.72 }}
                      animate={{ opacity: 1, scaleX: 1 }}
                      transition={motionTransitions.reorder}
                      aria-hidden="true"
                    />
                  )}
              </div>
            )
          })}
        </div>

        {/* Root-level drop zone shown at the bottom of the list */}
        <div
          data-tree-root-drop-zone="true"
          className={cn(
            "relative mx-1.5 mt-1 min-h-10 rounded border border-transparent",
            ptrDrag?.dropPosition === "end" && "border-primary/40 bg-primary/5",
          )}
        >
          {ptrDrag?.dropPosition === "end" && (
            <motion.div
              layoutId="amby-tree-drop-indicator"
              className="amby-tree-drop-indicator amby-tree-drop-indicator--root"
              data-position="after"
              initial={{ opacity: 0, scaleX: 0.72 }}
              animate={{ opacity: 1, scaleX: 1 }}
              transition={motionTransitions.reorder}
              aria-hidden="true"
            />
          )}
        </div>
      </div>

      <AnimatePresence>
        {ptrDrag?.active && (
          <motion.div
            initial={{ opacity: 0, scale: 0.86, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.86, y: 6 }}
            transition={motionTransitions.reorder}
            style={{
              position: "fixed",
              left: ptrDrag.ghostX + 14,
              top: ptrDrag.ghostY + 10,
              pointerEvents: "none",
              zIndex: 9999,
            }}
            className="flex items-center gap-1.5 rounded-md bg-accent px-2 py-1 text-[12px] text-foreground shadow-xl ring-1 ring-primary/45"
          >
            <FileText className="size-3.5 shrink-0" />
            <span className="max-w-40 truncate">{ptrDrag.sourceName}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
