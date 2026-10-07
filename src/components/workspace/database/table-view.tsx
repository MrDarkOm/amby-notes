import * as React from "react"
import { motion } from "motion/react"
import { MotionSpinner } from "@/lib/motion"
import { motionTransition, motionTransitions } from "@/lib/motion-config"
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownUp,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUp,
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  Info,
  ListFilter,
  Loader2,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Repeat2,
  RotateCcw,
  Settings2,
  SquareArrowOutUpRight,
  Trash2,
  Type,
  WrapText,
  X,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { DatabasePropertySummary, DatabaseRow, DatabaseSummary } from "@/lib/storage"
import { DatabaseCell } from "./database-cell"
import { databaseCellText, readDatabaseCellValue } from "./database-cell-value"
import { IconValue } from "../icon-value"
import { EmojiPickerPanel } from "../tiptap/EmojiPickerPanel"
import { useViewStateStore } from "../use-view-state-store"
import { databasePropertyIconKey } from "./property-icon"
import { PropertyTypeIcon as PropertyIcon } from "./property-type-icon"
import { PageIcon } from "./page-icon"
import { RowGrab, type RowMenuModel } from "./row-menu"
import { useRowContextMenu } from "./use-row-context-menu"
import { RowCheckbox, RowSelectionBar } from "./row-selection"
import { useRowSelection } from "./use-row-selection"
import { RowTitleEditor } from "./row-title-editor"
import type { RowDropPlacement } from "./row-order"
import { useRowReorder } from "./layouts/use-row-reorder"
import { dragShift, dragTarget } from "./row-drag-layout"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const DEFAULT_ROW_HEIGHT = 40
const WRAPPED_ROW_HEIGHT = 76
const OVERSCAN = 8
function canFilterType(propertyType: string): boolean {
  return [
    "text",
    "url",
    "number",
    "date",
    "checkbox",
    "select",
    "status",
    "multiselect",
    "multiSelect",
    "relation",
    "files",
  ].includes(propertyType)
}

const MIN_PROPERTY_WIDTH = 56
const MIN_TITLE_WIDTH = 80
const ACTION_COLUMN_WIDTH = "3.5rem"
/** Left of the first column: the grip and the checkbox, outside the table's own borders. */
const GUTTER_WIDTH = 64
/**
 * Pinning columns is a placeholder for now: the setting is kept in the view untouched, but no
 * column is held while the table scrolls sideways, and the menu item says it is coming.
 */
const FREEZE_COLUMNS_AVAILABLE = false

export interface TableSavedSettings {
  widths: Record<string, number>
  wrapped: string[]
  frozenKey: string | null
}

export interface TableSettingsPatch {
  widths?: Record<string, number>
  wrapped?: string[]
  frozenKey?: string | null
}

interface TableViewProps {
  databaseId: string
  rows: DatabaseRow[]
  loading: boolean
  error: string | null
  hasNextPage: boolean
  onLoadNextPage: () => void
  onRetry: () => void
  onRowSelect?: (row: DatabaseRow) => void
  properties: DatabasePropertySummary[]
  pendingCells?: Set<string>
  cellErrors?: Record<string, string>
  onCellCommit?: (
    row: DatabaseRow,
    property: DatabasePropertySummary,
    valueJson?: string,
  ) => Promise<void>
  onAddProperty?: (beforePropertyId?: string) => void
  onDeleteProperty?: (propertyId: string) => Promise<void> | void
  onCreateRow?: () => void
  newPageLabel?: string
  titleColumnName?: string
  onTitleColumnNameChange?: (name: string) => void
  onRenameRow?: (rowId: string, name: string) => Promise<void> | void
  onRenameProperty?: (propertyId: string, name: string) => Promise<void> | void
  onChangePropertyType?: (propertyId: string, propertyType: string) => Promise<void> | void
  /** The settings of a property (options, formats, ...) for its menu; `null` when it has none. */
  renderPropertySettings?: (property: DatabasePropertySummary) => React.ReactNode
  /** First calculation failure per computed kind, for cells that have no value. */
  computedErrors?: Partial<Record<"formula" | "rollup", string>>
  /** Columns that currently have a saved filter (for the header indicator). */
  filteredFieldKeys?: Set<string>
  /** The header's "Filter" action: opens the view's filter editor on this column. */
  onFilterColumn?: (fieldKey: string) => void
  sortValue?: { key: string; direction: "asc" | "desc" } | null
  onSortValueChange?: (value: { key: string; direction: "asc" | "desc" } | null) => void
  hiddenPropertyIds?: Set<string>
  onHiddenPropertyIdsChange?: (hiddenPropertyIds: Set<string>) => void
  /** Persisted layout of this view; local state follows it and reports user changes. */
  savedSettings?: TableSavedSettings
  onSavedSettingsChange?: (patch: TableSettingsPatch) => void
  onOpenNote?: (noteId: string) => void
  databases?: DatabaseSummary[]
  onCreateRelationRow?: (targetDatabaseId: string, title: string) => Promise<string | void>
  /** What the grip of a row can do; without it rows have no grip. */
  rowMenu?: (row: DatabaseRow) => RowMenuModel
  /** Rows can be placed by hand: absent or `enabled: false` leaves the grip as a menu button. */
  rowReorder?: RowReorderConfig
  /** Deletes the ticked rows; the selection bar offers it only with this. */
  onDeleteRows?: (noteIds: string[]) => Promise<void> | void
}

export interface RowReorderConfig {
  enabled: boolean
  onReorder: (rowId: string, overId: string, placement: RowDropPlacement) => void
  /** Moves a row one place up or down (the arrow keys on the grip). */
  onNudge?: (rowId: string, offset: -1 | 1) => void
  /** A drag was tried while a sort decides the order: offer to switch the sort off. */
  onBlockedDrag?: () => void
}

function defaultPropertyWidth(property: DatabasePropertySummary, rows: DatabaseRow[]) {
  const candidates = [property.name, ...property.options.map((option) => option.name)]
  for (const row of rows) {
    const value = readDatabaseCellValue(row.valuesJson, property.propertyId)
    const text = databaseCellText(value, property.propertyType)
    if (text) candidates.push(text)
  }
  const longestWord = candidates
    .flatMap((candidate) => candidate.trim().split(/\s+/u))
    .reduce((max, word) => Math.max(max, word.length), 0)
  return Math.min(320, Math.max(160, Math.ceil(longestWord * 7.5) + 48))
}

function defaultTitleWidth(rows: DatabaseRow[]) {
  const longestWord = rows
    .flatMap((row) => row.title.trim().split(/\s+/u))
    .reduce((max, word) => Math.max(max, word.length), "Название".length)
  return Math.min(360, Math.max(MIN_TITLE_WIDTH, Math.ceil(longestWord * 7.5) + 48))
}

export function TableView({
  databaseId,
  rows,
  loading,
  error,
  hasNextPage,
  onLoadNextPage,
  onRetry,
  onRowSelect,
  properties,
  pendingCells = new Set(),
  cellErrors = {},
  onCellCommit,
  onAddProperty,
  onDeleteProperty,
  onCreateRow,
  newPageLabel,
  titleColumnName,
  onTitleColumnNameChange,
  onRenameRow,
  onRenameProperty,
  onChangePropertyType,
  renderPropertySettings,
  computedErrors,
  filteredFieldKeys,
  onFilterColumn,
  sortValue,
  onSortValueChange,
  hiddenPropertyIds: propHiddenPropertyIds,
  onHiddenPropertyIdsChange,
  savedSettings,
  onSavedSettingsChange,
  onOpenNote,
  databases,
  onCreateRelationRow,
  rowMenu,
  rowReorder,
  onDeleteRows,
}: TableViewProps) {
  const { t } = useTranslation()
  const iconOverrides = useViewStateStore((state) => state.iconOverrides)
  const setIcon = useViewStateStore((state) => state.setIcon)
  const [viewportHeight, setViewportHeight] = React.useState(480)
  const [selectedNoteId, setSelectedNoteId] = React.useState<string | null>(null)
  const [columnWidths, setColumnWidths] = React.useState<Record<string, number>>({})
  const [propertySort, setPropertySort] = React.useState<{
    key: string
    direction: "asc" | "desc"
  } | null>(null)
  const [internalHiddenPropertyIds, setInternalHiddenPropertyIds] = React.useState<Set<string>>(
    new Set(),
  )
  const hiddenPropertyIds = propHiddenPropertyIds ?? internalHiddenPropertyIds
  const hiddenPropertyIdsRef = React.useRef(hiddenPropertyIds)
  hiddenPropertyIdsRef.current = hiddenPropertyIds

  const setHiddenPropertyIds = React.useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      const current = hiddenPropertyIdsRef.current
      const next = typeof updater === "function" ? updater(current) : updater
      if (
        next === current ||
        (next.size === current.size && [...next].every((id) => current.has(id)))
      ) {
        return
      }
      if (onHiddenPropertyIdsChange) {
        hiddenPropertyIdsRef.current = next
        onHiddenPropertyIdsChange(next)
      } else {
        hiddenPropertyIdsRef.current = next
        setInternalHiddenPropertyIds(next)
      }
    },
    [onHiddenPropertyIdsChange],
  )
  const [wrappedPropertyIds, setWrappedPropertyIds] = React.useState<Set<string>>(new Set())
  const [frozenColumnKey, setFrozenColumnKey] = React.useState<string | null>(null)
  const columnWidthsRef = React.useRef(columnWidths)
  columnWidthsRef.current = columnWidths
  const savedSettingsKey = savedSettings ? JSON.stringify(savedSettings) : null
  React.useEffect(() => {
    if (!savedSettingsKey) return
    const saved = JSON.parse(savedSettingsKey) as TableSavedSettings
    setColumnWidths((current) => ({ ...current, ...saved.widths }))
    setWrappedPropertyIds(new Set(saved.wrapped))
    setFrozenColumnKey(FREEZE_COLUMNS_AVAILABLE ? saved.frozenKey : null)
  }, [savedSettingsKey])
  const persistSettings = React.useCallback(
    (patch: TableSettingsPatch) => onSavedSettingsChange?.(patch),
    [onSavedSettingsChange],
  )
  const initializedWidthKeys = React.useRef(new Set<string>())
  const resizeRef = React.useRef<{ key: string; startX: number; startWidth: number } | null>(null)
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const scrollTopRef = React.useRef(0)
  const rangeRafRef = React.useRef<number | null>(null)
  const nextPagePendingRef = React.useRef(false)
  const lastPageTriggerRef = React.useRef(0)

  const updateSortValue = React.useCallback(
    (value: { key: string; direction: "asc" | "desc" } | null) => {
      setPropertySort(value)
      onSortValueChange?.(value)
    },
    [onSortValueChange],
  )

  React.useEffect(() => {
    if (sortValue !== undefined) setPropertySort(sortValue)
  }, [sortValue])

  React.useEffect(() => {
    setColumnWidths((current) => {
      const next = { ...current }
      let changed = false
      if (!next.title && rows.length > 0) {
        next.title = defaultTitleWidth(rows)
        changed = true
      }
      properties.forEach((property) => {
        const key = property.propertyId
        const defaultWidth = defaultPropertyWidth(property, rows)
        if (!initializedWidthKeys.current.has(key)) {
          if (!next[key] || next[key] === 320) {
            next[key] = defaultWidth
            changed = true
          }
          initializedWidthKeys.current.add(key)
        }
      })
      return changed ? next : current
    })
  }, [properties, rows])

  React.useEffect(() => {
    // An empty schema is "not loaded yet", not "all properties were deleted".
    if (properties.length === 0) return
    const available = new Set(properties.map((property) => property.propertyId))
    setHiddenPropertyIds((current) => {
      const next = new Set([...current].filter((id) => available.has(id)))
      return next.size === current.size ? current : next
    })
    setWrappedPropertyIds((current) => {
      const next = new Set([...current].filter((id) => available.has(id)))
      return next.size === current.size ? current : next
    })
    setPropertySort((current) => {
      const next =
        current && current.key !== "title" && !available.has(current.key) ? null : current
      if (next !== current) onSortValueChange?.(next)
      return next
    })
    setFrozenColumnKey((current) =>
      current && current !== "title" && !available.has(current) ? null : current,
    )
  }, [onSortValueChange, properties, setHiddenPropertyIds])

  React.useEffect(() => {
    const move = (event: PointerEvent) => {
      const resizing = resizeRef.current
      if (!resizing) return
      setColumnWidths((current) => ({
        ...current,
        [resizing.key]: Math.max(
          resizing.key === "title" ? MIN_TITLE_WIDTH : MIN_PROPERTY_WIDTH,
          resizing.startWidth + event.clientX - resizing.startX,
        ),
      }))
    }
    const stop = () => {
      const resized = resizeRef.current
      if (resized) {
        const width = columnWidthsRef.current[resized.key]
        if (width !== undefined && width !== resized.startWidth) {
          persistSettings({ widths: { [resized.key]: width } })
        }
      }
      resizeRef.current = null
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
    }
  }, [persistSettings])

  React.useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const update = () => setViewportHeight(element.clientHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const visibleProperties = properties.filter(
    (property) => !hiddenPropertyIds.has(property.propertyId),
  )
  // The backend owns filtering and sorting. This array is intentionally a
  // direct projection of the loaded page so large databases are never
  // silently filtered or reordered only in the renderer.
  const tableRows = rows
  // The rows have one height, so the row under the pointer follows from the pointer alone, and the
  // lifted row can be dragged anywhere over the table, not only along its grip.
  const dragLayout = React.useRef({ rowIds: [] as string[], rowHeight: 0, headerHeight: 0 })
  const reorder = useRowReorder({
    scrollRef: viewportRef,
    axis: "list",
    onDrop: (rowId, overId, placement) => rowReorder?.onReorder(rowId, overId, placement),
    hitTest: (_x, y, rowId) => {
      const area = viewportRef.current
      if (!area) return null
      const { rowIds, rowHeight, headerHeight } = dragLayout.current
      const offset = y - area.getBoundingClientRect().top - headerHeight + area.scrollTop
      return dragTarget(rowIds, rowId, Math.floor(offset / rowHeight))
    },
  })
  const dragFrom = reorder.drag ? tableRows.findIndex((r) => r.noteId === reorder.drag?.rowId) : -1
  const dragTo = reorder.drag?.overId
    ? tableRows.findIndex((r) => r.noteId === reorder.drag?.overId)
    : dragFrom
  const reorderEnabled = Boolean(rowReorder?.enabled)
  // The grip and the checkbox hang in the margin left of the table, outside its surface.
  const hasGutter = Boolean(rowMenu)
  const headerRef = React.useRef<HTMLDivElement>(null)
  const gutterRowsRef = React.useRef<HTMLDivElement>(null)
  const [headerHeight, setHeaderHeight] = React.useState(36)
  // Where each row sits while one is lifted: the lifted row follows the pointer up and down, the
  // rows it passes make room. `instant` after the drop, so the new order does not slide twice.
  const rowShift = (index: number) => {
    if (dragFrom === -1) return { y: 0, instant: true }
    const lifted = index === dragFrom
    const y = dragShift({
      index,
      from: dragFrom,
      to: dragTo,
      count: tableRows.length,
      step: rowHeight,
      pointerDelta: reorder.drag
        ? reorder.drag.y - reorder.drag.startY + reorder.drag.scrollDelta
        : 0,
    })
    return { y, instant: lifted }
  }
  const [hoveredRowId, setHoveredRowId] = React.useState<string | null>(null)
  const [headerHovered, setHeaderHovered] = React.useState(false)
  const selection = useRowSelection(tableRows)
  const contextMenu = useRowContextMenu({ rows: tableRows, rowMenu })
  const rowHeight = visibleProperties.some((property) =>
    wrappedPropertyIds.has(property.propertyId),
  )
    ? WRAPPED_ROW_HEIGHT
    : DEFAULT_ROW_HEIGHT
  dragLayout.current = { rowIds: tableRows.map((r) => r.noteId), rowHeight, headerHeight }
  const calculateRange = React.useCallback(
    (offset: number) => {
      const first = Math.min(
        tableRows.length,
        Math.max(0, Math.floor(offset / rowHeight) - OVERSCAN),
      )
      return {
        first,
        last: Math.min(
          tableRows.length,
          first + Math.ceil(viewportHeight / rowHeight) + OVERSCAN * 2,
        ),
      }
    },
    [rowHeight, tableRows.length, viewportHeight],
  )
  const [visibleRange, setVisibleRange] = React.useState(() => calculateRange(0))
  const rangeRef = React.useRef(visibleRange)
  rangeRef.current = visibleRange
  const scheduleRangeUpdate = React.useCallback(() => {
    if (rangeRafRef.current !== null) return
    rangeRafRef.current = requestAnimationFrame(() => {
      rangeRafRef.current = null
      const next = calculateRange(scrollTopRef.current)
      const current = rangeRef.current
      if (next.first === current.first && next.last === current.last) return
      rangeRef.current = next
      setVisibleRange(next)
    })
  }, [calculateRange])
  React.useEffect(() => {
    scheduleRangeUpdate()
    return () => {
      if (rangeRafRef.current !== null) cancelAnimationFrame(rangeRafRef.current)
      rangeRafRef.current = null
    }
  }, [scheduleRangeUpdate])
  React.useEffect(() => {
    if (!loading) nextPagePendingRef.current = false
  }, [loading])
  const first = visibleRange.first
  const last = visibleRange.last
  const visibleRows = tableRows.slice(first, last)
  const titleColumnWidth = columnWidths.title ?? defaultTitleWidth(rows)
  const titleColumn = `${titleColumnWidth}px`
  const gridTemplateColumns = [
    titleColumn,
    ...visibleProperties.map(
      (property) =>
        `${columnWidths[property.propertyId] ?? defaultPropertyWidth(property, rows)}px`,
    ),
    ACTION_COLUMN_WIDTH,
  ].join(" ")
  const totalTableWidth = React.useMemo(() => {
    let total = titleColumnWidth
    for (const property of visibleProperties) {
      total += columnWidths[property.propertyId] ?? defaultPropertyWidth(property, rows)
    }
    total += 56
    return total
  }, [titleColumnWidth, visibleProperties, columnWidths, rows])
  const tableWidthStyle = React.useMemo<React.CSSProperties>(
    () => ({
      width: "max-content",
      minWidth: `max(100%, ${totalTableWidth}px)`,
    }),
    [totalTableWidth],
  )
  const frozenThroughIndex =
    frozenColumnKey === "title"
      ? -1
      : visibleProperties.findIndex((property) => property.propertyId === frozenColumnKey)
  const hasFrozenColumns = frozenColumnKey === "title" || frozenThroughIndex >= 0
  const frozenLeftByProperty = new Map<string, number>()
  let frozenLeft = titleColumnWidth
  visibleProperties.forEach((property) => {
    frozenLeftByProperty.set(property.propertyId, frozenLeft)
    frozenLeft += columnWidths[property.propertyId] ?? defaultPropertyWidth(property, rows)
  })
  const startResize = (event: React.PointerEvent, key: string) => {
    event.preventDefault()
    event.stopPropagation()
    const currentWidth =
      columnWidths[key] ??
      (key === "title"
        ? titleColumnWidth
        : visibleProperties.find((p) => p.propertyId === key)
          ? defaultPropertyWidth(
              visibleProperties.find((p) => p.propertyId === key)!,
              rows,
            )
          : MIN_PROPERTY_WIDTH)
    resizeRef.current = {
      key,
      startX: event.clientX,
      startWidth: currentWidth,
    }
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
  }

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const element = event.currentTarget
    scrollTopRef.current = element.scrollTop
    if (gutterRowsRef.current) {
      gutterRowsRef.current.style.transform = `translateY(${-element.scrollTop}px)`
    }
    scheduleRangeUpdate()
    const now = Date.now()
    if (
      hasNextPage &&
      !loading &&
      !nextPagePendingRef.current &&
      now - lastPageTriggerRef.current >= 350 &&
      element.scrollHeight > element.clientHeight &&
      element.scrollTop > 0 &&
      element.scrollTop + element.clientHeight >= element.scrollHeight - 240
    ) {
      nextPagePendingRef.current = true
      lastPageTriggerRef.current = now
      onLoadNextPage()
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (tableRows.length === 0) return
    const currentIndex = Math.max(
      0,
      tableRows.findIndex((row) => row.noteId === selectedNoteId),
    )
    const nextIndex = (() => {
      if (event.key === "ArrowDown") return Math.min(tableRows.length - 1, currentIndex + 1)
      if (event.key === "ArrowUp") return Math.max(0, currentIndex - 1)
      if (event.key === "Home") return 0
      if (event.key === "End") return tableRows.length - 1
      return null
    })()
    if (nextIndex === null) return
    event.preventDefault()
    setSelectedNoteId(tableRows[nextIndex].noteId)
    viewportRef.current?.scrollTo({ top: nextIndex * rowHeight, behavior: "auto" })
  }

  React.useEffect(() => {
    const element = viewportRef.current
    if (!element) return

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) > 0) return

      const canScrollHorizontally = element.scrollWidth > element.clientWidth + 1
      if (!canScrollHorizontally) return

      const canScrollVertically = element.scrollHeight > element.clientHeight + 1
      const target = event.target as HTMLElement | null
      const isOverHeader = Boolean(target?.closest('[role="row"]')?.classList.contains("sticky"))

      if (event.shiftKey || !canScrollVertically || isOverHeader) {
        if (event.deltaY !== 0) {
          element.scrollLeft += event.deltaY
          event.preventDefault()
        }
      }
    }

    element.addEventListener("wheel", handleWheel, { passive: false })
    return () => {
      element.removeEventListener("wheel", handleWheel)
    }
  }, [])

  React.useLayoutEffect(() => {
    const height = headerRef.current?.offsetHeight
    if (height) setHeaderHeight(height)
  }, [visibleProperties.length, rowHeight])
  // The margin beside the table is not part of any row, so the row under the pointer is worked
  // out from its height; the same code serves the table and the margin.
  function trackHover(event: React.PointerEvent) {
    const bounds = viewportRef.current?.getBoundingClientRect()
    if (!bounds) return
    const y = event.clientY - bounds.top - headerHeight + scrollTopRef.current
    const id = y < 0 ? null : (tableRows[Math.floor(y / rowHeight)]?.noteId ?? null)
    setHoveredRowId((current) => (current === id ? current : id))
    // The select-all checkbox shows while the pointer is on the header line.
    const inHeader = y < 0 && event.clientY >= bounds.top
    setHeaderHovered((current) => (current === inHeader ? current : inHeader))
  }

  return (
    <div
      className="relative min-h-0 min-w-0 flex flex-1 flex-col"
      onPointerMove={hasGutter ? trackHover : undefined}
      onPointerLeave={
        hasGutter
          ? () => {
              setHeaderHovered(false)
              setHoveredRowId(null)
            }
          : undefined
      }
    >
      {hasGutter && (
        <div
          className="pointer-events-none absolute bottom-0 right-full top-0 z-20"
          style={{ width: GUTTER_WIDTH }}
        >
          <div
            className="pointer-events-auto absolute inset-x-0 top-0 flex items-center justify-end pr-3"
            style={{ height: headerHeight }}
          >
            {tableRows.length > 0 && (
              <RowCheckbox
                checked={selection.allSelected}
                onToggle={selection.toggleAll}
                label={t("databaseRowMenu.selectAll")}
                className={cn(!headerHovered && selection.selected.size === 0 && "opacity-0")}
              />
            )}
          </div>
          <div
            className="absolute inset-x-0 bottom-0 overflow-hidden"
            style={{ top: headerHeight }}
          >
            <div
              ref={gutterRowsRef}
              className="relative"
              style={{
                height: tableRows.length * rowHeight,
                transform: `translateY(${-scrollTopRef.current}px)`,
              }}
            >
              <div className="absolute inset-x-0" style={{ top: first * rowHeight }}>
                {visibleRows.map((row, offset) => {
                  const hovered = hoveredRowId === row.noteId || reorder.drag?.rowId === row.noteId
                  const shift = rowShift(first + offset)
                  return (
                    <motion.div
                      key={row.noteId}
                      initial={false}
                      animate={{ y: shift.y }}
                      transition={motionTransition(
                        shift.instant ? motionTransitions.instant : motionTransitions.reorder,
                      )}
                      className="pointer-events-auto relative flex items-center justify-end gap-2 pr-3"
                      style={{
                        height: rowHeight,
                        zIndex: shift.instant && dragFrom === first + offset ? 5 : 0,
                      }}
                    >
                      <RowGrab
                        row={row}
                        menu={rowMenu!(row)}
                        reorderEnabled={reorderEnabled}
                        onPress={reorder.begin}
                        liftTo={() =>
                          viewportRef.current?.querySelector<HTMLElement>(
                            `[data-reorder-id="${row.noteId}"]`,
                          ) ?? null
                        }
                        onNudge={
                          rowReorder?.onNudge
                            ? (step) => rowReorder.onNudge?.(row.noteId, step)
                            : undefined
                        }
                        onBlockedDrag={rowReorder?.onBlockedDrag}
                        faded={!hovered}
                      />
                      <RowCheckbox
                        checked={selection.selected.has(row.noteId)}
                        onToggle={() => selection.toggle(row.noteId)}
                        label={t("databaseRowMenu.selectRow")}
                        className={cn(!hovered && selection.selected.size === 0 && "opacity-0")}
                      />
                    </motion.div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      )}
      <div
        ref={viewportRef}
        role="grid"
        aria-rowcount={tableRows.length}
        aria-colcount={visibleProperties.length + 3}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-x-auto overflow-y-auto rounded-xl outline-none amby-table-scroll"
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
      >
        <div style={tableWidthStyle}>
          <div
            ref={headerRef}
            role="row"
            className="sticky top-0 z-10 grid border-b border-border bg-[var(--note-surface)] text-xs font-medium text-muted-foreground"
            style={{ gridTemplateColumns, ...tableWidthStyle }}
          >
            <div
              role="columnheader"
              className={cn(
                "relative flex h-full min-w-0 items-center justify-start bg-[var(--note-surface)] p-0 text-left",
                hasFrozenColumns && "sticky left-0 z-20",
                frozenColumnKey === "title" && "database-frozen-edge",
              )}
            >
              {onTitleColumnNameChange ? (
                <PropertyHeaderMenu
                  property={{
                    propertyId: "title",
                    name: titleColumnName ?? t("databaseTable.title"),
                    propertyType: "text",
                    configJson: "{}",
                    options: [],
                  }}
                  onRename={onTitleColumnNameChange}
                  filterActive={Boolean(filteredFieldKeys?.has("title"))}
                  sortDirection={propertySort?.key === "title" ? propertySort.direction : null}
                  isFrozen={frozenColumnKey === "title"}
                  canFilter
                  onFilter={onFilterColumn ? () => onFilterColumn("title") : undefined}
                  onSort={(direction) =>
                    updateSortValue(direction ? { key: "title", direction } : null)
                  }
                  onToggleFreeze={
                    FREEZE_COLUMNS_AVAILABLE
                      ? () => {
                          const next = frozenColumnKey === "title" ? null : "title"
                          setFrozenColumnKey(next)
                          persistSettings({ frozenKey: next })
                        }
                      : undefined
                  }
                  onInsertRight={
                    onAddProperty ? () => onAddProperty(properties[0]?.propertyId) : undefined
                  }
                />
              ) : (
                <div className="flex h-full min-w-0 w-full flex-1 cursor-default items-center gap-2 px-2 py-1.5">
                  <Type className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{titleColumnName ?? t("databaseTable.title")}</span>
                </div>
              )}
              <span
                role="separator"
                aria-orientation="vertical"
                className="group/resizer absolute -right-1.5 top-0 z-30 flex h-full w-3 cursor-col-resize select-none items-center justify-center"
                onPointerDown={(event) => {
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId)
                  } catch {
                    // Ignore pointer capture errors in test/synthetic environments
                  }
                  startResize(event, "title")
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId)
                  }
                }}
              >
                <span className="h-full w-px bg-slate-200 group-hover/resizer:w-1 group-hover/resizer:bg-primary dark:bg-border" />
              </span>
            </div>
            {visibleProperties.map((property, propertyIndex) => {
              const frozen = hasFrozenColumns && propertyIndex <= frozenThroughIndex
              return (
                <div
                  key={property.propertyId}
                  role="columnheader"
                  className={cn(
                    "relative flex h-full min-w-0 items-center bg-[var(--note-surface)] p-0",
                    frozen && "sticky z-20",
                    frozenColumnKey === property.propertyId && "database-frozen-edge",
                  )}
                  style={
                    frozen ? { left: frozenLeftByProperty.get(property.propertyId) } : undefined
                  }
                  title={property.propertyType}
                >
                  {onRenameProperty ? (
                    <PropertyHeaderMenu
                      property={property}
                      iconValue={
                        iconOverrides[databasePropertyIconKey(databaseId, property.propertyId)]
                      }
                      onIconChange={(icon) =>
                        setIcon(databasePropertyIconKey(databaseId, property.propertyId), icon)
                      }
                      onRename={(name) => onRenameProperty(property.propertyId, name)}
                      onChangeType={
                        onChangePropertyType
                          ? (propertyType) =>
                              onChangePropertyType(property.propertyId, propertyType)
                          : undefined
                      }
                      settingsEditor={renderPropertySettings?.(property)}
                      filterActive={Boolean(filteredFieldKeys?.has(property.propertyId))}
                      sortDirection={
                        propertySort?.key === property.propertyId ? propertySort.direction : null
                      }
                      isFrozen={frozenColumnKey === property.propertyId}
                      isWrapped={wrappedPropertyIds.has(property.propertyId)}
                      canWrap={property.propertyType === "text" || property.propertyType === "url"}
                      canFilter={canFilterType(property.propertyType)}
                      onFilter={
                        onFilterColumn && canFilterType(property.propertyType)
                          ? () => onFilterColumn(property.propertyId)
                          : undefined
                      }
                      onSort={
                        ["text", "url", "number", "date", "checkbox", "select", "status"].includes(
                          property.propertyType,
                        )
                          ? (direction) =>
                              updateSortValue(
                                direction ? { key: property.propertyId, direction } : null,
                              )
                          : undefined
                      }
                      onToggleFreeze={
                        FREEZE_COLUMNS_AVAILABLE
                          ? () => {
                              const next =
                                frozenColumnKey === property.propertyId ? null : property.propertyId
                              setFrozenColumnKey(next)
                              persistSettings({ frozenKey: next })
                            }
                          : undefined
                      }
                      onHide={() => {
                        setHiddenPropertyIds((current) => new Set(current).add(property.propertyId))
                        if (propertySort?.key === property.propertyId) updateSortValue(null)
                        if (frozenColumnKey === property.propertyId) {
                          setFrozenColumnKey(null)
                          persistSettings({ frozenKey: null })
                        }
                      }}
                      onToggleWrap={() => {
                        const next = new Set(wrappedPropertyIds)
                        if (next.has(property.propertyId)) next.delete(property.propertyId)
                        else next.add(property.propertyId)
                        setWrappedPropertyIds(next)
                        persistSettings({ wrapped: [...next] })
                      }}
                      onInsertLeft={
                        onAddProperty ? () => onAddProperty(property.propertyId) : undefined
                      }
                      onInsertRight={
                        onAddProperty
                          ? () => onAddProperty(properties[propertyIndex + 1]?.propertyId)
                          : undefined
                      }
                      onDelete={
                        onDeleteProperty ? () => onDeleteProperty(property.propertyId) : undefined
                      }
                    />
                  ) : (
                    <div className="flex h-full min-w-0 w-full flex-1 items-center gap-2 px-2 py-1.5">
                      <IconValue
                        value={
                          iconOverrides[databasePropertyIconKey(databaseId, property.propertyId)]
                        }
                        fallback={<PropertyIcon type={property.propertyType} />}
                        className="size-3.5 shrink-0"
                      />
                      <span className="truncate">{property.name}</span>
                    </div>
                  )}
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    className="group/resizer absolute -right-1.5 top-0 z-30 flex h-full w-3 cursor-col-resize select-none items-center justify-center"
                    onPointerDown={(event) => {
                      try {
                        event.currentTarget.setPointerCapture(event.pointerId)
                      } catch {
                        // Ignore pointer capture errors in test/synthetic environments
                      }
                      startResize(event, property.propertyId)
                    }}
                    onPointerUp={(event) => {
                      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
                        event.currentTarget.releasePointerCapture(event.pointerId)
                      }
                    }}
                  >
                    <span className="h-full w-px bg-slate-200 group-hover/resizer:w-1 group-hover/resizer:bg-primary dark:bg-border" />
                  </span>
                </div>
              )
            })}
            <div role="columnheader" className="flex items-center justify-center gap-0.5 px-1">
              <button
                type="button"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                title={t("databaseWorkspace.addProperty")}
                aria-label={t("databaseWorkspace.addProperty")}
                onClick={() => onAddProperty?.()}
              >
                <Plus className="size-3.5" />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    title={t("databaseWorkspace.propertyVisibility")}
                    aria-label={t("databaseWorkspace.propertyVisibility")}
                  >
                    <MoreHorizontal className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56 max-h-80 overflow-y-auto">
                  <div className="flex items-center justify-between px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    <span>{t("databaseWorkspace.propertyVisibility")}</span>
                    <span>
                      {visibleProperties.length}/{properties.length}
                    </span>
                  </div>
                  {properties.length > 1 && (
                    <>
                      <DropdownMenuItem
                        onSelect={(event) => {
                          event.preventDefault()
                          setHiddenPropertyIds(new Set())
                        }}
                      >
                        <Eye className="size-4" />
                        {t("databaseWorkspace.showAllProperties")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={(event) => {
                          event.preventDefault()
                          setHiddenPropertyIds(new Set(properties.map((p) => p.propertyId)))
                        }}
                      >
                        <EyeOff className="size-4" />
                        {t("databaseWorkspace.hideAllProperties")}
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  {properties.map((property) => {
                    const isVisible = !hiddenPropertyIds.has(property.propertyId)
                    return (
                      <DropdownMenuItem
                        key={property.propertyId}
                        onSelect={(e) => {
                          e.preventDefault()
                          setHiddenPropertyIds((current) => {
                            const next = new Set(current)
                            if (next.has(property.propertyId)) {
                              next.delete(property.propertyId)
                            } else {
                              next.add(property.propertyId)
                            }
                            return next
                          })
                        }}
                        className="flex items-center gap-2"
                      >
                        {isVisible ? (
                          <Eye className="size-4 text-primary shrink-0" />
                        ) : (
                          <EyeOff className="size-4 text-muted-foreground shrink-0" />
                        )}
                        <span
                          className={cn(
                            "flex-1 truncate",
                            !isVisible && "text-muted-foreground line-through opacity-75",
                          )}
                        >
                          {property.name}
                        </span>
                      </DropdownMenuItem>
                    )
                  })}
                  {onAddProperty && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => onAddProperty?.()}>
                        <Plus className="size-4" />
                        <span>{t("databaseWorkspace.addProperty")}</span>
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <div
            style={{
              height: tableRows.length * rowHeight,
              position: "relative",
              ...tableWidthStyle,
            }}
          >
            <div
              style={{
                position: "absolute",
                top: first * rowHeight,
                left: 0,
                ...tableWidthStyle,
              }}
            >
              {visibleRows.map((row, index) => {
                const shift = rowShift(first + index)
                const lifted = dragFrom === first + index
                return (
                  <motion.div
                    key={row.noteId}
                    initial={false}
                    animate={{ y: shift.y }}
                    transition={motionTransition(
                      shift.instant ? motionTransitions.instant : motionTransitions.reorder,
                    )}
                    role="row"
                    aria-rowindex={first + index + 2}
                    aria-selected={selectedNoteId === row.noteId}
                    data-reorder-id={row.noteId}
                    className={cn(
                      "group/row grid border-b border-slate-200 text-sm dark:border-border/60",
                      selection.selected.has(row.noteId) && "database-row-selected",
                      lifted && "database-row-lifted",
                    )}
                    style={{ gridTemplateColumns, height: rowHeight, ...tableWidthStyle }}
                    onContextMenu={(event) => contextMenu.open(event, row)}
                  >
                    <motion.div
                      role="gridcell"
                      initial="rest"
                      whileHover="hover"
                      className={cn(
                        "group relative flex items-center justify-start truncate border-r border-border/60 px-2 text-left font-medium",
                        hasFrozenColumns &&
                          "sticky left-0 z-10 bg-[var(--database-row-bg,var(--note-surface))]",
                        frozenColumnKey === "title" && "database-frozen-edge",
                      )}
                    >
                      <span className="mr-1.5 flex shrink-0 items-center">
                        <PageIcon noteId={row.noteId} editable={Boolean(onRenameRow)} />
                      </span>
                      <RowTitleEditor
                        value={row.title}
                        onCommit={onRenameRow ? (name) => onRenameRow(row.noteId, name) : undefined}
                      />
                      <motion.button
                        type="button"
                        className="absolute right-1 top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-md bg-[var(--note-surface)]/95 text-muted-foreground shadow-sm backdrop-blur-sm hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        variants={{ rest: { opacity: 0 }, hover: { opacity: 1 } }}
                        whileFocus={{ opacity: 1 }}
                        transition={motionTransitions.fast}
                        title={t("databaseTable.openRow")}
                        aria-label={t("databaseTable.openRow")}
                        onClick={(event) => {
                          event.stopPropagation()
                          setSelectedNoteId(row.noteId)
                          onRowSelect?.(row)
                        }}
                      >
                        <SquareArrowOutUpRight className="size-3.5" />
                      </motion.button>
                    </motion.div>
                    {visibleProperties.map((property, propertyIndex) => {
                      const cellKey = `${row.noteId}:${property.propertyId}`
                      const frozen = hasFrozenColumns && propertyIndex <= frozenThroughIndex
                      const targetDbId =
                        property.propertyType === "relation"
                          ? (() => {
                              try {
                                return (
                                  (
                                    JSON.parse(property.configJson) as {
                                      targetDatabaseId?: string
                                    }
                                  ).targetDatabaseId || ""
                                )
                              } catch {
                                return ""
                              }
                            })()
                          : ""
                      const targetDbTitle = targetDbId
                        ? databases?.find((d) => d.databaseId === targetDbId)?.title
                        : undefined

                      return (
                        <div
                          key={cellKey}
                          data-cell-key={cellKey}
                          data-row-id={row.noteId}
                          data-property-id={property.propertyId}
                          className={cn(
                            "h-full min-w-0 border-r border-border/60",
                            frozen && "sticky z-10 bg-[var(--database-row-bg,var(--note-surface))]",
                            frozenColumnKey === property.propertyId && "database-frozen-edge",
                          )}
                          style={
                            frozen
                              ? { left: frozenLeftByProperty.get(property.propertyId) }
                              : undefined
                          }
                          onClick={(event) => event.stopPropagation()}
                        >
                          <DatabaseCell
                            property={property}
                            valuesJson={row.valuesJson}
                            wrap={wrappedPropertyIds.has(property.propertyId)}
                            pending={!onCellCommit || pendingCells.has(cellKey)}
                            error={cellErrors[cellKey]}
                            targetDatabaseTitle={targetDbTitle}
                            computedError={
                              property.propertyType === "formula" ||
                              property.propertyType === "rollup"
                                ? computedErrors?.[property.propertyType]
                                : undefined
                            }
                            onCommit={(valueJson) =>
                              onCellCommit?.(row, property, valueJson) ?? Promise.resolve()
                            }
                            onOpenNote={onOpenNote}
                            onCreateRelationRow={
                              onCreateRelationRow && targetDbId
                                ? (title) => onCreateRelationRow(targetDbId, title)
                                : undefined
                            }
                          />
                        </div>
                      )
                    })}
                    <div aria-hidden="true" />
                  </motion.div>
                )
              })}
            </div>
          </div>
          {contextMenu.element}
          {onCreateRow && (
            <div className="flex items-center px-2 py-1.5" style={tableWidthStyle}>
              <button
                type="button"
                className="sticky left-2 z-10 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-slate-100 hover:text-foreground dark:hover:bg-accent/50"
                onClick={onCreateRow}
              >
                <Plus className="size-3.5" />
                <span>{newPageLabel ?? t("databaseWorkspace.newPage")}</span>
              </button>
            </div>
          )}
          {loading && (
            <div className="sticky left-0 flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
              <MotionSpinner>
                <Loader2 className="size-4" />
              </MotionSpinner>
              {t("databaseTable.loading")}
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="sticky left-0 flex items-center justify-center gap-2 border-t border-border px-4 py-3 text-xs text-destructive"
            >
              <AlertTriangle className="size-4" />
              <span>{error}</span>
              <Button variant="ghost" size="sm" onClick={onRetry}>
                <RotateCcw className="size-3.5" />
                {t("databaseTable.retry")}
              </Button>
            </div>
          )}
        </div>
      </div>
      <RowSelectionBar
        top={Math.max((headerHeight - 32) / 2, 0)}
        count={selection.selected.size}
        onClear={selection.clear}
        onDelete={
          onDeleteRows
            ? () => {
                const ids = [...selection.selected]
                selection.clear()
                void onDeleteRows(ids)
              }
            : undefined
        }
      />
    </div>
  )
}

export function PropertyHeaderMenu({
  property,
  trigger,
  iconValue,
  onIconChange,
  onRename,
  onChangeType,
  settingsEditor,
  filterActive = false,
  sortDirection = null,
  canFilter = true,
  isFrozen = false,
  isWrapped = false,
  canWrap = false,
  onFilter,
  onSort,
  onToggleFreeze,
  onHide,
  onToggleWrap,
  onInsertLeft,
  onInsertRight,
  onDelete,
}: {
  property: DatabasePropertySummary
  trigger?: React.ReactNode
  iconValue?: string
  onIconChange?: (icon: string) => Promise<void> | void
  onRename: (name: string) => Promise<void> | void
  onChangeType?: (propertyType: string) => Promise<void> | void
  /** The settings of the property, shown in a submenu; `null` when it has none. */
  settingsEditor?: React.ReactNode
  filterActive?: boolean
  sortDirection?: "asc" | "desc" | null
  canFilter?: boolean
  isFrozen?: boolean
  isWrapped?: boolean
  canWrap?: boolean
  cursorText?: boolean
  onFilter?: () => void
  onSort?: (direction: "asc" | "desc" | null) => void
  onToggleFreeze?: () => void
  onHide?: () => void
  onToggleWrap?: () => void
  onInsertLeft?: () => void
  onInsertRight?: () => void
  onDelete?: () => Promise<void> | void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState(property.name)
  const [busy, setBusy] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const committingRef = React.useRef(false)
  const iconTriggerRef = React.useRef<HTMLButtonElement>(null)
  const [iconPickerOpen, setIconPickerOpen] = React.useState(false)
  const PropertyTypeIcon = React.useMemo(
    () => <PropertyIcon type={property.propertyType} />,
    [property.propertyType],
  )

  React.useEffect(() => {
    if (!open && !busy) setDraft(property.name)
  }, [busy, open, property.name])

  const commit = React.useCallback(async () => {
    if (committingRef.current) return
    const next = draft.trim()
    if (!next || next === property.name) {
      setDraft(property.name)
      return
    }
    committingRef.current = true
    setBusy(true)
    try {
      await onRename(next)
    } catch {
      setDraft(property.name)
    } finally {
      committingRef.current = false
      setBusy(false)
    }
  }, [draft, onRename, property.name])

  const focusName = () => {
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(draft.length, draft.length)
    })
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen) {
          setDraft(property.name)
          focusName()
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            className="flex h-full min-w-0 w-full flex-1 cursor-pointer items-center justify-start gap-2 rounded px-2 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-slate-100 hover:text-foreground dark:hover:bg-accent/40"
            title={property.name}
            aria-label={property.name}
            onClick={(event) => event.stopPropagation()}
          >
            <IconValue
              value={iconValue}
              fallback={<PropertyIcon type={property.propertyType} />}
              className="size-3.5 shrink-0"
            />
            <span className="truncate">{property.name}</span>
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={5}
        className="w-72 rounded-xl p-2"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div
          className="mb-1 flex items-center gap-2"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div className="relative shrink-0">
            <button
              ref={iconTriggerRef}
              type="button"
              disabled={!onIconChange}
              className="flex size-9 items-center justify-center rounded-lg border border-border bg-background hover:bg-accent disabled:cursor-default"
              title={t("databaseWorkspace.changeIcon")}
              aria-label={t("databaseWorkspace.changeIcon")}
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation()
                if (onIconChange) setIconPickerOpen((current) => !current)
              }}
            >
              <IconValue value={iconValue} fallback={PropertyTypeIcon} className="size-4" />
            </button>
            {iconPickerOpen && onIconChange && (
              <div className="absolute left-0 top-full z-[100] mt-1">
                <EmojiPickerPanel
                  triggerRef={iconTriggerRef}
                  onSelect={(next) => {
                    void onIconChange(next.native)
                    setIconPickerOpen(false)
                  }}
                  onClear={() => {
                    void onIconChange("")
                    setIconPickerOpen(false)
                  }}
                  clearLabel={t("tree.resetIcon")}
                  onClose={() => setIconPickerOpen(false)}
                />
              </div>
            )}
          </div>
          <div className="flex h-9 min-w-0 flex-1 items-center rounded-lg border border-border bg-background px-2.5 focus-within:ring-1 focus-within:ring-ring">
            <input
              ref={inputRef}
              value={draft}
              disabled={busy}
              aria-label={t("databaseWorkspace.propertyName")}
              className="min-w-0 flex-1 bg-transparent text-sm font-medium text-foreground outline-none disabled:opacity-60"
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => void commit()}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === "Enter") {
                  event.preventDefault()
                  void commit().then(() => setOpen(false))
                }
                if (event.key === "Escape") {
                  event.preventDefault()
                  setDraft(property.name)
                  setOpen(false)
                }
              }}
            />
            <Info
              className="size-4 shrink-0 text-muted-foreground"
              aria-label={t("databaseTable.propertyInfo")}
            />
          </div>
        </div>

        {onChangeType && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="h-9 gap-2.5 rounded-lg px-2 text-sm">
              <Repeat2 />
              <span className="truncate">{t("databaseTable.changeType")}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56 rounded-xl p-1.5">
              {[
                "text",
                "number",
                "checkbox",
                "date",
                "url",
                "select",
                "multiSelect",
                "status",
                "formula",
                "relation",
              ].map((propertyType) => (
                <DropdownMenuItem
                  key={propertyType}
                  disabled={propertyType === property.propertyType || busy}
                  className="h-9 rounded-lg"
                  onSelect={() => void onChangeType(propertyType)}
                >
                  <PropertyIcon type={propertyType} />
                  <span className="flex-1 truncate">
                    {t(`databaseWorkspace.propertyTypes.${propertyType}`)}
                  </span>
                  {propertyType === property.propertyType && <Check className="size-4" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        {settingsEditor && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="h-9 gap-2.5 rounded-lg px-2 text-sm">
              <Settings2 />
              <span className="truncate">{t("databaseProperty.settings")}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-72 rounded-xl p-3">
              {/* Typing in these fields must not reach the menu's own type-ahead and arrow keys. */}
              <div
                onKeyDown={(event) => {
                  if (event.key !== "Escape") event.stopPropagation()
                }}
              >
                {settingsEditor}
              </div>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        <DropdownMenuSeparator className="my-1.5" />

        <PropertyMenuItem
          icon={<ListFilter />}
          label={t("databaseTable.filterProperty")}
          active={filterActive}
          disabled={!onFilter || !canFilter}
          onSelect={() => {
            setOpen(false)
            onFilter?.()
          }}
        />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            className="h-9 gap-2.5 rounded-lg px-2 text-sm"
            disabled={!onSort}
          >
            <ArrowDownUp />
            <span className="truncate">{t("databaseTable.sortProperty")}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52 rounded-xl p-1.5">
            <DropdownMenuItem className="h-9 rounded-lg" onSelect={() => onSort?.("asc")}>
              <ArrowUp className="size-4" />
              {t("databaseTable.sortAscending")}
              {sortDirection === "asc" && <Check className="ml-auto size-4" />}
            </DropdownMenuItem>
            <DropdownMenuItem className="h-9 rounded-lg" onSelect={() => onSort?.("desc")}>
              <ArrowDown className="size-4" />
              {t("databaseTable.sortDescending")}
              {sortDirection === "desc" && <Check className="ml-auto size-4" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="h-9 rounded-lg"
              disabled={!sortDirection}
              onSelect={() => onSort?.(null)}
            >
              <X className="size-4" />
              {t("databaseTable.clearSort")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <PropertyMenuItem
          icon={isFrozen ? <PinOff /> : <Pin />}
          label={
            !onToggleFreeze
              ? `${t("databaseTable.freezeProperty")} · ${t("common.comingSoon")}`
              : isFrozen
                ? t("databaseTable.unfreezeProperty")
                : t("databaseTable.freezeProperty")
          }
          active={isFrozen}
          disabled={!onToggleFreeze}
          onSelect={onToggleFreeze}
        />
        <PropertyMenuItem
          icon={<EyeOff />}
          label={t("databaseTable.hideProperty")}
          disabled={!onHide}
          onSelect={onHide}
        />
        <PropertyMenuItem
          icon={<WrapText />}
          label={t("databaseTable.wrapProperty")}
          active={isWrapped}
          disabled={!canWrap || !onToggleWrap}
          onSelect={onToggleWrap}
        />

        <DropdownMenuSeparator className="my-1.5" />

        <PropertyMenuItem
          icon={<ArrowLeftToLine />}
          label={t("databaseTable.insertPropertyLeft")}
          disabled={!onInsertLeft}
          onSelect={onInsertLeft}
        />
        <PropertyMenuItem
          icon={<ArrowRightToLine />}
          label={t("databaseTable.insertPropertyRight")}
          disabled={!onInsertRight}
          onSelect={onInsertRight}
        />
        <PropertyMenuItem
          icon={<Trash2 />}
          label={t("databaseTable.deleteProperty")}
          destructive
          disabled={!onDelete}
          onSelect={() => void onDelete?.()}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PropertyMenuItem({
  icon,
  label,
  badge,
  chevron = false,
  active = false,
  destructive = false,
  disabled = false,
  onSelect,
}: {
  icon: React.ReactNode
  label: string
  badge?: string
  chevron?: boolean
  active?: boolean
  destructive?: boolean
  disabled?: boolean
  onSelect?: React.ComponentProps<typeof DropdownMenuItem>["onSelect"]
}) {
  return (
    <DropdownMenuItem
      className="h-9 gap-2.5 rounded-lg px-2 text-sm"
      variant={destructive ? "destructive" : "default"}
      disabled={disabled}
      onSelect={onSelect}
    >
      {icon}
      <span className="truncate">{label}</span>
      {badge && (
        <span className="ml-auto shrink-0 rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
          {badge}
        </span>
      )}
      {active && !chevron && <Check className="ml-auto size-4 text-primary" />}
      {chevron && <ChevronRight className={badge ? "size-4" : "ml-auto size-4"} />}
    </DropdownMenuItem>
  )
}
