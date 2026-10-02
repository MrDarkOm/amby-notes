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
import { motion } from "motion/react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import { motionTransitions } from "@/lib/motion-config"
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
import { useViewQueryState } from "./use-view-query-state"
import { BoardLanesView } from "./board-lanes-view"
import { ViewFilterEditor } from "./view-filter-editor"
import { ViewSortEditor } from "./view-sort-editor"
import { conditionsToFilter } from "./view-config"
import { EMPTY_ROLLUP_DRAFT, type RollupDraft } from "./rollup-model"
import { RollupConfigDialog } from "./rollup-config-dialog"
import {
  createDatabaseOperationId,
  createRelationTargetRow,
  usePropertyMutation,
} from "./use-property-mutation"
import { referenceTitles, relationTargetIds, useRecordReferences } from "./use-record-references"
import { ChartView } from "./chart-view"
import { RelationConfigDialog } from "./relation-config-dialog"
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
import { DatabaseSettingsMenuContent, QueryPanelButton } from "./database-view-menu"
import { getViewLayoutIcon } from "./database-layout-icons"

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
  const [selectedViewId, setSelectedViewId] = React.useState<string | null>(null)
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
  const [viewDialogMode, setViewDialogMode] = React.useState<"create" | "rename" | "edit">("create")
  const [viewDialogViewId, setViewDialogViewId] = React.useState<string | null>(null)
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
  const [rollupConfigProperty, setRollupConfigProperty] =
    React.useState<DatabasePropertySummary | null>(null)
  const [relationTargetDatabaseId, setRelationTargetDatabaseId] = React.useState(databaseId)
  const [relationMaxItems, setRelationMaxItems] = React.useState<number | null>(null)
  const [relationTwoWay, setRelationTwoWay] = React.useState(false)
  const [relationInversePropertyName, setRelationInversePropertyName] = React.useState("")
  const [relationSelfDual, setRelationSelfDual] = React.useState(true)
  const [relationConfigProperty, setRelationConfigProperty] =
    React.useState<DatabasePropertySummary | null>(null)
  const [mutationBusy, setMutationBusy] = React.useState(false)
  const [mutationError, setMutationError] = React.useState<string | null>(null)
  const [yamlSyncState, setYamlSyncState] = React.useState<{
    rowId: string
    busy: boolean
    error: string | null
    result: DatabaseYamlSyncResult | null
  } | null>(null)
  const viewId = selectedViewId ?? database?.views[0]?.viewId ?? null
  const selectedView = database?.views.find((view) => view.viewId === viewId)
  const activeView = selectedView ?? database?.views[0]
  const [isLockedStub, setIsLockedStub] = React.useState(false)
  const isDatabaseLocked = Boolean(
    propIsLocked !== undefined ? propIsLocked : database?.locked || isLockedStub,
  )
  const handleToggleLock = onToggleLock ?? (() => setIsLockedStub((current) => !current))
  const [isLinkCopied, setIsLinkCopied] = React.useState(false)

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
  const [queryPanel, setQueryPanel] = React.useState<"filter" | "sort" | null>(null)
  const [requestedFilterField, setRequestedFilterField] = React.useState<string | null>(null)
  const boardGroupProperty = React.useMemo(() => {
    const group = selectedView?.groupField
    if (selectedView?.layout !== "board" || !group || group.kind !== "property") return null
    const property = database?.properties.find(
      (candidate) => candidate.propertyId === group.propertyId,
    )
    return property && (property.propertyType === "select" || property.propertyType === "status")
      ? property
      : null
  }, [database?.properties, selectedView?.groupField, selectedView?.layout])

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
  const displayRows = React.useMemo(() => activeHost?.rows ?? EMPTY_ROWS, [activeHost?.rows])

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
    setViewDialogMode("create")
    setViewDialogViewId(null)
    setViewName("")
    setViewLayout("table")
    setMutationError(null)
    setViewDialogOpen(true)
  }, [])

  const openRenameViewDialog = React.useCallback(
    (view: { viewId: string; title: string; layout: string }) => {
      setViewDialogMode("rename")
      setViewDialogViewId(view.viewId)
      setViewName(view.title)
      setViewLayout(
        view.layout === "board" ||
          view.layout === "list" ||
          view.layout === "gallery" ||
          view.layout === "chart"
          ? view.layout
          : "table",
      )
      setMutationError(null)
      setViewDialogOpen(true)
    },
    [],
  )

  const openEditViewDialog = React.useCallback(
    (view: { viewId: string; title: string; layout: string }) => {
      setViewDialogMode("edit")
      setViewDialogViewId(view.viewId)
      setViewName(view.title)
      setViewLayout(
        view.layout === "board" ||
          view.layout === "list" ||
          view.layout === "gallery" ||
          view.layout === "chart"
          ? view.layout
          : "table",
      )
      setMutationError(null)
      setViewDialogOpen(true)
    },
    [],
  )

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
    [onCatalogChanged, retry],
  )

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
      if (viewDialogMode === "create") {
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
      } else if (viewDialogMode === "edit") {
        const current = database.views.find((view) => view.viewId === viewDialogViewId)
        if (!current || !viewDialogViewId) return
        if (viewLayout !== current.layout) {
          const doc = await getDatabaseView({
            expectedGeneration: currentGeneration,
            databaseId: targetDatabaseId,
            viewId: viewDialogViewId,
            expectedViewRevision: current.revision,
          })
          const config = JSON.parse(doc.configJson)
          config.name = viewName.trim()
          config.layout = viewLayout
          await updateDatabaseViewConfig({
            expectedGeneration: currentGeneration,
            databaseId: targetDatabaseId,
            viewId: viewDialogViewId,
            expectedViewRevision: doc.revision,
            configJson: JSON.stringify(config),
          })
          logger.info("database.update_view_config", {
            databaseId: targetDatabaseId,
            viewId: viewDialogViewId,
            name: viewName.trim(),
            layout: viewLayout,
          })
        } else if (viewName.trim() !== current.title) {
          await renameDatabaseView({
            expectedGeneration: currentGeneration,
            databaseId: targetDatabaseId,
            viewId: viewDialogViewId,
            expectedViewRevision: current.revision,
            name: viewName.trim(),
          })
          logger.info("database.rename_view", {
            databaseId: targetDatabaseId,
            viewId: viewDialogViewId,
            name: viewName.trim(),
          })
        }
        setViewDialogOpen(false)
        await refreshDatabaseViews(viewDialogViewId)
      } else {
        const current = database.views.find((view) => view.viewId === viewDialogViewId)
        if (!current || !viewDialogViewId) return
        await renameDatabaseView({
          expectedGeneration: currentGeneration,
          databaseId: targetDatabaseId,
          viewId: viewDialogViewId,
          expectedViewRevision: current.revision,
          name: viewName.trim(),
        })
        logger.info("database.rename_view", {
          databaseId: targetDatabaseId,
          viewId: viewDialogViewId,
          name: viewName.trim(),
        })
        setViewDialogOpen(false)
        await refreshDatabaseViews(viewDialogViewId)
      }
    } catch (error) {
      logger.error("database.view_action_failed", {
        databaseId: targetDatabaseId,
        viewDialogMode,
        error,
      })
      setMutationError(error instanceof Error ? error.message : String(error))
    } finally {
      setMutationBusy(false)
    }
  }, [
    database?.databaseId,
    database?.manifestRevision,
    database?.views,
    databaseId,
    isDatabaseLocked,
    mutationBusy,
    refreshDatabaseViews,
    vaultGeneration,
    viewDialogMode,
    viewDialogViewId,
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
    setRowTitle("")
    setMutationError(null)
    setRowDialogOpen(true)
  }, [])

  const displayedDatabaseIcon =
    normalizeDatabaseIcon(databaseIcon) ?? normalizeDatabaseIcon(database?.icon)

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
  }, [databaseId, mutationBusy, onRowCreated, retry, rowTemplate, rowTitle, vaultGeneration])

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
        options: propertyType === "relation" ? [relationTargetDatabaseId] : undefined,
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
        setMutationError(error instanceof Error ? error.message : String(error))
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
      const groupField = selectedView?.groupField
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
      void refreshHistoryStatus()
    },
    [
      database?.properties,
      databaseId,
      refreshHistoryStatus,
      retry,
      selectedView?.groupField,
      t,
      vaultGeneration,
    ],
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
    <section className="relative flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden bg-[var(--note-surface)] text-foreground">
      {/* Hidden measuring container to determine unconstrained width of all view tabs */}
      <div
        ref={viewsMeasureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute -left-[9999px] top-0 flex items-center gap-1"
      >
        {database?.views.map((view) => {
          const ViewIcon = getViewLayoutIcon(view.layout)
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
              {showIcon && <ViewIcon className="size-4 shrink-0" />}
              {showText && <span>{view.title}</span>}
            </div>
          )
        })}
      </div>
      <div
        className="mx-auto flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden px-3 sm:px-8 lg:px-10"
        style={{ maxWidth: EDITOR_CONTENT_WIDTH[contentWidth] }}
      >
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
        <div
          ref={toolbarContainerRef}
          className="flex min-h-10 shrink-0 min-w-0 items-center justify-between gap-2 sm:gap-4 px-0 py-1"
        >
          {database && database.views.length > 0 ? (
            isCompactToolbar ? (
              (() => {
                const activeView =
                  database.views.find((view) => view.viewId === viewId) ?? database.views[0]
                const ActiveViewIcon = getViewLayoutIcon(activeView.layout)
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
                          {showIcon && <ActiveViewIcon className="size-4 shrink-0" />}
                          {showText && (
                            <span className="truncate max-w-[120px] sm:max-w-[180px]">
                              {activeView.title}
                            </span>
                          )}
                          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-56">
                        {database.views.length > 1 && (
                          <>
                            <DropdownMenuLabel>{t("databaseWorkspace.views")}</DropdownMenuLabel>
                            {database.views.map((v) => {
                              const VIcon = getViewLayoutIcon(v.layout)
                              const isCurrent = v.viewId === activeView.viewId
                              return (
                                <DropdownMenuItem
                                  key={v.viewId}
                                  onSelect={() => setSelectedViewId(v.viewId)}
                                  className={cn(isCurrent && "font-medium")}
                                >
                                  <VIcon className="size-4 shrink-0" />
                                  <span className="flex-1 truncate">{v.title}</span>
                                  {isCurrent && <Check className="size-4 text-primary" />}
                                </DropdownMenuItem>
                              )
                            })}
                            <DropdownMenuSeparator />
                          </>
                        )}
                        <DropdownMenuItem onSelect={() => openRenameViewDialog(activeView)}>
                          <Pencil className="size-4" />
                          {t("databaseWorkspace.renameView")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => openEditViewDialog(activeView)}>
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
                <nav
                  aria-label={t("databaseWorkspace.views")}
                  className="flex min-w-0 items-center gap-1 overflow-x-auto"
                >
                  {database.views.map((view) => {
                    const ViewIcon = getViewLayoutIcon(view.layout)
                    const isActive = view.viewId === viewId
                    const viewDisplayMode =
                      viewDisplayModes[`${databaseId}:${view.viewId}`] ?? "both"
                    const showIcon = viewDisplayMode !== "text"
                    const showText = viewDisplayMode !== "icon"

                    const menuContent = (
                      <DropdownMenuContent align="start" className="w-56">
                        <DropdownMenuItem onSelect={() => openRenameViewDialog(view)}>
                          <Pencil className="size-4" />
                          {t("databaseWorkspace.renameView")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => openEditViewDialog(view)}>
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

                    if (isActive) {
                      return (
                        <DropdownMenu
                          key={view.viewId}
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
                              onContextMenu={(event) => {
                                event.preventDefault()
                                setActiveViewMenuOpen(true)
                              }}
                            >
                              {showIcon && <ViewIcon className="size-4 shrink-0" />}
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
                        onClick={() => setSelectedViewId(view.viewId)}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          setSelectedViewId(view.viewId)
                          setActiveViewMenuOpen(true)
                        }}
                      >
                        {showIcon && <ViewIcon className="size-4 shrink-0" />}
                        {showText && <span>{view.title}</span>}
                      </button>
                    )
                  })}
                </nav>
                <button
                  type="button"
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-slate-500 opacity-0 group-hover/views:opacity-100 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-accent/50"
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
            const settingsMenuContent = (
              <DatabaseSettingsMenuContent
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
                onToggleSearch={() => setSearchOpen((open) => !open)}
                openRenameViewDialog={openRenameViewDialog}
                changeActiveViewLayout={changeActiveViewLayout}
                cardFields={viewSettings.cardFields}
                cardSize={viewSettings.cardSize}
                onCardFieldsChange={(cardFields) => updateViewSettings({ cardFields })}
                onCardSizeChange={(cardSize) => updateViewSettings({ cardSize })}
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
              />
            )

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
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 gap-1.5 rounded-full px-3 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-muted-foreground dark:hover:bg-accent dark:hover:text-foreground"
                            aria-label={t("databaseWorkspace.settings")}
                            title={t("databaseWorkspace.settings")}
                          >
                            <SlidersHorizontal className="size-3.5 shrink-0" />
                            <span className="truncate max-w-[100px]">
                              {t("databaseWorkspace.settings")}
                            </span>
                            {(filterCount > 0 || viewSettings.sorts.length > 0) && (
                              <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                            )}
                          </Button>
                        </DropdownMenuTrigger>
                        {settingsMenuContent}
                      </DropdownMenu>
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
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="size-8 p-0 text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground"
                              aria-label={t("databaseWorkspace.settings")}
                              title={t("databaseWorkspace.settings")}
                            >
                              <SlidersHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          {settingsMenuContent}
                        </DropdownMenu>
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
                              <DropdownMenuItem onSelect={() => openRowDialog({ kind: "default" })}>
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
        {activeHost?.rows.length || activeHost?.status === "loading" || activeHost?.error ? (
          <div className="flex min-h-0 min-w-0 flex-1 gap-4 px-0 pb-6 pt-2">
            <div className="flex min-w-0 flex-1 overflow-hidden rounded-xl bg-[var(--note-surface)]">
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
                  cardFields={viewSettings.cardFields}
                  properties={database?.properties ?? EMPTY_PROPERTIES}
                  relationTitles={relationTitles}
                  loading={activeHost.status === "loading"}
                  error={activeHost.error}
                  hasNextPage={Boolean(activeHost.nextCursor)}
                  onLoadNextPage={loadNextPage}
                  onRetry={retry}
                  onRowSelect={(row) => setSelectedRowId(row.noteId)}
                />
              ) : selectedView?.layout === "gallery" ? (
                <GalleryView
                  rows={displayRows}
                  cardFields={viewSettings.cardFields}
                  cardSize={viewSettings.cardSize}
                  databaseId={databaseId}
                  vaultGeneration={vaultGeneration}
                  properties={database?.properties ?? EMPTY_PROPERTIES}
                  relationTitles={relationTitles}
                  loading={activeHost.status === "loading"}
                  error={activeHost.error}
                  hasNextPage={Boolean(activeHost.nextCursor)}
                  onLoadNextPage={loadNextPage}
                  onRetry={retry}
                  onRowSelect={(row) => setSelectedRowId(row.noteId)}
                />
              ) : selectedView?.layout === "board" ? (
                boardGroupProperty ? (
                  <BoardLanesView
                    databaseId={databaseId}
                    groupProperty={boardGroupProperty}
                    properties={database?.properties ?? EMPTY_PROPERTIES}
                    relationTitles={relationTitles}
                    cardFields={viewSettings.cardFields}
                    filter={queryFilter}
                    sorts={querySorts}
                    search={searchQuery}
                    enabled={boardEnabled}
                    onRowSelect={(row) => {
                      setSelectedRowSnapshot(row)
                      setSelectedRowId(row.noteId)
                    }}
                    onMoveRow={moveRowToGroup}
                  />
                ) : (
                  <BoardView
                    rows={displayRows}
                    cardFields={viewSettings.cardFields}
                    properties={database?.properties ?? EMPTY_PROPERTIES}
                    relationTitles={relationTitles}
                    groupField={selectedView.groupField}
                    loading={activeHost.status === "loading"}
                    error={activeHost.error}
                    hasNextPage={Boolean(activeHost.nextCursor)}
                    onLoadNextPage={loadNextPage}
                    onRetry={retry}
                    onRowSelect={(row) => setSelectedRowId(row.noteId)}
                    onMoveRow={moveRowToGroup}
                  />
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
                    isDatabaseLocked || vaultGeneration === null ? undefined : persistPropertyType
                  }
                  onConfigureRollup={
                    isDatabaseLocked || vaultGeneration === null
                      ? undefined
                      : setRollupConfigProperty
                  }
                  computedErrors={computedErrors}
                  onConfigureRelation={
                    isDatabaseLocked || vaultGeneration === null
                      ? undefined
                      : (property) => {
                          try {
                            const config = JSON.parse(property.configJson) as {
                              targetDatabaseId?: unknown
                            }
                            setRelationTargetDatabaseId(
                              typeof config.targetDatabaseId === "string"
                                ? config.targetDatabaseId
                                : databaseId,
                            )
                          } catch {
                            setRelationTargetDatabaseId(databaseId)
                          }
                          setMutationError(null)
                          setRelationConfigProperty(property)
                        }
                  }
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
                  onRowSelect={(row) => setSelectedRowId(row.noteId)}
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
            </div>
            {selectedRow && (
              <DatabaseSidePeek
                row={selectedRow}
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
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center py-8">
            <div className="max-w-md space-y-3 text-center">
              <Database className="mx-auto size-8 text-muted-foreground" />
              <h2 className="text-lg font-semibold">{t("databaseWorkspace.placeholderTitle")}</h2>
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
      <DatabaseViewDialog
        open={viewDialogOpen}
        onOpenChange={setViewDialogOpen}
        mode={viewDialogMode}
        viewName={viewName}
        onViewNameChange={setViewName}
        viewLayout={viewLayout}
        onViewLayoutChange={setViewLayout}
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
      <RollupConfigDialog
        property={rollupConfigProperty}
        database={database ?? undefined}
        databases={databases}
        vaultGeneration={vaultGeneration}
        onClose={() => setRollupConfigProperty(null)}
        onSaved={async () => {
          await Promise.allSettled([onCatalogChanged?.(), retry()])
        }}
      />
      <RelationConfigDialog
        open={Boolean(relationConfigProperty)}
        onOpenChange={(open) => {
          if (!open) setRelationConfigProperty(null)
        }}
        currentDatabaseId={databaseId}
        currentDatabaseTitle={title}
        propertyName={relationConfigProperty?.name || ""}
        databases={databases}
        initialTargetDatabaseId={(() => {
          if (!relationConfigProperty) return undefined
          try {
            return (
              JSON.parse(relationConfigProperty.configJson) as {
                targetDatabaseId?: string
              }
            ).targetDatabaseId
          } catch {
            return undefined
          }
        })()}
        initialMaxItems={(() => {
          if (!relationConfigProperty) return null
          try {
            return (
              (
                JSON.parse(relationConfigProperty.configJson) as {
                  maxItems?: number | null
                }
              ).maxItems ?? null
            )
          } catch {
            return null
          }
        })()}
        initialTwoWay={(() => {
          if (!relationConfigProperty) return false
          try {
            return Boolean(
              (
                JSON.parse(relationConfigProperty.configJson) as {
                  inversePropertyId?: string
                }
              ).inversePropertyId,
            )
          } catch {
            return false
          }
        })()}
        initialInversePropertyName={title}
        isSaving={mutationBusy}
        onSave={async (config) => {
          if (!relationConfigProperty || vaultGeneration === null || !database?.manifestRevision)
            return
          setMutationBusy(true)
          setMutationError(null)
          try {
            const currentRelationTargetDatabaseId = relationTargetFromConfig(
              relationConfigProperty.configJson,
              true,
            )
            const operationId = createDatabaseOperationId(
              "schema",
              `${databaseId}-${relationConfigProperty.propertyId}`,
            )
            const relatedManifestRevisions = await expectedRelatedManifestRevisions(
              databaseId,
              t("databaseWorkspace.notFound"),
              currentRelationTargetDatabaseId,
              config.targetDatabaseId,
            )
            const changed = await changeDatabasePropertyType({
              expectedGeneration: vaultGeneration,
              databaseId,
              propertyId: relationConfigProperty.propertyId,
              expectedManifestRevision: database.manifestRevision,
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
            setRelationConfigProperty(null)
            await Promise.allSettled([onCatalogChanged?.(), retry()])
            if (changed.warnings.length) setMutationError(changed.warnings.join("; "))
          } catch (error) {
            setMutationError(error instanceof Error ? error.message : String(error))
          } finally {
            setMutationBusy(false)
          }
        }}
      />

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
  )
}

function onCreateRowAvailable(locked: boolean | undefined, generation: number | null) {
  return !locked && generation !== null
}
