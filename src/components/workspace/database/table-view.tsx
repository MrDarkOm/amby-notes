import * as React from "react"
import { motion } from "motion/react"
import { MotionSpinner } from "@/lib/motion"
import { motionTransitions } from "@/lib/motion-config"
import {
  AlignJustify,
  AlertTriangle,
  ArrowDown,
  ArrowDownUp,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpRight,
  ArrowUp,
  CalendarDays,
  Check,
  CheckSquare,
  ChevronRight,
  CircleChevronDown,
  CircleDashed,
  Eye,
  EyeOff,
  Hash,
  Info,
  Link2,
  List,
  ListFilter,
  Loader2,
  MoreHorizontal,
  Paperclip,
  Pin,
  PinOff,
  Plus,
  Repeat2,
  RotateCcw,
  Sigma,
  Search,
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

const DEFAULT_ROW_HEIGHT = 52
const WRAPPED_ROW_HEIGHT = 84
const OVERSCAN = 8
const MIN_PROPERTY_WIDTH = 56
const MIN_TITLE_WIDTH = 80
const ACTION_COLUMN_WIDTH = "3.5rem"

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
  onConfigureRelation?: (property: DatabasePropertySummary) => void
  filterValues?: Record<string, string>
  onFilterValuesChange?: (values: Record<string, string>) => void
  sortValue?: { key: string; direction: "asc" | "desc" } | null
  onSortValueChange?: (value: { key: string; direction: "asc" | "desc" } | null) => void
  hiddenPropertyIds?: Set<string>
  onHiddenPropertyIdsChange?: (hiddenPropertyIds: Set<string>) => void
  relationOptionsByProperty?: Record<
    string,
    Array<{ noteId: string; title: string; icon?: string | null }>
  >
  onOpenNote?: (noteId: string) => void
  databases?: DatabaseSummary[]
  onCreateRelationRow?: (targetDatabaseId: string, title: string) => Promise<string | void>
}

function PropertyIcon({ type }: { type: string }) {
  const Icon =
    type === "text"
      ? AlignJustify
      : type === "number"
        ? Hash
        : type === "checkbox"
          ? CheckSquare
          : type === "date"
            ? CalendarDays
            : type === "url"
              ? Link2
              : type === "select"
                ? CircleChevronDown
                : type === "multiSelect"
                  ? List
                  : type === "status"
                    ? CircleDashed
                    : type === "relation"
                      ? ArrowUpRight
                      : type === "files"
                        ? Paperclip
                        : type === "formula"
                          ? Sigma
                          : type === "rollup"
                            ? Search
                            : Type
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
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
  onConfigureRelation,
  filterValues,
  onFilterValuesChange,
  sortValue,
  onSortValueChange,
  hiddenPropertyIds: propHiddenPropertyIds,
  onHiddenPropertyIdsChange,
  relationOptionsByProperty = {},
  onOpenNote,
  databases,
  onCreateRelationRow,
}: TableViewProps) {
  const { t } = useTranslation()
  const iconOverrides = useViewStateStore((state) => state.iconOverrides)
  const setIcon = useViewStateStore((state) => state.setIcon)
  const [viewportHeight, setViewportHeight] = React.useState(480)
  const [selectedNoteId, setSelectedNoteId] = React.useState<string | null>(null)
  const [columnWidths, setColumnWidths] = React.useState<Record<string, number>>({})
  const [propertyFilters, setPropertyFilters] = React.useState<Record<string, string>>({})
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
  const initializedWidthKeys = React.useRef(new Set<string>())
  const resizeRef = React.useRef<{ key: string; startX: number; startWidth: number } | null>(null)
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const scrollTopRef = React.useRef(0)
  const rangeRafRef = React.useRef<number | null>(null)
  const nextPagePendingRef = React.useRef(false)
  const lastPageTriggerRef = React.useRef(0)

  const updateFilterValue = React.useCallback(
    (key: string, value: string) => {
      setPropertyFilters((current) => {
        const next = { ...current }
        if (value.trim()) next[key] = value
        else delete next[key]
        onFilterValuesChange?.(next)
        return next
      })
    },
    [onFilterValuesChange],
  )
  const updateSortValue = React.useCallback(
    (value: { key: string; direction: "asc" | "desc" } | null) => {
      setPropertySort(value)
      onSortValueChange?.(value)
    },
    [onSortValueChange],
  )

  React.useEffect(() => {
    if (filterValues) setPropertyFilters(filterValues)
  }, [filterValues])
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
    const available = new Set(properties.map((property) => property.propertyId))
    setHiddenPropertyIds((current) => {
      const next = new Set([...current].filter((id) => available.has(id)))
      return next.size === current.size ? current : next
    })
    setWrappedPropertyIds((current) => {
      const next = new Set([...current].filter((id) => available.has(id)))
      return next.size === current.size ? current : next
    })
    setPropertyFilters((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([key]) => key === "title" || available.has(key)),
      )
      if (Object.keys(next).length !== Object.keys(current).length) onFilterValuesChange?.(next)
      return Object.keys(next).length === Object.keys(current).length ? current : next
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
  }, [onFilterValuesChange, onSortValueChange, properties, setHiddenPropertyIds])

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
  }, [])

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
  const rowHeight = visibleProperties.some((property) =>
    wrappedPropertyIds.has(property.propertyId),
  )
    ? WRAPPED_ROW_HEIGHT
    : DEFAULT_ROW_HEIGHT
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

  return (
    <div className="min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden">
      <div
        ref={viewportRef}
        role="grid"
        aria-rowcount={tableRows.length}
        aria-colcount={visibleProperties.length + 3}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-x-auto overflow-y-auto outline-none amby-table-scroll"
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
      >
        <div style={tableWidthStyle}>
          <div
            role="row"
            className="sticky top-0 z-10 grid border-b border-slate-200 bg-white text-xs font-medium text-muted-foreground dark:border-border dark:bg-card"
            style={{ gridTemplateColumns, ...tableWidthStyle }}
          >
            <div
              role="columnheader"
              className={cn(
                "relative flex h-full min-w-0 items-center justify-start bg-white p-0 text-left dark:bg-card",
                hasFrozenColumns && "sticky left-0 z-20",
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
                  filterValue={propertyFilters.title ?? ""}
                  sortDirection={propertySort?.key === "title" ? propertySort.direction : null}
                  isFrozen={frozenColumnKey === "title"}
                  canFilter
                  onFilterChange={(value) => updateFilterValue("title", value)}
                  onSort={(direction) =>
                    updateSortValue(direction ? { key: "title", direction } : null)
                  }
                  onToggleFreeze={() =>
                    setFrozenColumnKey((current) => (current === "title" ? null : "title"))
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
                    "relative flex h-full min-w-0 items-center bg-white p-0 dark:bg-card",
                    frozen && "sticky z-20",
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
                      onConfigureRelation={
                        property.propertyType === "relation" && onConfigureRelation
                          ? () => onConfigureRelation(property)
                          : undefined
                      }
                      filterValue={propertyFilters[property.propertyId] ?? ""}
                      sortDirection={
                        propertySort?.key === property.propertyId ? propertySort.direction : null
                      }
                      isFrozen={frozenColumnKey === property.propertyId}
                      isWrapped={wrappedPropertyIds.has(property.propertyId)}
                      canWrap={property.propertyType === "text" || property.propertyType === "url"}
                      canFilter={[
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
                      ].includes(property.propertyType)}
                      onFilterChange={
                        [
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
                        ].includes(property.propertyType)
                          ? (value) => updateFilterValue(property.propertyId, value)
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
                      onToggleFreeze={() =>
                        setFrozenColumnKey((current) =>
                          current === property.propertyId ? null : property.propertyId,
                        )
                      }
                      onHide={() => {
                        setHiddenPropertyIds((current) => new Set(current).add(property.propertyId))
                        updateFilterValue(property.propertyId, "")
                        if (propertySort?.key === property.propertyId) updateSortValue(null)
                        setFrozenColumnKey((current) =>
                          current === property.propertyId ? null : current,
                        )
                      }}
                      onToggleWrap={() =>
                        setWrappedPropertyIds((current) => {
                          const next = new Set(current)
                          if (next.has(property.propertyId)) next.delete(property.propertyId)
                          else next.add(property.propertyId)
                          return next
                        })
                      }
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
              {visibleRows.map((row, index) => (
                <div
                  key={row.noteId}
                  role="row"
                  aria-rowindex={first + index + 2}
                  aria-selected={selectedNoteId === row.noteId}
                  className="grid border-b border-slate-200 text-sm dark:border-border/60"
                  style={{ gridTemplateColumns, height: rowHeight, ...tableWidthStyle }}
                >
                  <motion.div
                    role="gridcell"
                    initial="rest"
                    whileHover="hover"
                    className={cn(
                      "group relative flex cursor-text items-center justify-start truncate border-r border-slate-200 bg-white px-2 py-2 text-left font-medium hover:bg-slate-50 dark:border-border/60 dark:bg-background dark:hover:bg-accent/30",
                      hasFrozenColumns && "sticky left-0 z-10",
                    )}
                  >
                    <EditableRowTitle
                      value={row.title}
                      onCommit={(name) => onRenameRow?.(row.noteId, name)}
                    />
                    <motion.button
                      type="button"
                      className="absolute right-1 top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-md bg-white/95 text-muted-foreground shadow-sm backdrop-blur-sm hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-background/95"
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
                          "min-w-0 border-r border-slate-200 hover:bg-slate-50 dark:border-border/60 dark:hover:bg-accent/30",
                          frozen && "sticky z-10 bg-white dark:bg-background",
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
                          relationOptions={relationOptionsByProperty[property.propertyId] ?? []}
                          wrap={wrappedPropertyIds.has(property.propertyId)}
                          pending={!onCellCommit || pendingCells.has(cellKey)}
                          error={cellErrors[cellKey]}
                          targetDatabaseTitle={targetDbTitle}
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
                </div>
              ))}
            </div>
          </div>
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
  onConfigureRelation,
  filterValue = "",
  sortDirection = null,
  canFilter = true,
  isFrozen = false,
  isWrapped = false,
  canWrap = false,
  onFilterChange,
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
  onConfigureRelation?: () => void
  filterValue?: string
  sortDirection?: "asc" | "desc" | null
  canFilter?: boolean
  isFrozen?: boolean
  isWrapped?: boolean
  canWrap?: boolean
  cursorText?: boolean
  onFilterChange?: (value: string) => void
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
  const [filterEditorOpen, setFilterEditorOpen] = React.useState(Boolean(filterValue))
  const inputRef = React.useRef<HTMLInputElement>(null)
  const filterInputRef = React.useRef<HTMLInputElement>(null)
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
        } else {
          setFilterEditorOpen(Boolean(filterValue))
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

        {onConfigureRelation && (
          <PropertyMenuItem
            icon={<ArrowUpRight />}
            label={t("databaseTable.configureRelation")}
            onSelect={() => {
              setOpen(false)
              onConfigureRelation()
            }}
          />
        )}

        <DropdownMenuSeparator className="my-1.5" />

        <PropertyMenuItem
          icon={<ListFilter />}
          label={t("databaseTable.filterProperty")}
          active={Boolean(filterValue)}
          disabled={!onFilterChange || !canFilter}
          onSelect={(event) => {
            event.preventDefault()
            setFilterEditorOpen(true)
            requestAnimationFrame(() => filterInputRef.current?.focus())
          }}
        />
        {filterEditorOpen && onFilterChange && (
          <div
            className="mx-1 mb-1 flex h-9 items-center rounded-lg border border-border bg-background px-2 focus-within:ring-1 focus-within:ring-ring"
            onKeyDown={(event) => event.stopPropagation()}
          >
            <input
              ref={filterInputRef}
              autoFocus
              value={filterValue}
              placeholder={t("databaseTable.filterPlaceholder")}
              aria-label={t("databaseTable.filterProperty")}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              onChange={(event) => onFilterChange(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault()
                  setFilterEditorOpen(false)
                }
              }}
            />
            {filterValue && (
              <button
                type="button"
                className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                title={t("databaseTable.clearFilter")}
                aria-label={t("databaseTable.clearFilter")}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => onFilterChange("")}
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        )}
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
          label={isFrozen ? t("databaseTable.unfreezeProperty") : t("databaseTable.freezeProperty")}
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

function EditableRowTitle({
  value,
  onCommit,
}: {
  value: string
  onCommit?: (name: string) => Promise<void> | void
}) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(value)
  const [busy, setBusy] = React.useState(false)
  const committingRef = React.useRef(false)

  React.useEffect(() => {
    if (!editing && !busy) setDraft(value)
  }, [busy, editing, value])

  const commit = React.useCallback(async () => {
    if (committingRef.current) return
    const next = draft.trim()
    if (!next || next === value || !onCommit) {
      setDraft(value)
      setEditing(false)
      return
    }
    committingRef.current = true
    setBusy(true)
    try {
      await onCommit(next)
      setEditing(false)
    } catch {
      setDraft(value)
      setEditing(false)
    } finally {
      committingRef.current = false
      setBusy(false)
    }
  }, [draft, onCommit, value])

  return (
    <input
      value={draft}
      readOnly={!editing || busy}
      aria-label={value}
      className="h-8 min-w-0 w-full cursor-text truncate bg-transparent p-0 text-left text-sm font-medium text-foreground outline-none"
      onFocus={() => {
        if (!busy && onCommit) setEditing(true)
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (!busy && onCommit) setEditing(true)
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === "Enter") {
          event.preventDefault()
          void commit()
        }
        if (event.key === "Escape") {
          event.preventDefault()
          setDraft(value)
          setEditing(false)
        }
      }}
    />
  )
}
