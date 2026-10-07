import * as React from "react"
import {
  ArrowDownUp,
  Check,
  ChevronDown,
  Copy,
  Database,
  Eye,
  FileText,
  Filter,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { AnimatePresence, Reorder, motion } from "motion/react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import { motionTransition, motionTransitions } from "@/lib/motion-config"
import { logger } from "@/lib/logger"
import { cn } from "@/lib/utils"
import {
  applyDatabaseValueBatch,
  changeDatabasePropertyType,
  createDatabaseProperty,
  createDatabaseView,
  deleteDatabaseView,
  duplicateDatabaseView,
  deleteDatabaseProperty,
  createDatabaseRow,
  getDatabaseView,
  renameDatabase,
  renameDatabaseProperty,
  renameDatabaseView,
  updateDatabasePropertyOptions,
  reorderDatabaseViews,
  updateDatabasePropertyConfig,
  configureDatabaseRollup,
  listDatabases,
  resolveDatabaseYamlConflict,
  syncDatabaseYaml,
  setDefaultDatabaseView,
  updateDatabaseViewConfig,
  undoDatabaseMutation,
  redoDatabaseMutation,
  getDatabaseHistoryStatus,
  type DatabaseYamlConflict,
  type DatabaseYamlResolution,
  type DatabaseFieldRef,
  type DatabaseRow,
  type DatabaseRowTemplate,
  type CreatedDatabaseRow,
  type DatabasePropertySummary,
  type DatabaseYamlSyncResult,
} from "@/lib/storage"
import { useDatabaseStore } from "./database-store"
import { useDatabaseQuery } from "./use-database-query"
import { TableView } from "./table-view"
import { DatabaseSidePeek } from "./peek/database-side-peek"
import { BoardView, GalleryView, ListView } from "./layouts"
import { placeNewRecordInLane } from "./new-record-lane"
import { useViewQueryState } from "./use-view-query-state"
import { BoardLanesView } from "./board-lanes-view"
import { GalleryLanesView } from "./gallery-lanes-view"
import { ViewFilterEditor } from "./view-filter-editor"
import { ViewSortEditor } from "./view-sort-editor"
import { conditionsToFilter } from "./view-config"
import { EMPTY_ROLLUP_DRAFT, type RollupDraft } from "./rollup-model"
import type { CardCellEdit } from "./database-value-cell"
import { applyCellValue } from "./database-cell-value"
import { PeekProperties } from "./peek/peek-properties"
import { SortResetDialog } from "./sort-reset-dialog"
import { applyManualOrder } from "./row-order"
import {
  useDeleteRows,
  useRowMenu,
  useRowReorderConfig,
  type DatabaseRowActions,
} from "./use-row-menu"
import { BoardGroupPrompt } from "./board-group-prompt"
import { OptionActionsProvider, type OptionActions } from "./option-actions"
import { databaseErrorText } from "./database-error"
import { PropertyConfigEditor, type PropertyConfigPatch } from "./property-config-editor"
import { hasPropertySettings, type RelationConfigState } from "./property-settings"
import {
  defaultStatusOptionNames,
  draftsFromProperty,
  isOptionProperty,
  draftsToInputs,
  nextOptionColor,
  type OptionDraft,
} from "./option-model"
import {
  createDatabaseOperationId,
  createRelationTargetRow,
  usePropertyMutation,
} from "./use-property-mutation"
import { referenceTitles, relationTargetIds, useRecordReferences } from "./use-record-references"
import { ChartView } from "./chart-view"
import type { DatabaseHostKind } from "./database-store"
import type { Document } from "../use-doc-store"
import { EmojiPickerPanel } from "../tiptap/EmojiPickerPanel"
import { IconValue } from "../icon-value"
import { normalizeDatabaseIcon } from "./database-icon"
import { EDITOR_CONTENT_WIDTH } from "@/lib/themes"
import type { ContentWidth } from "../app-config"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DatabaseViewDialog, DatabaseRowDialog, DatabasePropertyDialog } from "./database-dialogs"
import { PeekRowEditor } from "./database-peek-editor"
import { DatabaseFloatingToolbar } from "./database-floating-toolbar"
import { QueryPanelButton } from "./database-view-menu"
import { ViewSettingsPanel } from "./view-settings-panel"
import { ViewIcon } from "./view-icon"
import { readLastView, rememberLastView } from "./last-view-memory"
import { ViewTabItem, type ViewTabDrag } from "./view-tab-item"
import { databasePropertyIconKey, databaseViewIconKey } from "./property-icon"
import { useViewStateStore } from "../use-view-state-store"

interface DatabaseWorkspaceProps {
  databaseId: string
  title: string
  onOpenInNewTab: () => void
  hostKind?: DatabaseHostKind
  hostId?: string | null
  vault?: string
  isLocked?: boolean
  onToggleLock?: () => void
  onOpenRowFullPage?: (row: DatabaseRow) => void
  onRenameRow?: (rowId: string, name: string) => Promise<void> | void
  onLoadRowDocument?: (row: DatabaseRow) => Promise<Document>
  onRowContentChange?: (fileId: string, content: string) => void
  onCatalogChanged?: () => Promise<void>
  onRowCreated?: (row: CreatedDatabaseRow) => Promise<void>
  icon?: string | null
  onRenameTitle?: (newName: string) => void
  onIconChange?: (icon: string) => void
  contentWidth?: ContentWidth
  onContentWidthChange?: (width: ContentWidth) => void
  titleColumnName?: string
  onTitleColumnNameChange?: (name: string) => void
  onRenameProperty?: (propertyId: string, name: string) => Promise<void> | void
  onOpenNote?: (noteId: string) => void
  /** Favourites, windows, delete and move of the pages: what the row menu offers beyond the database. */
  rowActions?: DatabaseRowActions
  /** The title and icon are shown by the host (a project page), so the database does not repeat them. */
  hideHeader?: boolean
}

const EMPTY_PROPERTIES: DatabasePropertySummary[] = []
const EMPTY_ROWS: DatabaseRow[] = []

function relationTargetFromConfig(configJson: string, reciprocalOnly = false): string | undefined {
  try {
    const config = JSON.parse(configJson) as {
      targetDatabaseId?: unknown
      inversePropertyId?: unknown
    }
    if (reciprocalOnly && !config.inversePropertyId) return undefined
    return typeof config.targetDatabaseId === "string" ? config.targetDatabaseId : undefined
  } catch {
    return undefined
  }
}

async function expectedRelatedManifestRevisions(
  sourceDatabaseId: string,
  unavailableMessage: string,
  ...targetDatabaseIds: Array<string | undefined>
): Promise<Array<{ databaseId: string; revision: string }>> {
  const relatedIds = [
    ...new Set(
      targetDatabaseIds.filter((databaseId): databaseId is string =>
        Boolean(databaseId && databaseId !== sourceDatabaseId),
      ),
    ),
  ]
  if (!relatedIds.length) return []

  const summaries = await listDatabases()
  return relatedIds.flatMap((databaseId) => {
    const summary = summaries.find((candidate) => candidate.databaseId === databaseId)
    if (!summary?.manifestRevision) throw new Error(unavailableMessage)
    return [{ databaseId, revision: summary.manifestRevision }]
  })
}

export function DatabaseWorkspace({
  databaseId,
  title,
  hostKind = "tab",
  hostId = null,
  vault,
  isLocked: propIsLocked,
  onToggleLock,
  onOpenRowFullPage,
  onRenameRow,
  onLoadRowDocument,
  onRowContentChange,
  onCatalogChanged,
  onRowCreated,
  icon,
  onRenameTitle,
  onIconChange,
  contentWidth = "normal",
  onContentWidthChange,
  titleColumnName,
  onTitleColumnNameChange,
  onRenameProperty,
  onOpenNote,
  rowActions,
  hideHeader = false,
}: DatabaseWorkspaceProps) {
  const { t } = useTranslation()
  const handleOpenNote = React.useCallback(
    (noteId: string) => {
      if (onOpenNote) {
        onOpenNote(noteId)
      } else {
        onOpenRowFullPage?.({
          noteId,
          title: "",
          relativePath: "",
          parentNoteId: null,
          depth: 0,
          categoryPath: [],
          valuesJson: "{}",
          rowRevision: "",
        })
      }
    },
    [onOpenNote, onOpenRowFullPage],
  )
  const runtime = useDatabaseStore((state) => state.runtime)
  const catalogStatus = useDatabaseStore((state) => state.catalogStatus)
  const database = useDatabaseStore((state) =>
    state.databases.find(
      (candidate) => candidate.databaseId === databaseId || candidate.attachedNoteId === databaseId,
    ),
  )
  const databases = useDatabaseStore((state) => state.databases)
  const [selectedViewId, setSelectedViewIdState] = React.useState<string | null>(() =>
    readLastView(databaseId),
  )
  // The choice is kept per database, so reopening it (or the app) shows the same view.
  const setSelectedViewId = React.useCallback(
    (next: string | null) => {
      setSelectedViewIdState(next)
      if (next) rememberLastView(databaseId, next)
    },
    [databaseId],
  )
  // A workspace reused for another database starts from that database's last view.
  const [viewScope, setViewScope] = React.useState(databaseId)
  if (viewScope !== databaseId) {
    setViewScope(databaseId)
    setSelectedViewIdState(readLastView(databaseId))
  }
  const [activeViewMenuOpen, setActiveViewMenuOpen] = React.useState(false)
  const [viewDisplayModes, setViewDisplayModes] = React.useState<
    Record<string, "both" | "icon" | "text">
  >(() => {
    try {
      const raw = localStorage.getItem("amby:db-view-display-modes")
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  })
  const setViewDisplayMode = React.useCallback(
    (targetViewId: string, mode: "both" | "icon" | "text") => {
      setViewDisplayModes((current) => {
        const key = `${databaseId}:${targetViewId}`
        const next = { ...current, [key]: mode }
        try {
          localStorage.setItem("amby:db-view-display-modes", JSON.stringify(next))
        } catch {
          // Ignore
        }
        return next
      })
    },
    [databaseId],
  )
  const [viewDialogOpen, setViewDialogOpen] = React.useState(false)
  const [viewName, setViewName] = React.useState("")
  const [viewLayout, setViewLayout] = React.useState<
    "table" | "board" | "list" | "gallery" | "chart"
  >("table")
  const [selectedRowId, setSelectedRowId] = React.useState<string | null>(null)
  // A card opened from a board lane may not be in the loaded table page.
  const [selectedRowSnapshot, setSelectedRowSnapshot] = React.useState<DatabaseRow | null>(null)
  const [rowDialogOpen, setRowDialogOpen] = React.useState(false)
  const [rowTitle, setRowTitle] = React.useState("")
  const [rowTemplate, setRowTemplate] = React.useState<DatabaseRowTemplate>({ kind: "empty" })
  // Set when the page is added from a board lane: it is created in that lane.
  const [rowLaneKey, setRowLaneKey] = React.useState<string | null>(null)
  const [databaseTitle, setDatabaseTitle] = React.useState(title)
  const [editingDatabaseTitle, setEditingDatabaseTitle] = React.useState(false)
  const [databaseIcon, setDatabaseIcon] = React.useState(() => normalizeDatabaseIcon(icon) ?? "")
  const [iconPickerOpen, setIconPickerOpen] = React.useState(false)
  const iconTriggerRef = React.useRef<HTMLButtonElement>(null)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState("")
  const toolbarContainerRef = React.useRef<HTMLDivElement>(null)
  const viewsMeasureRef = React.useRef<HTMLDivElement>(null)
  const actionsRef = React.useRef<HTMLDivElement>(null)
  const expandedActionsWidthRef = React.useRef<number>(320)
  const [isCompactToolbar, setIsCompactToolbar] = React.useState(false)
  const isCompactToolbarRef = React.useRef(isCompactToolbar)
  isCompactToolbarRef.current = isCompactToolbar

  const updateToolbarLayout = React.useCallback(() => {
    const container = toolbarContainerRef.current
    if (!container) return

    if (!isCompactToolbarRef.current && actionsRef.current) {
      const currentWidth = actionsRef.current.offsetWidth
      if (currentWidth > 160) {
        expandedActionsWidthRef.current = currentWidth
      }
    }

    const containerWidth = container.clientWidth
    const measuredViewsWidth = viewsMeasureRef.current?.offsetWidth
    const viewsCount = database?.views.length ?? 0
    const viewsNaturalWidth =
      measuredViewsWidth && measuredViewsWidth > 0 ? measuredViewsWidth + 36 : viewsCount * 90 + 36
    const gap = 16
    const neededWidth = viewsNaturalWidth + expandedActionsWidthRef.current + gap

    setIsCompactToolbar((prev) => {
      if (!prev && containerWidth < neededWidth) {
        return true
      }
      if (prev && containerWidth >= neededWidth + 24) {
        return false
      }
      return prev
    })
  }, [database?.views.length])

  React.useEffect(() => {
    const container = toolbarContainerRef.current
    if (!container) return

    const observer = new ResizeObserver(() => {
      updateToolbarLayout()
    })
    observer.observe(container)
    if (viewsMeasureRef.current) {
      observer.observe(viewsMeasureRef.current)
    }

    updateToolbarLayout()

    return () => observer.disconnect()
  }, [database?.views.length, viewDisplayModes, updateToolbarLayout])
  const [propertyDialogOpen, setPropertyDialogOpen] = React.useState(false)
  const [propertyInsertBeforeId, setPropertyInsertBeforeId] = React.useState<string | undefined>()
  const [propertyName, setPropertyName] = React.useState("")
  const [propertyType, setPropertyType] = React.useState("text")
  const [formulaExpression, setFormulaExpression] = React.useState("0")
  const [rollupDraft, setRollupDraft] = React.useState<RollupDraft>(EMPTY_ROLLUP_DRAFT)
  const [relationTargetDatabaseId, setRelationTargetDatabaseId] = React.useState(databaseId)
  const [relationMaxItems, setRelationMaxItems] = React.useState<number | null>(null)
  const [relationTwoWay, setRelationTwoWay] = React.useState(false)
  const [relationInversePropertyName, setRelationInversePropertyName] = React.useState("")
  const [relationSelfDual, setRelationSelfDual] = React.useState(true)
  const [mutationBusy, setMutationBusy] = React.useState(false)
  const [mutationError, setMutationError] = React.useState<string | null>(null)
  const [yamlSyncState, setYamlSyncState] = React.useState<{
    rowId: string
    busy: boolean
    error: string | null
    result: DatabaseYamlSyncResult | null
  } | null>(null)
  // A remembered view that no longer exists (deleted elsewhere) falls back to the first one.
  const viewId =
    (selectedViewId && database?.views.some((view) => view.viewId === selectedViewId)
      ? selectedViewId
      : null) ??
    database?.views[0]?.viewId ??
    null
  const selectedView = database?.views.find((view) => view.viewId === viewId)
  const activeView = selectedView ?? database?.views[0]
  const iconOverrides = useViewStateStore((state) => state.iconOverrides)
  const setIcon = useViewStateStore((state) => state.setIcon)
  const [isLockedStub, setIsLockedStub] = React.useState(false)
  const isDatabaseLocked = Boolean(
    propIsLocked !== undefined ? propIsLocked : database?.locked || isLockedStub,
  )
  const handleToggleLock = onToggleLock ?? (() => setIsLockedStub((current) => !current))
  const [isLinkCopied, setIsLinkCopied] = React.useState(false)
  // The view settings panel stays open while the layout changes; it is closed on purpose.
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [settingsFocusSignal, setSettingsFocusSignal] = React.useState(0)
  // The panel is laid out against the whole section (like the status bar below it, so their right
  // edges line up) but starts under the toolbar: the content area's top tells where.
  const sectionRef = React.useRef<HTMLElement>(null)
  const contentAreaRef = React.useRef<HTMLDivElement>(null)
  const [settingsPanelTop, setSettingsPanelTop] = React.useState(48)
  React.useLayoutEffect(() => {
    if (!settingsOpen) return
    const section = sectionRef.current
    const area = contentAreaRef.current
    if (!section || !area) return
    const update = () =>
      setSettingsPanelTop(
        Math.round(area.getBoundingClientRect().top - section.getBoundingClientRect().top) + 8,
      )
    update()
    const observer = new ResizeObserver(update)
    observer.observe(section)
    observer.observe(area)
    return () => observer.disconnect()
  }, [settingsOpen])

  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const {
    savedView,
    viewSettings,
    updateViewSettings,
    activeHiddenPropertyIds,
    setViewHiddenPropertyIds,
    togglePropertyVisibility,
    savedConditions,
    filterCount,
    filteredFieldKeys,
    sortValue,
    setSortValue,
    tableSavedSettings,
    queryFilter,
    querySorts,
    queryManualOrder,
  } = useViewQueryState({
    databaseId,
    vaultGeneration,
    activeView,
    isDatabaseLocked,
    onCatalogChanged,
  })
  React.useEffect(() => {
    if (savedView.error) setMutationError(savedView.error)
  }, [savedView.error])
  // Cards (board, list, gallery) show the properties the view shows; every view has its own list.
  const cardFieldIds = React.useMemo(
    () =>
      database
        ? database.properties
            .filter((property) => !activeHiddenPropertyIds.has(property.propertyId))
            .map((property) => property.propertyId)
        : null,
    [activeHiddenPropertyIds, database],
  )
  const [queryPanel, setQueryPanel] = React.useState<"filter" | "sort" | null>(null)
  const [requestedFilterField, setRequestedFilterField] = React.useState<string | null>(null)
  // The saved setting is the newest word on grouping; the catalog summary catches up after a save.
  const groupField = React.useMemo<DatabaseFieldRef | null>(() => {
    if (savedView.ready) {
      return viewSettings.groupBy ? { kind: "property", propertyId: viewSettings.groupBy } : null
    }
    return selectedView?.groupField ?? null
  }, [savedView.ready, selectedView?.groupField, viewSettings.groupBy])
  const groupDisplay = React.useMemo(
    () => ({
      sort: viewSettings.groupSort,
      order: viewSettings.groupOrder,
      hidden: viewSettings.hiddenGroups,
      hideEmpty: viewSettings.hideEmptyGroups,
    }),
    [
      viewSettings.groupSort,
      viewSettings.groupOrder,
      viewSettings.hiddenGroups,
      viewSettings.hideEmptyGroups,
    ],
  )
  // Board columns and gallery groups both need a Select or Status property to group by.
  const groupingLayout = selectedView?.layout === "board" || selectedView?.layout === "gallery"
  const boardGroupProperty = React.useMemo(() => {
    const group = groupField
    if (!groupingLayout || !group || group.kind !== "property") return null
    const property = database?.properties.find(
      (candidate) => candidate.propertyId === group.propertyId,
    )
    return property && (property.propertyType === "select" || property.propertyType === "status")
      ? property
      : null
  }, [database?.properties, groupField, groupingLayout])

  const queriesEnabled =
    Boolean(runtime?.enabled) && catalogStatus === "ready" && Boolean(database) && savedView.ready
  const boardEnabled = queriesEnabled
  const {
    host: queriedHost,
    loadNextPage,
    retry,
  } = useDatabaseQuery({
    databaseId,
    vaultGeneration,
    enabled: queriesEnabled,
    viewId,
    hostKind,
    hostId,
    search: searchQuery,
    filter: queryFilter,
    sorts: querySorts,
    manualOrder: queryManualOrder,
  })
  const activeHost = queriedHost
  const computedErrors = React.useMemo(() => {
    const errors: { formula?: string; rollup?: string } = {}
    for (const diagnostic of activeHost?.diagnostics ?? []) {
      if (diagnostic.code === "formulaError") errors.formula ??= diagnostic.message
      if (diagnostic.code === "rollupError") errors.rollup ??= diagnostic.message
    }
    return errors
  }, [activeHost?.diagnostics])

  const [historyStatus, setHistoryStatus] = React.useState<{ canUndo: boolean; canRedo: boolean }>({
    canUndo: false,
    canRedo: false,
  })

  const refreshHistoryStatus = React.useCallback(async () => {
    try {
      const status = await getDatabaseHistoryStatus(databaseId)
      setHistoryStatus({ canUndo: status.canUndo, canRedo: status.canRedo })
    } catch {
      // ignore
    }
  }, [databaseId])

  React.useEffect(() => {
    void refreshHistoryStatus()
  }, [refreshHistoryStatus, database])

  const handleUndo = React.useCallback(async () => {
    if (!historyStatus.canUndo || isDatabaseLocked) return
    try {
      const result = await undoDatabaseMutation(databaseId)
      setHistoryStatus({ canUndo: result.canUndo, canRedo: result.canRedo })
      await retry()
      if (onCatalogChanged) {
        await onCatalogChanged()
      }
    } catch (err) {
      console.error("Undo failed:", err)
    }
  }, [historyStatus.canUndo, isDatabaseLocked, databaseId, retry, onCatalogChanged])

  const handleRedo = React.useCallback(async () => {
    if (!historyStatus.canRedo || isDatabaseLocked) return
    try {
      const result = await redoDatabaseMutation(databaseId)
      setHistoryStatus({ canUndo: result.canUndo, canRedo: result.canRedo })
      await retry()
      if (onCatalogChanged) {
        await onCatalogChanged()
      }
    } catch (err) {
      console.error("Redo failed:", err)
    }
  }, [historyStatus.canRedo, isDatabaseLocked, databaseId, retry, onCatalogChanged])

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return
      }

      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0
      const modifier = isMac ? e.metaKey : e.ctrlKey

      if (modifier && !e.altKey) {
        if (e.key === "z" || e.key === "Z" || e.key === "я" || e.key === "Я") {
          if (e.shiftKey) {
            e.preventDefault()
            void handleRedo()
          } else {
            e.preventDefault()
            void handleUndo()
          }
        } else if (!isMac && (e.key === "y" || e.key === "Y")) {
          e.preventDefault()
          void handleRedo()
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleUndo, handleRedo])

  React.useEffect(() => setDatabaseTitle(title), [title])
  React.useEffect(() => setDatabaseIcon(normalizeDatabaseIcon(icon) ?? ""), [icon])
  // Search is session state; saved filters and sorts belong to the view, not the host.
  React.useEffect(() => {
    setSearchQuery("")
    setSearchOpen(false)
  }, [databaseId])

  // Search and sorting are backend query inputs. Never filter or reorder only
  // the currently loaded page: doing so makes page counts and distant rows
  // incorrect on large databases.
  // The one exception is the order the user placed rows in by hand: it is applied here as well,
  // so a drop shows at once and the backend returns the same sequence for the next query.
  const displayRows = React.useMemo(() => {
    const loaded = activeHost?.rows ?? EMPTY_ROWS
    return queryManualOrder ? applyManualOrder(loaded, queryManualOrder) : loaded
  }, [activeHost?.rows, queryManualOrder])

  const relationReferences = useRecordReferences(
    React.useMemo(() => relationTargetIds(displayRows.map((row) => row.valuesJson)), [displayRows]),
  )
  const relationTitles = React.useMemo(
    () => referenceTitles(relationReferences),
    [relationReferences],
  )

  const persistDatabaseTitle = React.useCallback(
    async (next: string) => {
      if (vaultGeneration === null || !database?.manifestRevision || isDatabaseLocked) {
        onRenameTitle?.(next)
        return
      }
      try {
        const renamed = await renameDatabase({
          expectedGeneration: vaultGeneration,
          databaseId,
          expectedManifestRevision: database.manifestRevision,
          name: next,
        })
        onRenameTitle?.(renamed.title)
        const refreshResults = await Promise.allSettled([onCatalogChanged?.(), retry()])
        const refreshFailure = refreshResults.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        )
        const notices = [...renamed.warnings]
        if (refreshFailure) {
          notices.push(
            refreshFailure.reason instanceof Error
              ? refreshFailure.reason.message
              : String(refreshFailure.reason),
          )
        }
        setMutationError(notices.length ? notices.join("; ") : null)
      } catch (error) {
        setMutationError(error instanceof Error ? error.message : String(error))
        setDatabaseTitle(title)
      }
    },
    [
      database,
      databaseId,
      isDatabaseLocked,
      onCatalogChanged,
      onRenameTitle,
      retry,
      title,
      vaultGeneration,
    ],
  )

  const commitDatabaseTitle = () => {
    const next = databaseTitle.trim()
    if (next && next !== title) void persistDatabaseTitle(next)
    setEditingDatabaseTitle(false)
  }

  const openCreateViewDialog = React.useCallback(() => {
    setViewName(t("databaseLayouts.table"))
    setViewLayout("table")
    setMutationError(null)
    setViewDialogOpen(true)
  }, [t])

  const refreshDatabaseViews = React.useCallback(
    async (viewIdToSelect?: string) => {
      const refreshResults = await Promise.allSettled([onCatalogChanged?.(), retry()])
      const refreshFailure = refreshResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      )
      if (refreshFailure) {
        setMutationError(
          refreshFailure.reason instanceof Error
            ? refreshFailure.reason.message
            : String(refreshFailure.reason),
        )
      }
      if (viewIdToSelect) setSelectedViewId(viewIdToSelect)
    },
    [onCatalogChanged, retry, setSelectedViewId],
  )

  // The order of the view tabs while one is dragged; it follows the catalog otherwise.
  const [viewOrder, setViewOrder] = React.useState<string[]>([])
  const catalogViews = database?.views
  React.useEffect(() => {
    setViewOrder(catalogViews?.map((view) => view.viewId) ?? [])
  }, [catalogViews])
  const tabViews = React.useMemo(() => {
    const views = catalogViews ?? []
    const ordered = viewOrder
      .map((id) => views.find((view) => view.viewId === id))
      .filter((view): view is NonNullable<typeof view> => Boolean(view))
    // A view the order does not know yet (just created) goes last.
    return [...ordered, ...views.filter((view) => !viewOrder.includes(view.viewId))]
  }, [catalogViews, viewOrder])
  const viewOrderRef = React.useRef(tabViews)
  viewOrderRef.current = tabViews
  const persistViewOrder = React.useCallback(async () => {
    const currentGeneration = vaultGeneration ?? useDatabaseStore.getState().vaultGeneration
    const ids = viewOrderRef.current.map((view) => view.viewId)
    if (
      currentGeneration === null ||
      !database?.manifestRevision ||
      ids.join() === (database.views ?? []).map((view) => view.viewId).join()
    ) {
      return
    }
    setMutationError(null)
    try {
      await reorderDatabaseViews({
        expectedGeneration: currentGeneration,
        databaseId: database.databaseId,
        expectedManifestRevision: database.manifestRevision,
        viewIds: ids,
      })
      logger.info("database.reorder_views", { databaseId, viewCount: ids.length })
      await refreshDatabaseViews()
    } catch (error) {
      logger.error("database.view_action_failed", { databaseId, viewDialogMode: "reorder", error })
      setMutationError(error instanceof Error ? error.message : String(error))
      // Put the tabs back in the saved order.
      setViewOrder(database.views.map((view) => view.viewId))
    }
  }, [database, databaseId, refreshDatabaseViews, vaultGeneration])

  const changeActiveViewLayout = React.useCallback(
    async (newLayout: "table" | "board" | "list" | "gallery" | "chart") => {
      const targetDatabaseId = database?.databaseId ?? databaseId
      const currentGeneration = vaultGeneration ?? useDatabaseStore.getState().vaultGeneration
      if (
        currentGeneration === null ||
        !database?.manifestRevision ||
        isDatabaseLocked ||
        mutationBusy ||
        !activeView ||
        activeView.layout === newLayout
      )
        return
      setMutationBusy(true)
      setMutationError(null)
      try {
        const doc = await getDatabaseView({
          expectedGeneration: currentGeneration,
          databaseId: targetDatabaseId,
          viewId: activeView.viewId,
          expectedViewRevision: activeView.revision,
        })
        const config = JSON.parse(doc.configJson)
        config.layout = newLayout
        await updateDatabaseViewConfig({
          expectedGeneration: currentGeneration,
          databaseId: targetDatabaseId,
          viewId: activeView.viewId,
          expectedViewRevision: doc.revision,
          configJson: JSON.stringify(config),
        })
        await refreshDatabaseViews(activeView.viewId)
      } catch (error) {
        setMutationError(error instanceof Error ? error.message : String(error))
      } finally {
        setMutationBusy(false)
      }
    },
    [
      activeView,
      database?.databaseId,
      database?.manifestRevision,
      databaseId,
      isDatabaseLocked,
      mutationBusy,
      refreshDatabaseViews,
      vaultGeneration,
    ],
  )

  const copyLinkToView = React.useCallback(async () => {
    if (!activeView) return
    const link = `amby://database/${databaseId}?view=${activeView.viewId}`
    try {
      await navigator.clipboard.writeText(link)
      setIsLinkCopied(true)
      setTimeout(() => setIsLinkCopied(false), 2000)
    } catch {
      // Ignore
    }
  }, [activeView, databaseId])

  // Renames the active view from the settings panel; a failure puts the old name back.
  const renameActiveView = React.useCallback(
    async (name: string) => {
      const next = name.trim()
      const view = database?.views.find((candidate) => candidate.viewId === activeView?.viewId)
      const currentGeneration = vaultGeneration ?? useDatabaseStore.getState().vaultGeneration
      if (!view || !next || next === view.title || currentGeneration === null || isDatabaseLocked) {
        return
      }
      setMutationError(null)
      try {
        await renameDatabaseView({
          expectedGeneration: currentGeneration,
          databaseId: database?.databaseId ?? databaseId,
          viewId: view.viewId,
          expectedViewRevision: view.revision,
          name: next,
        })
        logger.info("database.rename_view", { databaseId, viewId: view.viewId, name: next })
        await refreshDatabaseViews(view.viewId)
      } catch (error) {
        logger.error("database.view_action_failed", { databaseId, viewDialogMode: "rename", error })
        setMutationError(error instanceof Error ? error.message : String(error))
        throw error
      }
    },
    [
      activeView?.viewId,
      database?.databaseId,
      database?.views,
      databaseId,
      isDatabaseLocked,
      refreshDatabaseViews,
      vaultGeneration,
    ],
  )

  const saveViewDialog = React.useCallback(async () => {
    const targetDatabaseId = database?.databaseId ?? databaseId
    const currentGeneration = vaultGeneration ?? useDatabaseStore.getState().vaultGeneration
    if (
      currentGeneration === null ||
      !database?.manifestRevision ||
      isDatabaseLocked ||
      !viewName.trim() ||
      mutationBusy
    )
      return
    setMutationBusy(true)
    setMutationError(null)
    try {
      const created = await createDatabaseView({
        expectedGeneration: currentGeneration,
        databaseId: targetDatabaseId,
        expectedManifestRevision: database.manifestRevision,
        name: viewName.trim(),
        layout: viewLayout,
      })
      logger.info("database.create_view", {
        databaseId: targetDatabaseId,
        viewId: created.viewId,
        name: viewName.trim(),
        layout: viewLayout,
      })
      setViewDialogOpen(false)
      await refreshDatabaseViews(created.viewId)
    } catch (error) {
      logger.error("database.view_action_failed", {
        databaseId: targetDatabaseId,
        viewDialogMode: "create",
        error,
      })
      setMutationError(error instanceof Error ? error.message : String(error))
    } finally {
      setMutationBusy(false)
    }
  }, [
    database?.databaseId,
    database?.manifestRevision,
    databaseId,
    isDatabaseLocked,
    mutationBusy,
    refreshDatabaseViews,
    vaultGeneration,
    viewLayout,
    viewName,
  ])

  const mutateView = React.useCallback(
    async (action: "duplicate" | "delete" | "default", targetViewId: string) => {
      const targetDatabaseId = database?.databaseId ?? databaseId
      const currentGeneration = vaultGeneration ?? useDatabaseStore.getState().vaultGeneration
      if (
        currentGeneration === null ||
        !database?.manifestRevision ||
        isDatabaseLocked ||
        mutationBusy
      )
        return
      const target = database.views.find((view) => view.viewId === targetViewId)
      if (!target) return
      if (action === "delete" && !globalThis.confirm(t("databaseWorkspace.confirmDeleteView")))
        return
      setMutationBusy(true)
      setMutationError(null)
      try {
        if (action === "duplicate") {
          const duplicate = await duplicateDatabaseView({
            expectedGeneration: currentGeneration,
            databaseId: targetDatabaseId,
            viewId: target.viewId,
            expectedViewRevision: target.revision,
            expectedManifestRevision: database.manifestRevision,
          })
          logger.info("database.duplicate_view", {
            databaseId: targetDatabaseId,
            viewId: target.viewId,
            newViewId: duplicate.viewId,
          })
          await refreshDatabaseViews(duplicate.viewId)
        } else if (action === "default") {
          await setDefaultDatabaseView({
            expectedGeneration: currentGeneration,
            databaseId: targetDatabaseId,
            viewId: target.viewId,
            expectedViewRevision: target.revision,
            expectedManifestRevision: database.manifestRevision,
          })
          logger.info("database.set_default_view", {
            databaseId: targetDatabaseId,
            viewId: target.viewId,
          })
          await refreshDatabaseViews(target.viewId)
        } else {
          await deleteDatabaseView({
            expectedGeneration: currentGeneration,
            databaseId: targetDatabaseId,
            viewId: target.viewId,
            expectedViewRevision: target.revision,
            expectedManifestRevision: database.manifestRevision,
          })
          logger.info("database.delete_view", {
            databaseId: targetDatabaseId,
            viewId: target.viewId,
          })
          const fallback = database.views.find((view) => view.viewId !== target.viewId)?.viewId
          await refreshDatabaseViews(fallback)
        }
      } catch (error) {
        logger.error("database.mutate_view_failed", {
          databaseId: targetDatabaseId,
          action,
          targetViewId,
          error,
        })
        setMutationError(error instanceof Error ? error.message : String(error))
      } finally {
        setMutationBusy(false)
      }
    },
    [
      database,
      databaseId,
      isDatabaseLocked,
      mutationBusy,
      refreshDatabaseViews,
      t,
      vaultGeneration,
    ],
  )

  const openRowDialog = React.useCallback((template: DatabaseRowTemplate) => {
    setRowTemplate(template)
    setRowLaneKey(null)
    setRowTitle("")
    setMutationError(null)
    setRowDialogOpen(true)
  }, [])

  const openRowDialogInLane = React.useCallback(
    (laneKey: string) => {
      openRowDialog({ kind: "empty" })
      setRowLaneKey(laneKey)
    },
    [openRowDialog],
  )

  const displayedDatabaseIcon =
    normalizeDatabaseIcon(databaseIcon) ?? normalizeDatabaseIcon(database?.icon)

  const openRow = React.useCallback(
    (row: DatabaseRow) => {
      if (viewSettings.openMode === "fullPage" && onOpenRowFullPage) {
        onOpenRowFullPage(row)
        return
      }
      // The record takes the room of the settings panel.
      setSettingsOpen(false)
      setSelectedRowSnapshot(row)
      setSelectedRowId(row.noteId)
    },
    [onOpenRowFullPage, viewSettings.openMode],
  )
  // The view's own menu (Rename, Configure) opens the settings panel on that view; Rename also
  // puts the cursor in the view's name.
  const openViewSettings = React.useCallback(
    (targetViewId: string, focusName: boolean) => {
      setSelectedViewId(targetViewId)
      setSelectedRowId(null)
      setSettingsOpen(true)
      if (focusName) setSettingsFocusSignal((signal) => signal + 1)
    },
    [setSelectedViewId],
  )
  const toggleSettings = React.useCallback(() => {
    setSettingsOpen((open) => {
      if (!open) setSelectedRowId(null)
      return !open
    })
  }, [])
  const selectedRow =
    displayRows.find((row) => row.noteId === selectedRowId) ??
    (selectedRowSnapshot?.noteId === selectedRowId ? selectedRowSnapshot : null)
  const selectedRowIndex = selectedRow ? displayRows.indexOf(selectedRow) : -1
  const selectAdjacentRow = (offset: number) => {
    if (selectedRowIndex < 0) return
    const next = displayRows[selectedRowIndex + offset]
    if (next) setSelectedRowId(next.noteId)
  }

  const createRow = React.useCallback(async () => {
    if (vaultGeneration === null || !rowTitle.trim() || mutationBusy) return
    setMutationBusy(true)
    setMutationError(null)
    try {
      const created = await createDatabaseRow({
        expectedGeneration: vaultGeneration,
        databaseId,
        title: rowTitle.trim(),
        template: rowTemplate,
      })
      logger.info("database.create_row", {
        databaseId,
        noteId: created.noteId,
        title: rowTitle.trim(),
        template: rowTemplate.kind,
      })
      // A page added from a board lane belongs to that lane.
      if (rowLaneKey && groupField?.kind === "property") {
        const groupProperty = database?.properties.find(
          (candidate) => candidate.propertyId === groupField.propertyId,
        )
        if (groupProperty) {
          await placeNewRecordInLane({
            vaultGeneration,
            databaseId,
            created,
            groupProperty,
            laneKey: rowLaneKey,
          })
        }
      }
      setSelectedRowId(created.noteId)
      setRowTitle("")
      setRowDialogOpen(false)
      const refreshResults = await Promise.allSettled([onRowCreated?.(created), retry()])
      const refreshFailure = refreshResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      )
      const notices = [...created.warnings]
      if (refreshFailure) {
        notices.push(
          refreshFailure.reason instanceof Error
            ? refreshFailure.reason.message
            : String(refreshFailure.reason),
        )
      }
      setMutationError(notices.length ? notices.join("; ") : null)
    } catch (error) {
      logger.error("database.create_row_failed", { databaseId, title: rowTitle.trim(), error })
      setMutationError(error instanceof Error ? error.message : String(error))
    } finally {
      setMutationBusy(false)
    }
  }, [
    database?.properties,
    databaseId,
    groupField,
    mutationBusy,
    onRowCreated,
    retry,
    rowLaneKey,
    rowTemplate,
    rowTitle,
    vaultGeneration,
  ])

  const createProperty = React.useCallback(async () => {
    const currentGeneration = vaultGeneration ?? useDatabaseStore.getState().vaultGeneration
    if (
      currentGeneration === null ||
      !database?.manifestRevision ||
      !propertyName.trim() ||
      mutationBusy
    )
      return
    const isSelfRelation = relationTargetDatabaseId === databaseId
    const twoWay = isSelfRelation ? relationSelfDual : relationTwoWay
    const isTwoWayRelation = propertyType === "relation" && twoWay
    const operationId = isTwoWayRelation
      ? createDatabaseOperationId("schema", `${databaseId}-${propertyName.trim()}`)
      : undefined
    setMutationBusy(true)
    setMutationError(null)
    try {
      const expectedTargetManifestRevision =
        isTwoWayRelation && !isSelfRelation
          ? (await listDatabases()).find(
              (candidate) => candidate.databaseId === relationTargetDatabaseId,
            )?.manifestRevision
          : undefined
      const created = await createDatabaseProperty({
        expectedGeneration: currentGeneration,
        databaseId,
        expectedManifestRevision: database.manifestRevision,
        operationId,
        expectedTargetManifestRevision,
        name: propertyName.trim(),
        propertyType,
        formulaExpression: propertyType === "formula" ? formulaExpression : undefined,
        rollupRelationPropertyId: propertyType === "rollup" ? rollupDraft.relationId : undefined,
        rollupTargetPropertyId: propertyType === "rollup" ? rollupDraft.targetId : undefined,
        rollupAggregation: propertyType === "rollup" ? rollupDraft.aggregation : undefined,
        options:
          propertyType === "relation"
            ? [relationTargetDatabaseId]
            : propertyType === "status"
              ? defaultStatusOptionNames(t)
              : undefined,
        relationTargetDatabaseId:
          propertyType === "relation" ? relationTargetDatabaseId : undefined,
        relationMaxItems: propertyType === "relation" ? relationMaxItems : undefined,
        relationTwoWay: propertyType === "relation" ? twoWay : undefined,
        relationInversePropertyName:
          propertyType === "relation" && twoWay
            ? relationInversePropertyName.trim() || title
            : undefined,
        beforePropertyId: propertyInsertBeforeId,
      })
      logger.info("database.create_property", {
        databaseId,
        propertyId: created.propertyId,
        propertyName: propertyName.trim(),
        propertyType,
      })
      setPropertyName("")
      setPropertyType("text")
      setFormulaExpression("0")
      setRollupDraft(EMPTY_ROLLUP_DRAFT)
      setRelationTargetDatabaseId(databaseId)
      setRelationMaxItems(null)
      setRelationTwoWay(false)
      setRelationInversePropertyName("")
      setRelationSelfDual(true)
      setPropertyDialogOpen(false)
      setPropertyInsertBeforeId(undefined)
      const refreshResults = await Promise.allSettled([onCatalogChanged?.(), retry()])
      const refreshFailure = refreshResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      )
      const notices = [...created.warnings]
      if (refreshFailure) {
        notices.push(
          refreshFailure.reason instanceof Error
            ? refreshFailure.reason.message
            : String(refreshFailure.reason),
        )
      }
      setMutationError(notices.length ? notices.join("; ") : null)
    } catch (error) {
      logger.error("database.create_property_failed", {
        databaseId,
        propertyName: propertyName.trim(),
        propertyType,
        error,
      })
      setMutationError(error instanceof Error ? error.message : String(error))
    } finally {
      setMutationBusy(false)
    }
  }, [
    rollupDraft.aggregation,
    rollupDraft.relationId,
    rollupDraft.targetId,
    database?.manifestRevision,
    databaseId,
    formulaExpression,
    mutationBusy,
    onCatalogChanged,
    propertyInsertBeforeId,
    propertyName,
    propertyType,
    relationInversePropertyName,
    relationMaxItems,
    relationSelfDual,
    relationTargetDatabaseId,
    relationTwoWay,
    retry,
    t,
    title,
    vaultGeneration,
  ])

  const deleteProperty = React.useCallback(
    async (propertyId: string) => {
      if (vaultGeneration === null || !database?.manifestRevision || isDatabaseLocked) return
      setMutationBusy(true)
      setMutationError(null)
      try {
        const deleted = await deleteDatabaseProperty({
          expectedGeneration: vaultGeneration,
          databaseId,
          propertyId,
          expectedManifestRevision: database.manifestRevision,
        })
        logger.info("database.delete_property", { databaseId, propertyId })
        const refreshResults = await Promise.allSettled([onCatalogChanged?.(), retry()])
        const refreshFailure = refreshResults.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        )
        const notices = [...deleted.warnings]
        if (refreshFailure) {
          notices.push(
            refreshFailure.reason instanceof Error
              ? refreshFailure.reason.message
              : String(refreshFailure.reason),
          )
        }
        setMutationError(notices.length ? notices.join("; ") : null)
      } catch (error) {
        logger.error("database.delete_property_failed", { databaseId, propertyId, error })
        setMutationError(error instanceof Error ? error.message : String(error))
      } finally {
        setMutationBusy(false)
      }
    },
    [
      database?.manifestRevision,
      databaseId,
      isDatabaseLocked,
      onCatalogChanged,
      retry,
      vaultGeneration,
    ],
  )

  const persistPropertyName = React.useCallback(
    async (propertyId: string, nextName: string) => {
      const property = database?.properties.find((candidate) => candidate.propertyId === propertyId)
      const name = nextName.trim()
      if (
        vaultGeneration === null ||
        !database?.manifestRevision ||
        isDatabaseLocked ||
        !property ||
        !name ||
        name === property.name
      )
        return
      setMutationError(null)
      try {
        const renamed = await renameDatabaseProperty({
          expectedGeneration: vaultGeneration,
          databaseId,
          propertyId,
          expectedManifestRevision: database.manifestRevision,
          name,
        })
        logger.info("database.rename_property", {
          databaseId,
          propertyId,
          oldName: property.name,
          newName: name,
        })
        const refreshResults = await Promise.allSettled([onCatalogChanged?.(), retry()])
        const refreshFailure = refreshResults.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        )
        const notices = [...renamed.warnings]
        if (refreshFailure) {
          notices.push(
            refreshFailure.reason instanceof Error
              ? refreshFailure.reason.message
              : String(refreshFailure.reason),
          )
        }
        setMutationError(notices.length ? notices.join("; ") : null)
      } catch (error) {
        logger.error("database.rename_property_failed", {
          databaseId,
          propertyId,
          newName: name,
          error,
        })
        setMutationError(error instanceof Error ? error.message : String(error))
      }
    },
    [database, databaseId, isDatabaseLocked, onCatalogChanged, retry, vaultGeneration],
  )

  // Schema edits made in a row (an option renamed, then recolored) go one after another, each
  // on the manifest the previous one wrote, so none of them meets a stale revision.
  const manifestRevisionRef = React.useRef<string | null>(null)
  const lastSeenRevisionRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    const revision = database?.manifestRevision ?? null
    if (revision === lastSeenRevisionRef.current) return
    lastSeenRevisionRef.current = revision
    manifestRevisionRef.current = revision
  }, [database?.manifestRevision])
  const schemaQueueRef = React.useRef<Promise<unknown>>(Promise.resolve())
  const enqueueSchema = React.useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = schemaQueueRef.current.then(task)
    schemaQueueRef.current = run.catch(() => undefined)
    return run
  }, [])
  const refreshAfterSchemaEdit = React.useCallback(
    async (warnings: string[]) => {
      const refreshResults = await Promise.allSettled([onCatalogChanged?.(), retry()])
      const refreshFailure = refreshResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      )
      const notices = [...warnings]
      if (refreshFailure) {
        notices.push(
          refreshFailure.reason instanceof Error
            ? refreshFailure.reason.message
            : String(refreshFailure.reason),
        )
      }
      setMutationError(notices.length ? notices.join("; ") : null)
    },
    [onCatalogChanged, retry],
  )

  const saveOptionDrafts = React.useCallback(
    (propertyId: string, drafts: OptionDraft[]) =>
      enqueueSchema(async () => {
        const property = database?.properties.find(
          (candidate) => candidate.propertyId === propertyId,
        )
        const revision = manifestRevisionRef.current
        if (vaultGeneration === null || !revision || isDatabaseLocked || !property) {
          throw new Error(t("databaseOptions.unavailable"))
        }
        try {
          const updated = await updateDatabasePropertyOptions({
            expectedGeneration: vaultGeneration,
            databaseId,
            propertyId,
            expectedManifestRevision: revision,
            options: draftsToInputs(drafts, property.propertyType === "status"),
          })
          manifestRevisionRef.current = updated.manifestRevision
          logger.info("database.update_property_options", {
            databaseId,
            propertyId,
            optionCount: updated.options.length,
          })
          await refreshAfterSchemaEdit(updated.warnings)
          return updated.options
        } catch (error) {
          logger.error("database.update_property_options_failed", { databaseId, propertyId, error })
          throw error
        }
      }),
    [
      database?.properties,
      databaseId,
      enqueueSchema,
      isDatabaseLocked,
      refreshAfterSchemaEdit,
      t,
      vaultGeneration,
    ],
  )

  const updatePropertyConfig = React.useCallback(
    (propertyId: string, patch: PropertyConfigPatch) =>
      enqueueSchema(async () => {
        const revision = manifestRevisionRef.current
        if (vaultGeneration === null || !revision || isDatabaseLocked) {
          throw new Error(t("databaseOptions.unavailable"))
        }
        try {
          const updated = await updateDatabasePropertyConfig({
            ...patch,
            expectedGeneration: vaultGeneration,
            databaseId,
            propertyId,
            expectedManifestRevision: revision,
          })
          manifestRevisionRef.current = updated.manifestRevision
          logger.info("database.update_property_config", { databaseId, propertyId })
          await refreshAfterSchemaEdit(updated.warnings)
        } catch (error) {
          logger.error("database.update_property_config_failed", {
            databaseId,
            propertyId,
            error,
          })
          throw error
        }
      }).catch((error) => {
        throw new Error(databaseErrorText(error, t, "date"))
      }),
    [databaseId, enqueueSchema, isDatabaseLocked, refreshAfterSchemaEdit, t, vaultGeneration],
  )

  const optionActions = React.useMemo<OptionActions | null>(() => {
    if (isDatabaseLocked || vaultGeneration === null) return null
    return {
      saveOptions: async (propertyId, drafts) => {
        await saveOptionDrafts(propertyId, drafts)
      },
      createOption: async (propertyId, name) => {
        const property = database?.properties.find(
          (candidate) => candidate.propertyId === propertyId,
        )
        const trimmed = name.trim()
        if (!property || !trimmed) return null
        const existing = property.options.find(
          (option) => option.name.trim().toLowerCase() === trimmed.toLowerCase(),
        )
        if (existing) return existing.optionId
        const drafts = draftsFromProperty(property)
        try {
          const saved = await saveOptionDrafts(propertyId, [
            ...drafts,
            {
              key: "new",
              id: null,
              name: trimmed,
              color: nextOptionColor(drafts),
              group: "notStarted",
              isDefault: false,
            },
          ])
          return saved[saved.length - 1]?.id ?? null
        } catch (error) {
          setMutationError(error instanceof Error ? error.message : String(error))
          return null
        }
      },
      setOptionColor: async (propertyId, optionId, hex) => {
        const property = database?.properties.find(
          (candidate) => candidate.propertyId === propertyId,
        )
        if (!property) return
        const drafts = draftsFromProperty(property)
        if (!drafts.some((draft) => draft.id === optionId && draft.color.toLowerCase() !== hex)) {
          return
        }
        try {
          await saveOptionDrafts(
            propertyId,
            drafts.map((draft) => (draft.id === optionId ? { ...draft, color: hex } : draft)),
          )
        } catch (error) {
          setMutationError(error instanceof Error ? error.message : String(error))
        }
      },
    }
  }, [database?.properties, isDatabaseLocked, saveOptionDrafts, vaultGeneration])

  const persistPropertyType = React.useCallback(
    async (propertyId: string, nextPropertyType: string, nextRelationTargetDatabaseId?: string) => {
      const property = database?.properties.find((candidate) => candidate.propertyId === propertyId)
      if (
        vaultGeneration === null ||
        !database?.manifestRevision ||
        isDatabaseLocked ||
        !property ||
        (nextPropertyType === property.propertyType && !nextRelationTargetDatabaseId)
      )
        return
      setMutationError(null)
      try {
        const currentRelationTargetDatabaseId =
          property.propertyType === "relation"
            ? relationTargetFromConfig(property.configJson, true)
            : undefined
        const relationOperation =
          property.propertyType === "relation" || nextPropertyType === "relation"
        const targetDatabaseId =
          nextPropertyType === "relation" ? nextRelationTargetDatabaseId || databaseId : undefined
        const operationId = relationOperation
          ? createDatabaseOperationId("schema", `${databaseId}-${propertyId}`)
          : undefined
        const relatedManifestRevisions = relationOperation
          ? await expectedRelatedManifestRevisions(
              databaseId,
              t("databaseWorkspace.notFound"),
              currentRelationTargetDatabaseId,
              targetDatabaseId,
            )
          : []
        const changed = await changeDatabasePropertyType({
          expectedGeneration: vaultGeneration,
          databaseId,
          propertyId,
          expectedManifestRevision: database.manifestRevision,
          propertyType: nextPropertyType,
          operationId,
          expectedRelatedManifestRevisions: relatedManifestRevisions,
          relationTargetDatabaseId: targetDatabaseId,
        })
        logger.info("database.change_property_type", {
          databaseId,
          propertyId,
          oldType: property.propertyType,
          newType: nextPropertyType,
          operationId,
        })
        const refreshResults = await Promise.allSettled([onCatalogChanged?.(), retry()])
        const refreshFailure = refreshResults.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        )
        const notices = [...changed.warnings]
        if (refreshFailure) {
          notices.push(
            refreshFailure.reason instanceof Error
              ? refreshFailure.reason.message
              : String(refreshFailure.reason),
          )
        }
        setMutationError(notices.length ? notices.join("; ") : null)
      } catch (error) {
        logger.error("database.change_property_type_failed", {
          databaseId,
          propertyId,
          newType: nextPropertyType,
          error,
        })
        setMutationError(
          databaseErrorText(
            error,
            t,
            property.propertyType === "relation" || nextPropertyType === "relation"
              ? "relation"
              : "type",
          ),
        )
      }
    },
    [database, databaseId, isDatabaseLocked, onCatalogChanged, retry, t, vaultGeneration],
  )

  const {
    commit: commitCell,
    pendingCells,
    cellErrors,
  } = usePropertyMutation({
    databaseId,
    vaultGeneration,
    onSettled: async (outcome) => {
      if (outcome.ok && outcome.result?.warnings.length) {
        setMutationError(outcome.result.warnings.join("; "))
      }
      await retry()
      if (outcome.ok) useDatabaseStore.getState().invalidateHosts()
      if (outcome.ok) void refreshHistoryStatus()
    },
  })

  const handleCreateRelationRow = React.useCallback(
    async (targetDatabaseId: string, rowTitleText: string): Promise<string | void> => {
      if (vaultGeneration === null || !rowTitleText.trim() || mutationBusy) return
      setMutationBusy(true)
      setMutationError(null)
      try {
        const createdNoteId = await createRelationTargetRow(
          vaultGeneration,
          targetDatabaseId,
          rowTitleText,
        )
        await Promise.allSettled([onCatalogChanged?.(), retry()])
        return createdNoteId
      } catch (error) {
        logger.error("database.create_relation_row_failed", {
          targetDatabaseId,
          title: rowTitleText.trim(),
          error,
        })
        setMutationError(error instanceof Error ? error.message : String(error))
      } finally {
        setMutationBusy(false)
      }
    },
    [mutationBusy, onCatalogChanged, retry, vaultGeneration],
  )

  // Saves the relation settings of a property. A relation also touches the database it points to
  // (the reverse property), so it goes through the same checked schema change as a type change.
  const saveRelationConfig = React.useCallback(
    (property: DatabasePropertySummary, config: RelationConfigState) =>
      enqueueSchema(async () => {
        const revision = manifestRevisionRef.current
        if (vaultGeneration === null || !revision || isDatabaseLocked) {
          throw new Error(t("databaseOptions.unavailable"))
        }
        const operationId = createDatabaseOperationId(
          "schema",
          `${databaseId}-${property.propertyId}`,
        )
        const relatedManifestRevisions = await expectedRelatedManifestRevisions(
          databaseId,
          t("databaseWorkspace.notFound"),
          relationTargetFromConfig(property.configJson, true),
          config.targetDatabaseId,
        )
        const changed = await changeDatabasePropertyType({
          expectedGeneration: vaultGeneration,
          databaseId,
          propertyId: property.propertyId,
          expectedManifestRevision: revision,
          propertyType: "relation",
          operationId,
          expectedRelatedManifestRevisions: relatedManifestRevisions,
          relationTargetDatabaseId: config.targetDatabaseId,
          // `null` means "keep the current value" at the Rust boundary;
          // zero is the explicit request to remove a one-page limit.
          relationMaxItems: config.maxItems ?? 0,
          relationTwoWay: config.twoWay,
          relationInversePropertyName: config.inversePropertyName,
        })
        manifestRevisionRef.current = changed.manifestRevision
        await refreshAfterSchemaEdit(changed.warnings)
      }).catch((error) => {
        throw new Error(databaseErrorText(error, t, "relation"))
      }),
    [databaseId, enqueueSchema, isDatabaseLocked, refreshAfterSchemaEdit, t, vaultGeneration],
  )
  const saveRollupConfig = React.useCallback(
    (property: DatabasePropertySummary, draft: RollupDraft) =>
      enqueueSchema(async () => {
        const revision = manifestRevisionRef.current
        if (vaultGeneration === null || !revision || isDatabaseLocked) {
          throw new Error(t("databaseOptions.unavailable"))
        }
        const configured = await configureDatabaseRollup({
          expectedGeneration: vaultGeneration,
          databaseId,
          propertyId: property.propertyId,
          expectedManifestRevision: revision,
          relationPropertyId: draft.relationId,
          targetPropertyId: draft.targetId,
          aggregation: draft.aggregation,
        })
        manifestRevisionRef.current = configured.manifestRevision
        await refreshAfterSchemaEdit([])
      }),
    [databaseId, enqueueSchema, isDatabaseLocked, refreshAfterSchemaEdit, t, vaultGeneration],
  )
  // The settings of a property (options, formats, expression, relation, rollup), the same wherever
  // its menu opens.
  const renderPropertySettings = React.useCallback(
    (property: DatabasePropertySummary) =>
      hasPropertySettings(property.propertyType) ? (
        <PropertyConfigEditor
          property={property}
          disabled={isDatabaseLocked || vaultGeneration === null}
          database={database ?? undefined}
          databases={databases}
          databaseTitle={title}
          onUpdateConfig={updatePropertyConfig}
          onSaveOptions={saveOptionDrafts}
          onSaveRelation={saveRelationConfig}
          onSaveRollup={saveRollupConfig}
        />
      ) : null,
    [
      database,
      databases,
      isDatabaseLocked,
      saveOptionDrafts,
      saveRelationConfig,
      saveRollupConfig,
      title,
      updatePropertyConfig,
      vaultGeneration,
    ],
  )

  const cardEdit = React.useMemo<CardCellEdit | undefined>(
    () =>
      isDatabaseLocked
        ? undefined
        : {
            onCommit: commitCell,
            pendingCells,
            cellErrors,
            onOpenNote: handleOpenNote,
            onRename: onRenameRow
              ? async (row, name) => {
                  await onRenameRow(row.noteId, name)
                  retry()
                }
              : undefined,
          },
    [cellErrors, commitCell, handleOpenNote, isDatabaseLocked, onRenameRow, pendingCells, retry],
  )
  const commitPeekCell = React.useCallback(
    async (row: DatabaseRow, property: DatabasePropertySummary, valueJson?: string) => {
      await commitCell(row, property, valueJson)
      // A card opened from a board lane may not be in the loaded page: keep its copy current.
      setSelectedRowSnapshot((current) =>
        current?.noteId === row.noteId
          ? {
              ...current,
              valuesJson: applyCellValue(current.valuesJson, property.propertyId, valueJson),
            }
          : current,
      )
    },
    [commitCell],
  )

  // The grip of a row: drag to place it by hand (while no sort decides the order), press for its menu.
  const renderRowProperties = React.useCallback(
    (row: DatabaseRow) => (
      <PeekProperties
        row={row}
        properties={database?.properties ?? EMPTY_PROPERTIES}
        databases={databases}
        currentDatabaseId={databaseId}
        pendingCells={pendingCells}
        cellErrors={cellErrors}
        disabled={isDatabaseLocked}
        onCommit={commitPeekCell}
        onOpenNote={handleOpenNote}
        onCreateRelationRow={handleCreateRelationRow}
      />
    ),
    [
      cellErrors,
      commitPeekCell,
      database?.properties,
      databaseId,
      databases,
      handleCreateRelationRow,
      handleOpenNote,
      isDatabaseLocked,
      pendingCells,
    ],
  )
  const rowMenu = useRowMenu({
    databaseId,
    databases,
    openMode: viewSettings.openMode,
    locked: isDatabaseLocked,
    vaultGeneration,
    actions: rowActions,
    openRow,
    onRenameRow,
    refresh: retry,
    onError: setMutationError,
    renderProperties: renderRowProperties,
  })
  const deleteRows = useDeleteRows({
    actions: rowActions,
    locked: isDatabaseLocked,
    refresh: retry,
  })
  const [sortPromptOpen, setSortPromptOpen] = React.useState(false)
  const sorted = viewSettings.sorts.length > 0
  const rowReorder = useRowReorderConfig({
    rows: displayRows,
    manualOrder: viewSettings.manualOrder,
    enabled: !isDatabaseLocked && !sorted,
    onChange: (manualOrder) => updateViewSettings({ manualOrder }),
    // Dragging while a sort decides the order offers to drop the sort for a custom order.
    onBlockedDrag: !isDatabaseLocked && sorted ? () => setSortPromptOpen(true) : undefined,
  })

  const syncYamlForRow = React.useCallback(
    async (row: DatabaseRow) => {
      if (vaultGeneration === null) return
      setYamlSyncState({ rowId: row.noteId, busy: true, error: null, result: null })
      try {
        const result = await syncDatabaseYaml({
          expectedGeneration: vaultGeneration,
          databaseId,
          noteId: row.noteId,
          expectedRecordRevision: row.rowRevision,
        })
        logger.info("database.sync_yaml", {
          databaseId,
          noteId: row.noteId,
          changed: result.changed,
        })
        setYamlSyncState({ rowId: row.noteId, busy: false, error: null, result })
        if (result.changed) retry()
      } catch (error) {
        setYamlSyncState({
          rowId: row.noteId,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
          result: null,
        })
      }
    },
    [databaseId, retry, vaultGeneration],
  )

  const resolveYamlForRow = React.useCallback(
    async (
      row: DatabaseRow,
      conflict: DatabaseYamlConflict,
      resolution: DatabaseYamlResolution,
      manualValueJson?: string,
    ) => {
      if (vaultGeneration === null) return
      setYamlSyncState((current) => ({
        rowId: row.noteId,
        busy: true,
        error: null,
        result: current?.rowId === row.noteId ? current.result : null,
      }))
      try {
        const result = await resolveDatabaseYamlConflict({
          expectedGeneration: vaultGeneration,
          databaseId,
          noteId: row.noteId,
          propertyId: conflict.propertyId,
          expectedNoteRevision: conflict.noteRevision,
          expectedRecordRevision: conflict.recordRevision,
          resolution,
          manualValueJson,
        })
        setYamlSyncState({ rowId: row.noteId, busy: false, error: null, result })
        if (result.changed) retry()
      } catch (error) {
        setYamlSyncState({
          rowId: row.noteId,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
          result: null,
        })
      }
    },
    [databaseId, retry, vaultGeneration],
  )

  const moveRowToGroup = React.useCallback(
    async (row: DatabaseRow, laneKey: string) => {
      if (!groupField || groupField.kind !== "property" || vaultGeneration === null) return
      const groupProperty = database?.properties.find(
        (candidate) => candidate.propertyId === groupField.propertyId,
      )
      if (
        !groupProperty ||
        (groupProperty.propertyType !== "select" && groupProperty.propertyType !== "status")
      ) {
        throw new Error(t("databaseBoard.unsupportedValue"))
      }
      // A card without a value (the "No value" lane) has no stored value to copy.
      const typed = { type: groupProperty.propertyType }
      await applyDatabaseValueBatch({
        expectedGeneration: vaultGeneration,
        databaseId,
        operationId: `board-${Date.now()}-${row.noteId}`,
        cells: [
          {
            noteId: row.noteId,
            propertyId: groupField.propertyId,
            valueJson:
              laneKey === "__empty__" ? undefined : JSON.stringify({ ...typed, optionId: laneKey }),
            expectedRevision: row.rowRevision,
          },
        ],
      })
      retry()
      // The other views (table, list, gallery) hold their own copy of the rows: they reload too.
      useDatabaseStore.getState().invalidateHosts()
      void refreshHistoryStatus()
    },
    [database?.properties, databaseId, groupField, refreshHistoryStatus, retry, t, vaultGeneration],
  )

  const chartCategory = React.useMemo(() => {
    const property = database?.properties.find(
      (candidate) => candidate.propertyType === "select" || candidate.propertyType === "status",
    )
    return property ? { kind: "property" as const, propertyId: property.propertyId } : undefined
  }, [database?.properties])

  if (catalogStatus === "ready" && !database) {
    return (
      <section className="relative flex min-h-0 min-w-0 w-full flex-1 flex-col items-center justify-center gap-3 overflow-hidden bg-[var(--note-surface)] p-8 text-center text-muted-foreground">
        <Database className="size-10 stroke-1 text-muted-foreground/60" />
        <p className="text-sm font-medium">{t("databaseWorkspace.notFound")}</p>
      </section>
    )
  }

  return (
    <OptionActionsProvider value={optionActions}>
      <section
        ref={sectionRef}
        className="relative flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden bg-[var(--note-surface)] text-foreground"
      >
        {/* Hidden measuring container to determine unconstrained width of all view tabs */}
        <div
          ref={viewsMeasureRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute -left-[9999px] top-0 flex items-center gap-1"
        >
          {database?.views.map((view) => {
            const viewDisplayMode = viewDisplayModes[`${databaseId}:${view.viewId}`] ?? "both"
            const showIcon = viewDisplayMode !== "text"
            const showText = viewDisplayMode !== "icon"
            return (
              <div
                key={view.viewId}
                className={cn(
                  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium",
                  viewDisplayMode === "icon" && "px-2.5",
                )}
              >
                {showIcon && (
                  <ViewIcon
                    databaseId={databaseId}
                    viewId={view.viewId}
                    layout={view.layout}
                    className="size-4 shrink-0"
                  />
                )}
                {showText && <span>{view.title}</span>}
              </div>
            )
          })}
        </div>
        <div
          // The left padding leaves room for the row grips that hang beside the table.
          className="mx-auto flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden pl-[4.5rem] pr-3 sm:pr-8 lg:pr-12"
          style={{ maxWidth: EDITOR_CONTENT_WIDTH[contentWidth] }}
        >
          {!hideHeader && (
            <header className="flex shrink-0 items-center gap-3 px-0 py-4">
              <div className="relative shrink-0">
                <motion.button
                  ref={iconTriggerRef}
                  type="button"
                  className="text-3xl leading-none focus:outline-none dark:text-foreground"
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.96 }}
                  transition={motionTransitions.default}
                  title={t("databaseWorkspace.changeIcon")}
                  aria-label={t("databaseWorkspace.changeIcon")}
                  onClick={() => setIconPickerOpen((open) => !open)}
                >
                  <IconValue
                    value={displayedDatabaseIcon}
                    fallback={<Database className="size-8" strokeWidth={1.7} />}
                    className="size-8 rounded-md"
                  />
                </motion.button>
                {iconPickerOpen && (
                  <div className="absolute left-0 top-full z-50 mt-1">
                    <EmojiPickerPanel
                      triggerRef={iconTriggerRef}
                      onSelect={(next) => {
                        setDatabaseIcon(next.native)
                        onIconChange?.(next.native)
                        setIconPickerOpen(false)
                      }}
                      onClear={() => {
                        setDatabaseIcon("")
                        onIconChange?.("")
                        setIconPickerOpen(false)
                      }}
                      clearLabel={t("tree.resetIcon")}
                      onClose={() => setIconPickerOpen(false)}
                    />
                  </div>
                )}
              </div>
              <div className="flex min-w-0 flex-1 items-center">
                <input
                  value={databaseTitle}
                  readOnly={!editingDatabaseTitle}
                  aria-label={t("databaseWorkspace.renameTitle")}
                  onFocus={() => {
                    if (!editingDatabaseTitle) setEditingDatabaseTitle(true)
                  }}
                  onChange={(event) => setDatabaseTitle(event.target.value)}
                  onBlur={commitDatabaseTitle}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitDatabaseTitle()
                    if (event.key === "Escape") {
                      setDatabaseTitle(title)
                      setEditingDatabaseTitle(false)
                    }
                  }}
                  className="h-8 min-w-0 w-full cursor-text border-0 bg-transparent p-0 text-2xl font-semibold leading-none tracking-tight text-foreground outline-none sm:h-10 sm:text-3xl"
                />
              </div>
            </header>
          )}
          <div
            ref={toolbarContainerRef}
            className="flex min-h-10 shrink-0 min-w-0 items-center justify-between gap-2 sm:gap-4 px-0 py-1"
          >
            {database && database.views.length > 0 ? (
              isCompactToolbar ? (
                (() => {
                  const activeView =
                    database.views.find((view) => view.viewId === viewId) ?? database.views[0]
                  const activeViewDisplayMode =
                    viewDisplayModes[`${databaseId}:${activeView.viewId}`] ?? "both"
                  const showIcon = activeViewDisplayMode !== "text"
                  const showText = activeViewDisplayMode !== "icon"

                  return (
                    <div className="flex min-w-0 items-center gap-1">
                      <DropdownMenu open={activeViewMenuOpen} onOpenChange={setActiveViewMenuOpen}>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className={cn(
                              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium",
                              "bg-slate-100 text-slate-900 hover:bg-slate-200/80 dark:bg-accent dark:text-foreground dark:hover:bg-accent/80",
                              activeViewDisplayMode === "icon" && "px-2.5",
                            )}
                            title={activeViewDisplayMode === "icon" ? activeView.title : undefined}
                            aria-label={activeView.title}
                            onContextMenu={(event) => {
                              event.preventDefault()
                              setActiveViewMenuOpen(true)
                            }}
                          >
                            {showIcon && (
                              <ViewIcon
                                databaseId={databaseId}
                                viewId={activeView.viewId}
                                layout={activeView.layout}
                                className="size-4 shrink-0"
                              />
                            )}
                            {showText && (
                              <span className="truncate max-w-[120px] sm:max-w-[180px]">
                                {activeView.title}
                              </span>
                            )}
                            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="start"
                          className="w-56"
                          // Focus must not jump back to the tab: the settings panel takes it.
                          onCloseAutoFocus={(event) => event.preventDefault()}
                        >
                          {database.views.length > 1 && (
                            <>
                              <DropdownMenuLabel>{t("databaseWorkspace.views")}</DropdownMenuLabel>
                              {database.views.map((v) => {
                                const isCurrent = v.viewId === activeView.viewId
                                return (
                                  <DropdownMenuItem
                                    key={v.viewId}
                                    onSelect={() => setSelectedViewId(v.viewId)}
                                    className={cn(isCurrent && "font-medium")}
                                  >
                                    <ViewIcon
                                      databaseId={databaseId}
                                      viewId={v.viewId}
                                      layout={v.layout}
                                      className="size-4 shrink-0"
                                    />
                                    <span className="flex-1 truncate">{v.title}</span>
                                    {isCurrent && <Check className="size-4 text-primary" />}
                                  </DropdownMenuItem>
                                )
                              })}
                              <DropdownMenuSeparator />
                            </>
                          )}
                          <DropdownMenuItem
                            onSelect={() => openViewSettings(activeView.viewId, true)}
                          >
                            <Pencil className="size-4" />
                            {t("databaseWorkspace.renameView")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => openViewSettings(activeView.viewId, false)}
                          >
                            <SlidersHorizontal className="size-4" />
                            {t("databaseWorkspace.editView")}
                          </DropdownMenuItem>
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                              <Eye className="size-4" />
                              <span>{t("databaseWorkspace.viewDisplay")}</span>
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="w-48">
                              <DropdownMenuItem
                                onSelect={() => setViewDisplayMode(activeView.viewId, "both")}
                              >
                                <span className="flex-1">
                                  {t("databaseWorkspace.viewDisplayIconAndText")}
                                </span>
                                {activeViewDisplayMode === "both" && (
                                  <Check className="size-4 text-primary" />
                                )}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => setViewDisplayMode(activeView.viewId, "icon")}
                              >
                                <span className="flex-1">
                                  {t("databaseWorkspace.viewDisplayIconOnly")}
                                </span>
                                {activeViewDisplayMode === "icon" && (
                                  <Check className="size-4 text-primary" />
                                )}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => setViewDisplayMode(activeView.viewId, "text")}
                              >
                                <span className="flex-1">
                                  {t("databaseWorkspace.viewDisplayTextOnly")}
                                </span>
                                {activeViewDisplayMode === "text" && (
                                  <Check className="size-4 text-primary" />
                                )}
                              </DropdownMenuItem>
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                          <DropdownMenuItem
                            onSelect={() => void mutateView("duplicate", activeView.viewId)}
                          >
                            <Copy className="size-4" />
                            {t("databaseWorkspace.duplicateView")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            disabled={database.views.length <= 1}
                            onSelect={() => void mutateView("delete", activeView.viewId)}
                          >
                            <Trash2 className="size-4" />
                            {t("databaseWorkspace.deleteView")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={isDatabaseLocked || vaultGeneration === null}
                            onSelect={openCreateViewDialog}
                          >
                            <Plus className="size-4" />
                            {t("databaseWorkspace.addView")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )
                })()
              ) : (
                <div className="group/views flex min-w-0 items-center gap-1">
                  <Reorder.Group
                    as="nav"
                    axis="x"
                    values={tabViews}
                    onReorder={(next) => setViewOrder(next.map((view) => view.viewId))}
                    aria-label={t("databaseWorkspace.views")}
                    // No scrollbars: a dragged tab may overflow by a pixel, and the strip scrolls with the wheel.
                    className="flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                  >
                    {tabViews.map((view) => {
                      const isActive = view.viewId === viewId
                      const viewDisplayMode =
                        viewDisplayModes[`${databaseId}:${view.viewId}`] ?? "both"
                      const showIcon = viewDisplayMode !== "text"
                      const showText = viewDisplayMode !== "icon"

                      const menuContent = (
                        <DropdownMenuContent
                          align="start"
                          className="w-56"
                          // Focus must not jump back to the tab: the settings panel takes it.
                          onCloseAutoFocus={(event) => event.preventDefault()}
                        >
                          <DropdownMenuItem onSelect={() => openViewSettings(view.viewId, true)}>
                            <Pencil className="size-4" />
                            {t("databaseWorkspace.renameView")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => openViewSettings(view.viewId, false)}>
                            <SlidersHorizontal className="size-4" />
                            {t("databaseWorkspace.editView")}
                          </DropdownMenuItem>
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                              <Eye className="size-4" />
                              <span>{t("databaseWorkspace.viewDisplay")}</span>
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="w-48">
                              <DropdownMenuItem
                                onSelect={() => setViewDisplayMode(view.viewId, "both")}
                              >
                                <span className="flex-1">
                                  {t("databaseWorkspace.viewDisplayIconAndText")}
                                </span>
                                {viewDisplayMode === "both" && (
                                  <Check className="size-4 text-primary" />
                                )}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => setViewDisplayMode(view.viewId, "icon")}
                              >
                                <span className="flex-1">
                                  {t("databaseWorkspace.viewDisplayIconOnly")}
                                </span>
                                {viewDisplayMode === "icon" && (
                                  <Check className="size-4 text-primary" />
                                )}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => setViewDisplayMode(view.viewId, "text")}
                              >
                                <span className="flex-1">
                                  {t("databaseWorkspace.viewDisplayTextOnly")}
                                </span>
                                {viewDisplayMode === "text" && (
                                  <Check className="size-4 text-primary" />
                                )}
                              </DropdownMenuItem>
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                          <DropdownMenuItem
                            onSelect={() => void mutateView("duplicate", view.viewId)}
                          >
                            <Copy className="size-4" />
                            {t("databaseWorkspace.duplicateView")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            disabled={database.views.length <= 1}
                            onSelect={() => void mutateView("delete", view.viewId)}
                          >
                            <Trash2 className="size-4" />
                            {t("databaseWorkspace.deleteView")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={isDatabaseLocked || vaultGeneration === null}
                            onSelect={openCreateViewDialog}
                          >
                            <Plus className="size-4" />
                            {t("databaseWorkspace.addView")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      )

                      const renderTab = (drag: ViewTabDrag) => {
                        if (isActive) {
                          return (
                            <DropdownMenu
                              open={activeViewMenuOpen}
                              onOpenChange={setActiveViewMenuOpen}
                            >
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  className={cn(
                                    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium",
                                    "bg-slate-100 text-slate-900 hover:bg-slate-200/80 dark:bg-accent dark:text-foreground dark:hover:bg-accent/80",
                                    viewDisplayMode === "icon" && "px-2.5",
                                  )}
                                  title={viewDisplayMode === "icon" ? view.title : undefined}
                                  aria-label={view.title}
                                  // A press that moves drags the tab; a plain click opens the menu.
                                  onPointerDown={(event) => {
                                    event.preventDefault()
                                    drag.startWatch(event)
                                  }}
                                  onClick={() => {
                                    if (!drag.consumeClick()) setActiveViewMenuOpen((open) => !open)
                                  }}
                                  onContextMenu={(event) => {
                                    event.preventDefault()
                                    setActiveViewMenuOpen(true)
                                  }}
                                >
                                  {showIcon && (
                                    <ViewIcon
                                      databaseId={databaseId}
                                      viewId={view.viewId}
                                      layout={view.layout}
                                      className="size-4 shrink-0"
                                    />
                                  )}
                                  {showText && <span>{view.title}</span>}
                                </button>
                              </DropdownMenuTrigger>
                              {menuContent}
                            </DropdownMenu>
                          )
                        }

                        return (
                          <button
                            key={view.viewId}
                            type="button"
                            className={cn(
                              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs",
                              "text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-muted-foreground dark:hover:bg-accent/50 dark:hover:text-foreground",
                              viewDisplayMode === "icon" && "px-2.5",
                            )}
                            title={viewDisplayMode === "icon" ? view.title : undefined}
                            aria-label={view.title}
                            onPointerDown={drag.startWatch}
                            onClick={() => {
                              if (!drag.consumeClick()) setSelectedViewId(view.viewId)
                            }}
                            onContextMenu={(event) => {
                              event.preventDefault()
                              setSelectedViewId(view.viewId)
                              setActiveViewMenuOpen(true)
                            }}
                          >
                            {showIcon && (
                              <ViewIcon
                                databaseId={databaseId}
                                viewId={view.viewId}
                                layout={view.layout}
                                className="size-4 shrink-0"
                              />
                            )}
                            {showText && <span>{view.title}</span>}
                          </button>
                        )
                      }
                      return (
                        <ViewTabItem
                          key={view.viewId}
                          value={view}
                          disabled={isDatabaseLocked || vaultGeneration === null}
                          onDropped={persistViewOrder}
                        >
                          {renderTab}
                        </ViewTabItem>
                      )
                    })}
                  </Reorder.Group>
                  <button
                    type="button"
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-slate-500 opacity-0 group-hover/views:opacity-100 focus-visible:opacity-100 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-accent/50"
                    aria-label={t("databaseWorkspace.addView")}
                    title={t("databaseWorkspace.addView")}
                    disabled={isDatabaseLocked || vaultGeneration === null}
                    onClick={openCreateViewDialog}
                  >
                    <Plus className="size-4" />
                  </button>
                </div>
              )
            ) : (
              <div />
            )}
            {(() => {
              return (
                <Popover
                  open={queryPanel !== null}
                  onOpenChange={(open) => {
                    if (!open) setQueryPanel(null)
                  }}
                >
                  <PopoverAnchor asChild>
                    <div ref={actionsRef} className="ml-auto flex shrink-0 items-center gap-1">
                      {isCompactToolbar ? (
                        // Folded: search and settings as two icons; the rest is in the panel.
                        <>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground"
                            title={t("databaseWorkspace.search")}
                            aria-label={t("databaseWorkspace.search")}
                            aria-pressed={searchOpen}
                            onClick={() => setSearchOpen((open) => !open)}
                          >
                            {searchOpen ? <X className="size-4" /> : <Search className="size-4" />}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className={cn(
                              "relative text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground",
                              settingsOpen && "bg-accent text-foreground",
                            )}
                            aria-label={t("databaseWorkspace.settings")}
                            aria-pressed={settingsOpen}
                            title={t("databaseWorkspace.settings")}
                            onClick={toggleSettings}
                          >
                            <SlidersHorizontal className="size-4" />
                            {(filterCount > 0 || viewSettings.sorts.length > 0) && (
                              <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />
                            )}
                          </Button>
                        </>
                      ) : (
                        <>
                          <QueryPanelButton
                            icon={<Filter className="size-4" />}
                            label={t("databaseWorkspace.filter")}
                            count={filterCount}
                            active={queryPanel === "filter"}
                            onClick={() =>
                              setQueryPanel((current) => (current === "filter" ? null : "filter"))
                            }
                          />
                          <QueryPanelButton
                            icon={<ArrowDownUp className="size-4" />}
                            label={t("databaseWorkspace.sort")}
                            count={viewSettings.sorts.length}
                            active={queryPanel === "sort"}
                            onClick={() =>
                              setQueryPanel((current) => (current === "sort" ? null : "sort"))
                            }
                          />
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground"
                            title={t("databaseWorkspace.search")}
                            aria-label={t("databaseWorkspace.search")}
                            onClick={() => setSearchOpen((open) => !open)}
                          >
                            {searchOpen ? <X className="size-4" /> : <Search className="size-4" />}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className={cn(
                              "size-8 p-0 text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground",
                              settingsOpen && "bg-accent text-foreground",
                            )}
                            aria-label={t("databaseWorkspace.settings")}
                            aria-pressed={settingsOpen}
                            title={t("databaseWorkspace.settings")}
                            onClick={toggleSettings}
                          >
                            <SlidersHorizontal className="size-4" />
                          </Button>
                          <div className="ml-2 inline-flex items-stretch">
                            <Button
                              size="sm"
                              className="h-8 rounded-l-md rounded-r-none bg-primary px-3 text-xs text-primary-foreground shadow-sm hover:bg-primary/90"
                              disabled={isDatabaseLocked || vaultGeneration === null}
                              onClick={() => openRowDialog({ kind: "default" })}
                            >
                              <Plus className="size-4" />
                              {t("databaseWorkspace.newPageButton")}
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="icon-sm"
                                  className="h-8 w-8 rounded-l-none rounded-r-md border-l border-primary-foreground/25 bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
                                  disabled={isDatabaseLocked || vaultGeneration === null}
                                  aria-label={t("databaseWorkspace.chooseTemplate")}
                                  title={t("databaseWorkspace.chooseTemplate")}
                                >
                                  <ChevronDown className="size-3.5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-56">
                                <DropdownMenuLabel>
                                  {t("databaseWorkspace.templates")}
                                </DropdownMenuLabel>
                                <DropdownMenuItem
                                  onSelect={() => openRowDialog({ kind: "default" })}
                                >
                                  <Database className="size-4" />
                                  {t("databaseWorkspace.defaultTemplate")}
                                </DropdownMenuItem>
                                {database?.templates.map((template) => (
                                  <DropdownMenuItem
                                    key={template.templateId}
                                    onSelect={() =>
                                      openRowDialog({
                                        kind: "template",
                                        templateId: template.templateId,
                                      })
                                    }
                                  >
                                    <FileText className="size-4 shrink-0 text-primary" />
                                    <span className="truncate">{template.name}</span>
                                  </DropdownMenuItem>
                                ))}
                                {(!database || database.templates.length === 0) && (
                                  <DropdownMenuItem disabled>
                                    {t("databaseWorkspace.noTemplates")}
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onSelect={() => openRowDialog({ kind: "empty" })}>
                                  <Plus className="size-4" />
                                  {t("databaseWorkspace.createTemplate")}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </>
                      )}
                    </div>
                  </PopoverAnchor>
                  <PopoverContent
                    align="end"
                    className="w-[28rem] max-w-[calc(100vw-2rem)] p-3"
                    aria-label={
                      queryPanel === "sort" ? t("databaseSort.title") : t("databaseFilter.title")
                    }
                  >
                    {queryPanel === "filter" && (
                      <ViewFilterEditor
                        conditions={savedConditions ?? []}
                        complex={savedConditions === null}
                        properties={database?.properties ?? EMPTY_PROPERTIES}
                        titleName={titleColumnName ?? t("databaseTable.title")}
                        requestedField={requestedFilterField}
                        onRequestedFieldHandled={() => setRequestedFilterField(null)}
                        onChange={(conditions) =>
                          updateViewSettings({ filter: conditionsToFilter(conditions) })
                        }
                        onResetComplex={() => updateViewSettings({ filter: null })}
                      />
                    )}
                    {queryPanel === "sort" && (
                      <ViewSortEditor
                        sorts={viewSettings.sorts}
                        properties={database?.properties ?? EMPTY_PROPERTIES}
                        titleName={titleColumnName ?? t("databaseTable.title")}
                        onChange={(sorts) => updateViewSettings({ sorts })}
                      />
                    )}
                  </PopoverContent>
                </Popover>
              )
            })()}
          </div>
          {searchOpen && (
            <div className="my-1 flex shrink-0 items-center gap-2 rounded-lg bg-slate-50 px-3 py-1 dark:bg-muted/40">
              <Search className="size-4 text-slate-400 dark:text-muted-foreground" />
              <Input
                autoFocus
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t("databaseWorkspace.searchPlaceholder")}
                aria-label={t("databaseWorkspace.search")}
                className="h-8 max-w-sm border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
              />
              {searchQuery && (
                <Button variant="ghost" size="icon-sm" onClick={() => setSearchQuery("")}>
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
          )}
          {mutationError && (
            <p
              role="alert"
              className="my-1 rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              {mutationError}
            </p>
          )}
          <div ref={contentAreaRef} className="flex min-h-0 min-w-0 flex-1">
            {activeHost?.rows.length || activeHost?.status === "loading" || activeHost?.error ? (
              <div className="flex min-h-0 min-w-0 flex-1 gap-4 px-0 pb-6 pt-2">
                <motion.div
                  // A new view (or layout) fades and rises in instead of snapping.
                  key={`${viewId ?? "none"}:${selectedView?.layout ?? "table"}`}
                  className={cn(
                    "flex min-w-0 flex-1 rounded-xl bg-[var(--note-surface)]",
                    // The grips of a table or list hang outside this surface.
                    selectedView &&
                      selectedView.layout !== "list" &&
                      selectedView.layout !== "table" &&
                      "overflow-hidden",
                  )}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={motionTransition(motionTransitions.enter)}
                >
                  {selectedView?.layout === "chart" && viewId ? (
                    <ChartView
                      databaseId={databaseId}
                      expectedGeneration={vaultGeneration}
                      enabled={queriesEnabled}
                      category={chartCategory}
                      filter={queryFilter}
                      search={searchQuery}
                    />
                  ) : selectedView?.layout === "list" ? (
                    <ListView
                      rows={displayRows}
                      cardFields={cardFieldIds}
                      cardEdit={cardEdit}
                      properties={database?.properties ?? EMPTY_PROPERTIES}
                      relationTitles={relationTitles}
                      loading={activeHost.status === "loading"}
                      error={activeHost.error}
                      hasNextPage={Boolean(activeHost.nextCursor)}
                      onLoadNextPage={loadNextPage}
                      onRetry={retry}
                      onRowSelect={openRow}
                      rowMenu={rowMenu}
                      rowReorder={rowReorder}
                      onCreateCard={
                        onCreateRowAvailable(isDatabaseLocked, vaultGeneration)
                          ? () => openRowDialog({ kind: "empty" })
                          : undefined
                      }
                    />
                  ) : selectedView?.layout === "gallery" && boardGroupProperty ? (
                    <GalleryLanesView
                      databaseId={databaseId}
                      groupProperty={boardGroupProperty}
                      properties={database?.properties ?? EMPTY_PROPERTIES}
                      relationTitles={relationTitles}
                      cardFields={cardFieldIds}
                      cardEdit={cardEdit}
                      cardSize={viewSettings.cardSize}
                      coverVisible={viewSettings.coverVisible}
                      vaultGeneration={vaultGeneration}
                      filter={queryFilter}
                      sorts={querySorts}
                      search={searchQuery}
                      enabled={boardEnabled}
                      onRowSelect={openRow}
                      rowMenu={rowMenu}
                      colorColumns={viewSettings.colorColumns}
                      groupDisplay={groupDisplay}
                      onCreateCard={
                        onCreateRowAvailable(isDatabaseLocked, vaultGeneration)
                          ? openRowDialogInLane
                          : undefined
                      }
                    />
                  ) : selectedView?.layout === "gallery" ? (
                    <GalleryView
                      rows={displayRows}
                      cardFields={cardFieldIds}
                      cardEdit={cardEdit}
                      cardSize={viewSettings.cardSize}
                      coverVisible={viewSettings.coverVisible}
                      databaseId={databaseId}
                      vaultGeneration={vaultGeneration}
                      properties={database?.properties ?? EMPTY_PROPERTIES}
                      relationTitles={relationTitles}
                      loading={activeHost.status === "loading"}
                      error={activeHost.error}
                      hasNextPage={Boolean(activeHost.nextCursor)}
                      onLoadNextPage={loadNextPage}
                      onRetry={retry}
                      onRowSelect={openRow}
                      rowMenu={rowMenu}
                      rowReorder={rowReorder}
                      onCreateCard={
                        onCreateRowAvailable(isDatabaseLocked, vaultGeneration)
                          ? () => openRowDialog({ kind: "empty" })
                          : undefined
                      }
                    />
                  ) : selectedView?.layout === "board" ? (
                    boardGroupProperty ? (
                      <BoardLanesView
                        databaseId={databaseId}
                        groupProperty={boardGroupProperty}
                        properties={database?.properties ?? EMPTY_PROPERTIES}
                        relationTitles={relationTitles}
                        cardFields={cardFieldIds}
                        cardEdit={cardEdit}
                        filter={queryFilter}
                        sorts={querySorts}
                        search={searchQuery}
                        enabled={boardEnabled}
                        onRowSelect={openRow}
                        onMoveRow={moveRowToGroup}
                        colorColumns={viewSettings.colorColumns}
                        groupDisplay={groupDisplay}
                        onCreateCard={
                          onCreateRowAvailable(isDatabaseLocked, vaultGeneration)
                            ? openRowDialogInLane
                            : undefined
                        }
                      />
                    ) : (
                      <>
                        {!groupField && (
                          <BoardGroupPrompt
                            candidates={(database?.properties ?? EMPTY_PROPERTIES).filter(
                              (property) =>
                                isOptionProperty(property.propertyType) &&
                                property.propertyType !== "multiSelect",
                            )}
                            disabled={isDatabaseLocked}
                            onPick={(groupBy) => updateViewSettings({ groupBy })}
                          />
                        )}
                        <BoardView
                          rows={displayRows}
                          cardFields={cardFieldIds}
                          cardEdit={cardEdit}
                          properties={database?.properties ?? EMPTY_PROPERTIES}
                          relationTitles={relationTitles}
                          groupField={groupField}
                          loading={activeHost.status === "loading"}
                          error={activeHost.error}
                          hasNextPage={Boolean(activeHost.nextCursor)}
                          onLoadNextPage={loadNextPage}
                          onRetry={retry}
                          onRowSelect={openRow}
                          onMoveRow={moveRowToGroup}
                          onCreateCard={
                            onCreateRowAvailable(isDatabaseLocked, vaultGeneration)
                              ? () => openRowDialog({ kind: "empty" })
                              : undefined
                          }
                        />
                      </>
                    )
                  ) : (
                    <TableView
                      databaseId={databaseId}
                      rows={displayRows}
                      properties={database?.properties ?? EMPTY_PROPERTIES}
                      databases={databases}
                      onOpenNote={handleOpenNote}
                      onCreateRelationRow={handleCreateRelationRow}
                      titleColumnName={titleColumnName ?? t("databaseTable.title")}
                      onTitleColumnNameChange={onTitleColumnNameChange}
                      onRenameProperty={
                        onRenameProperty ??
                        (!isDatabaseLocked && vaultGeneration !== null
                          ? persistPropertyName
                          : undefined)
                      }
                      onChangePropertyType={
                        isDatabaseLocked || vaultGeneration === null
                          ? undefined
                          : persistPropertyType
                      }
                      computedErrors={computedErrors}
                      renderPropertySettings={renderPropertySettings}
                      onRenameRow={onRenameRow}
                      filteredFieldKeys={filteredFieldKeys}
                      onFilterColumn={(key) => {
                        setRequestedFilterField(key)
                        setQueryPanel("filter")
                      }}
                      sortValue={sortValue}
                      onSortValueChange={setSortValue}
                      pendingCells={pendingCells}
                      cellErrors={cellErrors}
                      onCellCommit={commitCell}
                      onDeleteProperty={
                        isDatabaseLocked || vaultGeneration === null ? undefined : deleteProperty
                      }
                      loading={activeHost.status === "loading"}
                      error={activeHost.error}
                      hasNextPage={Boolean(activeHost.nextCursor)}
                      onLoadNextPage={loadNextPage}
                      onRetry={retry}
                      onRowSelect={openRow}
                      rowMenu={rowMenu}
                      rowReorder={rowReorder}
                      onDeleteRows={deleteRows}
                      onAddProperty={
                        isDatabaseLocked
                          ? undefined
                          : (beforePropertyId) => {
                              setMutationError(null)
                              setPropertyInsertBeforeId(beforePropertyId)
                              setRelationTargetDatabaseId(databaseId)
                              setPropertyDialogOpen(true)
                            }
                      }
                      onCreateRow={
                        isDatabaseLocked || vaultGeneration === null
                          ? undefined
                          : () => openRowDialog({ kind: "empty" })
                      }
                      newPageLabel={t("databaseWorkspace.newPage")}
                      savedSettings={tableSavedSettings}
                      onSavedSettingsChange={updateViewSettings}
                      hiddenPropertyIds={activeHiddenPropertyIds}
                      onHiddenPropertyIdsChange={(next) => {
                        if (activeView) {
                          setViewHiddenPropertyIds(activeView.viewId, next)
                        }
                      }}
                    />
                  )}
                </motion.div>
                <AnimatePresence>
                  {selectedRow && (
                    <DatabaseSidePeek
                      key="row-peek"
                      row={selectedRow}
                      variant={viewSettings.openMode === "centerPeek" ? "center" : "side"}
                      propertiesSection={
                        <PeekProperties
                          row={selectedRow}
                          properties={database?.properties ?? EMPTY_PROPERTIES}
                          databases={databases}
                          currentDatabaseId={databaseId}
                          pendingCells={pendingCells}
                          cellErrors={cellErrors}
                          disabled={isDatabaseLocked}
                          onCommit={commitPeekCell}
                          onOpenNote={handleOpenNote}
                          onCreateRelationRow={handleCreateRelationRow}
                        />
                      }
                      canPrevious={selectedRowIndex > 0}
                      canNext={selectedRowIndex < displayRows.length - 1}
                      onPrevious={() => selectAdjacentRow(-1)}
                      onNext={() => selectAdjacentRow(1)}
                      yamlSync={
                        yamlSyncState?.rowId === selectedRow.noteId
                          ? {
                              busy: yamlSyncState.busy,
                              error: yamlSyncState.error,
                              result: yamlSyncState.result,
                              onSync: () => void syncYamlForRow(selectedRow),
                              onResolve: (conflict, resolution, manualValueJson) =>
                                void resolveYamlForRow(
                                  selectedRow,
                                  conflict,
                                  resolution,
                                  manualValueJson,
                                ),
                            }
                          : {
                              busy: false,
                              error: null,
                              result: null,
                              onSync: () => void syncYamlForRow(selectedRow),
                              onResolve: (conflict, resolution, manualValueJson) =>
                                void resolveYamlForRow(
                                  selectedRow,
                                  conflict,
                                  resolution,
                                  manualValueJson,
                                ),
                            }
                      }
                      onClose={() => setSelectedRowId(null)}
                      onOpenFullPage={() => onOpenRowFullPage?.(selectedRow)}
                      body={
                        onLoadRowDocument ? (
                          <PeekRowEditor
                            row={selectedRow}
                            vault={vault}
                            onLoad={onLoadRowDocument}
                            onContentChange={onRowContentChange}
                          />
                        ) : undefined
                      }
                    />
                  )}
                </AnimatePresence>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center py-8">
                <div className="max-w-md space-y-3 text-center">
                  <Database className="mx-auto size-8 text-muted-foreground" />
                  <h2 className="text-lg font-semibold">
                    {t("databaseWorkspace.placeholderTitle")}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {t("databaseWorkspace.placeholderDescription")}
                  </p>
                  {onCreateRowAvailable(isDatabaseLocked, vaultGeneration) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 rounded-lg px-4"
                      onClick={() => openRowDialog({ kind: "empty" })}
                    >
                      <Plus className="size-4" />
                      {t("databaseWorkspace.emptyPage")}
                    </Button>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {runtime?.enabled && catalogStatus === "ready"
                      ? t("databaseWorkspace.runtimeReady")
                      : t("databaseWorkspace.runtimeUnavailable")}
                    {activeHost?.diagnostics.length ? ` · ${activeHost.diagnostics.length}` : ""}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
        <SortResetDialog
          open={sortPromptOpen}
          onOpenChange={setSortPromptOpen}
          onConfirm={() => updateViewSettings({ sorts: [] })}
        />
        <DatabaseViewDialog
          open={viewDialogOpen}
          onOpenChange={setViewDialogOpen}
          mode="create"
          viewName={viewName}
          onViewNameChange={setViewName}
          viewLayout={viewLayout}
          onViewLayoutChange={(layout) => {
            // The name follows the layout until the user types their own.
            const previousDefault = t(`databaseLayouts.${viewLayout}`)
            if (!viewName.trim() || viewName === previousDefault) {
              setViewName(t(`databaseLayouts.${layout}`))
            }
            setViewLayout(layout)
          }}
          mutationBusy={mutationBusy}
          mutationError={mutationError}
          onSave={() => void saveViewDialog()}
        />
        <DatabaseRowDialog
          open={rowDialogOpen}
          onOpenChange={setRowDialogOpen}
          rowTitle={rowTitle}
          onRowTitleChange={setRowTitle}
          mutationBusy={mutationBusy}
          mutationError={mutationError}
          onCreate={() => void createRow()}
        />
        <DatabasePropertyDialog
          open={propertyDialogOpen}
          onOpenChange={(open) => {
            setPropertyDialogOpen(open)
            if (!open) setPropertyInsertBeforeId(undefined)
          }}
          propertyName={propertyName}
          onPropertyNameChange={setPropertyName}
          propertyType={propertyType}
          onPropertyTypeChange={setPropertyType}
          formulaExpression={formulaExpression}
          onFormulaExpressionChange={setFormulaExpression}
          relationTargetDatabaseId={relationTargetDatabaseId}
          onRelationTargetDatabaseIdChange={(nextId) => {
            setRelationTargetDatabaseId(nextId)
            if (!relationInversePropertyName) {
              setRelationInversePropertyName(title || "Related")
            }
          }}
          relationMaxItems={relationMaxItems}
          onRelationMaxItemsChange={setRelationMaxItems}
          relationSelfDual={relationSelfDual}
          onRelationSelfDualChange={setRelationSelfDual}
          relationTwoWay={relationTwoWay}
          onRelationTwoWayChange={setRelationTwoWay}
          relationInversePropertyName={relationInversePropertyName}
          onRelationInversePropertyNameChange={setRelationInversePropertyName}
          currentDatabaseId={databaseId}
          currentDatabaseTitle={title}
          databases={databases}
          rollupDraft={rollupDraft}
          onRollupDraftChange={setRollupDraft}
          mutationBusy={mutationBusy}
          mutationError={mutationError}
          onCreate={() => void createProperty()}
        />
        <AnimatePresence>
          {settingsOpen && (
            <ViewSettingsPanel
              key="view-settings"
              top={settingsPanelTop}
              focusNameSignal={settingsFocusSignal}
              isCompactToolbar={isCompactToolbar}
              isDatabaseLocked={isDatabaseLocked}
              vaultGeneration={vaultGeneration}
              activeView={activeView}
              database={database}
              mutationBusy={mutationBusy}
              searchOpen={searchOpen}
              isLinkCopied={isLinkCopied}
              activeHiddenPropertyIds={activeHiddenPropertyIds}
              filterCount={filterCount}
              sortCount={viewSettings.sorts.length}
              onOpenFilter={() => setQueryPanel("filter")}
              onOpenSort={() => setQueryPanel("sort")}
              openRowDialog={openRowDialog}
              viewIcon={
                activeView
                  ? iconOverrides[databaseViewIconKey(databaseId, activeView.viewId)]
                  : undefined
              }
              onViewIconChange={(icon) =>
                activeView && setIcon(databaseViewIconKey(databaseId, activeView.viewId), icon)
              }
              onRenameView={renameActiveView}
              renderPropertySettings={renderPropertySettings}
              propertyIconOf={(propertyId) =>
                iconOverrides[databasePropertyIconKey(databaseId, propertyId)]
              }
              onPropertyIconChange={(propertyId, icon) =>
                setIcon(databasePropertyIconKey(databaseId, propertyId), icon)
              }
              onRenameProperty={persistPropertyName}
              onChangePropertyType={(propertyId, propertyType) =>
                persistPropertyType(propertyId, propertyType)
              }
              onDeleteProperty={deleteProperty}
              changeActiveViewLayout={changeActiveViewLayout}
              cardSize={viewSettings.cardSize}
              openMode={viewSettings.openMode}
              onOpenModeChange={(openMode) => updateViewSettings({ openMode })}
              onCardSizeChange={(cardSize) => updateViewSettings({ cardSize })}
              groupPropertyId={groupField?.kind === "property" ? groupField.propertyId : null}
              onGroupPropertyChange={(groupBy) => updateViewSettings({ groupBy })}
              coverVisible={viewSettings.coverVisible}
              onCoverVisibleChange={(coverVisible) => updateViewSettings({ coverVisible })}
              colorColumns={viewSettings.colorColumns}
              onColorColumnsChange={(colorColumns) => updateViewSettings({ colorColumns })}
              groupSort={viewSettings.groupSort}
              onGroupSortChange={(groupSort) => updateViewSettings({ groupSort })}
              hideEmptyGroups={viewSettings.hideEmptyGroups}
              onHideEmptyGroupsChange={(hideEmptyGroups) => updateViewSettings({ hideEmptyGroups })}
              groupOrder={viewSettings.groupOrder}
              onGroupOrderChange={(groupOrder) =>
                updateViewSettings({ groupOrder, groupSort: "manual" })
              }
              hiddenGroups={viewSettings.hiddenGroups}
              onHiddenGroupsChange={(hiddenGroups) => updateViewSettings({ hiddenGroups })}
              setViewHiddenPropertyIds={setViewHiddenPropertyIds}
              togglePropertyVisibility={togglePropertyVisibility}
              onOpenAddProperty={() => {
                setMutationError(null)
                setPropertyInsertBeforeId(undefined)
                setRelationTargetDatabaseId(databaseId)
                setPropertyDialogOpen(true)
              }}
              copyLinkToView={copyLinkToView}
              handleToggleLock={handleToggleLock}
              mutateView={mutateView}
              onClose={() => setSettingsOpen(false)}
            />
          )}
        </AnimatePresence>

        <DatabaseFloatingToolbar
          rowCount={activeHost?.totalCount ?? displayRows.length}
          propertyCount={database?.properties.length ?? 0}
          isDatabaseLocked={isDatabaseLocked}
          canUndo={historyStatus.canUndo}
          canRedo={historyStatus.canRedo}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onToggleLock={handleToggleLock}
          contentWidth={contentWidth}
          onContentWidthChange={onContentWidthChange}
        />
      </section>
    </OptionActionsProvider>
  )
}

function onCreateRowAvailable(locked: boolean | undefined, generation: number | null) {
  return !locked && generation !== null
}
