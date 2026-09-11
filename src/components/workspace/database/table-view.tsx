import * as React from "react"
import { motion } from "motion/react"
import { MotionSpinner } from "@/lib/motion"
import { motionTransitions } from "@/lib/motion-config"
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownUp,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUp,
  CalendarDays,
  Check,
  CheckSquare,
  ChevronRight,
  Eye,
  EyeOff,
  Group,
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
  SlidersHorizontal,
  Sparkles,
  SquareArrowOutUpRight,
  Tags,
  Trash2,
  Type,
  Waypoints,
  WrapText,
  X,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { DatabasePropertySummary, DatabaseRow } from "@/lib/storage"
import { DatabaseCell } from "./database-cell"
import { databaseCellText, readDatabaseCellValue } from "./database-cell-value"
import { IconValue } from "../icon-value"
import { EmojiPickerPanel } from "../tiptap/EmojiPickerPanel"
import { useViewStateStore } from "../use-view-state-store"
import { databasePropertyIconKey } from "./property-icon"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
const MIN_TITLE_WIDTH = 180
const ACTION_COLUMN_WIDTH = "2.75rem"

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
}

function PropertyIcon({ type }: { type: string }) {
  const Icon =
    type === "number"
      ? Hash
      : type === "checkbox"
        ? CheckSquare
        : type === "date"
          ? CalendarDays
          : type === "url"
            ? Link2
            : type === "select"
              ? List
              : type === "multiSelect" || type === "status"
                ? Tags
                : type === "relation"
                  ? Waypoints
                  : type === "files"
                    ? Paperclip
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
  return Math.min(100, Math.max(MIN_PROPERTY_WIDTH, Math.ceil(longestWord * 7.5) + 36))
}

function propertyCellDisplayText(row: DatabaseRow, property: DatabasePropertySummary) {
  const value = readDatabaseCellValue(row.valuesJson, property.propertyId)
  if (!value) return ""
  if (property.propertyType === "checkbox") return value.checked === true ? "1" : "0"
  if (property.propertyType === "select" || property.propertyType === "status") {
    const option = property.options.find((candidate) => candidate.optionId === value.optionId)
    return option?.name ?? ""
  }
  if (property.propertyType === "multiSelect") {
    const ids = Array.isArray(value.optionIds) ? (value.optionIds as string[]) : []
    return ids
      .map((id) => property.options.find((candidate) => candidate.optionId === id)?.name ?? "")
      .filter(Boolean)
      .join(" ")
  }
  return databaseCellText(value, property.propertyType)
}

function defaultTitleWidth(rows: DatabaseRow[]) {
  const longestWord = rows
    .flatMap((row) => row.title.trim().split(/\s+/u))
    .reduce((max, word) => Math.max(max, word.length), "Название".length)
  return Math.min(280, Math.max(MIN_TITLE_WIDTH, Math.ceil(longestWord * 7.5) + 36))
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
  const [hiddenPropertyIds, setHiddenPropertyIds] = React.useState<Set<string>>(new Set())
  const [wrappedPropertyIds, setWrappedPropertyIds] = React.useState<Set<string>>(new Set())
  const [frozenColumnKey, setFrozenColumnKey] = React.useState<string | null>(null)
  const initializedWidthKeys = React.useRef(new Set<string>())
  const resizeRef = React.useRef<{ key: string; startX: number; startWidth: number } | null>(null)
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const scrollTopRef = React.useRef(0)
  const rangeRafRef = React.useRef<number | null>(null)
  const nextPagePendingRef = React.useRef(false)

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
      return Object.keys(next).length === Object.keys(current).length ? current : next
    })
    setPropertySort((current) =>
      current && current.key !== "title" && !available.has(current.key) ? null : current,
    )
    setFrozenColumnKey((current) =>
      current && current !== "title" && !available.has(current) ? null : current,
    )
  }, [properties])

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
  const hiddenProperties = properties.filter((property) =>
    hiddenPropertyIds.has(property.propertyId),
  )
  const tableRows = React.useMemo(() => {
    const propertyById = new Map(properties.map((property) => [property.propertyId, property]))
    const cellText = (row: DatabaseRow, key: string) => {
      if (key === "title") return row.title
      const property = propertyById.get(key)
      return property ? propertyCellDisplayText(row, property) : ""
    }
    const filtered = rows.filter((row) =>
      Object.entries(propertyFilters).every(([key, query]) =>
        cellText(row, key).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ),
    )
    if (!propertySort) return filtered
    return [...filtered].sort((left, right) => {
      const leftValue = cellText(left, propertySort.key)
      const rightValue = cellText(right, propertySort.key)
      if (!leftValue && rightValue) return 1
      if (leftValue && !rightValue) return -1
      const comparison = leftValue.localeCompare(rightValue, undefined, {
        numeric: true,
        sensitivity: "base",
      })
      return propertySort.direction === "asc" ? comparison : -comparison
    })
  }, [properties, propertyFilters, propertySort, rows])
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
    ACTION_COLUMN_WIDTH,
  ].join(" ")
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
    resizeRef.current = {
      key,
      startX: event.clientX,
      startWidth:
        columnWidths[key] ?? (key === "title" ? defaultTitleWidth(rows) : MIN_PROPERTY_WIDTH),
    }
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
  }

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const element = event.currentTarget
    scrollTopRef.current = element.scrollTop
    scheduleRangeUpdate()
    if (
      hasNextPage &&
      !loading &&
      !nextPagePendingRef.current &&
      element.scrollTop + element.clientHeight >= element.scrollHeight - 320
    ) {
      nextPagePendingRef.current = true
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

  return (
    <div className="min-h-0 flex flex-1 flex-col overflow-hidden">
      <div
        ref={viewportRef}
        role="grid"
        aria-rowcount={tableRows.length}
        aria-colcount={visibleProperties.length + 3}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto outline-none"
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
      >
        <div className="min-w-max">
          <div
            role="row"
            className="sticky top-0 z-10 grid border-b border-slate-200 bg-white text-xs font-medium text-muted-foreground dark:border-border dark:bg-card"
            style={{ gridTemplateColumns }}
          >
            <div
              role="columnheader"
              className={cn(
                "relative flex items-center justify-start gap-2 bg-white px-2 py-2 text-left dark:bg-card",
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
                  onFilterChange={(value) =>
                    setPropertyFilters((current) => {
                      const next = { ...current }
                      if (value.trim()) next.title = value
                      else delete next.title
                      return next
                    })
                  }
                  onSort={(direction) =>
                    setPropertySort(direction ? { key: "title", direction } : null)
                  }
                  onToggleFreeze={() =>
                    setFrozenColumnKey((current) => (current === "title" ? null : "title"))
                  }
                  onInsertRight={
                    onAddProperty ? () => onAddProperty(properties[0]?.propertyId) : undefined
                  }
                />
              ) : (
                <>
                  <Type className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{titleColumnName ?? t("databaseTable.title")}</span>
                </>
              )}
              <span
                className="absolute right-0 top-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-primary/60"
                onPointerDown={(event) => startResize(event, "title")}
              />
            </div>
            {visibleProperties.map((property, propertyIndex) => {
              const frozen = hasFrozenColumns && propertyIndex <= frozenThroughIndex
              return (
                <div
                  key={property.propertyId}
                  role="columnheader"
                  className={cn(
                    "relative flex min-w-0 items-center gap-2 px-2 py-2",
                    frozen && "sticky z-20 bg-white dark:bg-card",
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
                      filterValue={propertyFilters[property.propertyId] ?? ""}
                      sortDirection={
                        propertySort?.key === property.propertyId ? propertySort.direction : null
                      }
                      isFrozen={frozenColumnKey === property.propertyId}
                      isWrapped={wrappedPropertyIds.has(property.propertyId)}
                      canWrap={property.propertyType === "text" || property.propertyType === "url"}
                      onFilterChange={(value) =>
                        setPropertyFilters((current) => {
                          const next = { ...current }
                          if (value.trim()) next[property.propertyId] = value
                          else delete next[property.propertyId]
                          return next
                        })
                      }
                      onSort={(direction) =>
                        setPropertySort(direction ? { key: property.propertyId, direction } : null)
                      }
                      onToggleFreeze={() =>
                        setFrozenColumnKey((current) =>
                          current === property.propertyId ? null : property.propertyId,
                        )
                      }
                      onHide={() => {
                        setHiddenPropertyIds((current) => new Set(current).add(property.propertyId))
                        setPropertyFilters((current) => {
                          const next = { ...current }
                          delete next[property.propertyId]
                          return next
                        })
                        setPropertySort((current) =>
                          current?.key === property.propertyId ? null : current,
                        )
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
                    <>
                      <IconValue
                        value={
                          iconOverrides[databasePropertyIconKey(databaseId, property.propertyId)]
                        }
                        fallback={<PropertyIcon type={property.propertyType} />}
                        className="size-3.5"
                      />
                      <span className="truncate">{property.name}</span>
                    </>
                  )}
                  <span
                    className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/60"
                    onPointerDown={(event) => startResize(event, property.propertyId)}
                  />
                </div>
              )
            })}
            <div role="columnheader" className="flex items-center justify-center">
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                title={t("databaseWorkspace.addProperty")}
                aria-label={t("databaseWorkspace.addProperty")}
                onClick={() => onAddProperty?.()}
              >
                <Plus className="size-4" />
              </button>
            </div>
            <div role="columnheader" className="flex items-center justify-center">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    title={t("databaseTable.columnActions")}
                    aria-label={t("databaseTable.columnActions")}
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuItem disabled={!onAddProperty} onSelect={() => onAddProperty?.()}>
                    <Plus className="size-4" />
                    {t("databaseWorkspace.addProperty")}
                  </DropdownMenuItem>
                  {hiddenProperties.length > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>{t("databaseTable.hiddenProperties")}</DropdownMenuLabel>
                      {hiddenProperties.map((property) => (
                        <DropdownMenuCheckboxItem
                          key={property.propertyId}
                          checked={false}
                          onCheckedChange={() =>
                            setHiddenPropertyIds((current) => {
                              const next = new Set(current)
                              next.delete(property.propertyId)
                              return next
                            })
                          }
                        >
                          <Eye className="size-4" />
                          <span className="truncate">{property.name}</span>
                        </DropdownMenuCheckboxItem>
                      ))}
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <div style={{ height: tableRows.length * rowHeight, position: "relative" }}>
            <div style={{ position: "absolute", top: first * rowHeight, left: 0, right: 0 }}>
              {visibleRows.map((row, index) => (
                <div
                  key={row.noteId}
                  role="row"
                  aria-rowindex={first + index + 2}
                  aria-selected={selectedNoteId === row.noteId}
                  className="grid border-b border-slate-200 text-sm dark:border-border/60"
                  style={{ gridTemplateColumns, height: rowHeight }}
                >
                  <motion.div
                    role="gridcell"
                    initial="rest"
                    whileHover="hover"
                    className={cn(
                      "group relative flex items-center justify-start truncate border-r border-slate-200 bg-white px-2 py-2 pr-10 text-left font-medium hover:bg-slate-50 dark:border-border/60 dark:bg-background dark:hover:bg-accent/30",
                      hasFrozenColumns && "sticky left-0 z-10",
                    )}
                    style={{ paddingLeft: 8 + row.depth * 12 }}
                  >
                    <EditableRowTitle
                      value={row.title}
                      onCommit={(name) => onRenameRow?.(row.noteId, name)}
                    />
                    <motion.button
                      type="button"
                      className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md bg-white/90 text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-background/90"
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
                    return (
                      <div
                        key={property.propertyId}
                        role="gridcell"
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
                          wrap={wrappedPropertyIds.has(property.propertyId)}
                          pending={!onCellCommit || pendingCells.has(cellKey)}
                          error={cellErrors[cellKey]}
                          onCommit={(valueJson) =>
                            onCellCommit?.(row, property, valueJson) ?? Promise.resolve()
                          }
                        />
                      </div>
                    )
                  })}
                  <div aria-hidden="true" />
                  <div aria-hidden="true" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {onCreateRow && (
        <div className="shrink-0 bg-white px-3 py-2 dark:bg-card">
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onCreateRow}
          >
            <Plus className="size-3.5" />
            {newPageLabel ?? t("databaseWorkspace.newPage")}
          </button>
        </div>
      )}
      {loading && (
        <div className="flex shrink-0 items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
          <MotionSpinner>
            <Loader2 className="size-4" />
          </MotionSpinner>
          {t("databaseTable.loading")}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-center gap-2 border-t border-border px-4 py-3 text-xs text-destructive"
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
  )
}

export function PropertyHeaderMenu({
  property,
  trigger,
  iconValue,
  onIconChange,
  onRename,
  filterValue = "",
  sortDirection = null,
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
  filterValue?: string
  sortDirection?: "asc" | "desc" | null
  isFrozen?: boolean
  isWrapped?: boolean
  canWrap?: boolean
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
        if (nextOpen) setDraft(property.name)
        else setFilterEditorOpen(Boolean(filterValue))
      }}
    >
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            className="flex min-w-0 items-center justify-start gap-2 rounded py-0.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
            title={property.name}
            aria-label={property.name}
            onClick={(event) => event.stopPropagation()}
          >
            <IconValue
              value={iconValue}
              fallback={<PropertyIcon type={property.propertyType} />}
              className="size-3.5"
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

        <PropertyMenuItem
          icon={<SlidersHorizontal />}
          label={t("databaseTable.editProperty")}
          chevron
          onSelect={(event) => {
            event.preventDefault()
            focusName()
          }}
        />
        <PropertyMenuItem
          icon={<Repeat2 />}
          label={t("databaseTable.changeType")}
          chevron
          disabled
        />
        <PropertyMenuItem
          icon={<Sparkles />}
          label={t("databaseTable.aiAutofill")}
          badge={t("databaseTable.aiAutofillBadge")}
          chevron
          disabled
        />

        <DropdownMenuSeparator className="my-1.5" />

        <PropertyMenuItem
          icon={<ListFilter />}
          label={t("databaseTable.filterProperty")}
          active={Boolean(filterValue)}
          disabled={!onFilterChange}
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
        <PropertyMenuItem icon={<Group />} label={t("databaseTable.groupProperty")} disabled />
        <PropertyMenuItem
          icon={<Sigma />}
          label={t("databaseTable.calculateProperty")}
          chevron
          disabled
        />
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
      className="h-8 min-w-0 w-full truncate bg-transparent p-0 text-left text-sm font-medium text-foreground outline-none"
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
