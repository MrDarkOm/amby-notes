import * as React from "react"
import {
  ArrowDownUp,
  BarChart3,
  Check,
  ChevronDown,
  Copy,
  Database,
  Eye,
  EyeOff,
  FileText,
  Filter,
  Kanban,
  Layers,
  LayoutGrid,
  Link,
  List,
  Lock,
  Maximize2,
  Palette,
  Pencil,
  Plus,
  Redo2,
  Search,
  Settings2,
  SlidersHorizontal,
  Table2,
  Trash2,
  Undo2,
  Unlock,
  X,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { motionTransitions } from "@/lib/motion-config"
import { cn } from "@/lib/utils"
import {
  applyDatabaseValueBatch,
  updateDatabaseRelationValue,
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
  queryDatabase,
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
import { ChartView } from "./chart-view"
import { RelationConfigDialog } from "./relation-config-dialog"
import type { DatabaseHostKind } from "./database-store"
import { useDocStore, type Document } from "../use-doc-store"
import { EmojiPickerPanel } from "../tiptap/EmojiPickerPanel"
import { IconValue } from "../icon-value"
import { normalizeDatabaseIcon } from "./database-icon"
import { useViewStateStore } from "../use-view-state-store"
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ToolbarButton } from "../canvas/canvas-toolbar"

const PeekDocumentEditor = React.lazy(() =>
  import("../document-editor").then((module) => ({ default: module.DocumentEditor })),
)

function getViewLayoutIcon(layout: string) {
  switch (layout) {
    case "board":
      return Kanban
    case "gallery":
      return LayoutGrid
    case "list":
      return List
    case "chart":
      return BarChart3
    default:
      return Table2
  }
}

function DatabaseToolbarButton({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="size-8 p-0 text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground"
          aria-label={label}
          title={label}
        >
          {icon}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

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
  const [filterValues, setFilterValues] = React.useState<Record<string, string>>({})
  const [sortValue, setSortValue] = React.useState<{
    key: string
    direction: "asc" | "desc"
  } | null>(null)
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
  const [relationTargetDatabaseId, setRelationTargetDatabaseId] = React.useState(databaseId)
  const [relationMaxItems, setRelationMaxItems] = React.useState<number | null>(null)
  const [relationTwoWay, setRelationTwoWay] = React.useState(false)
  const [relationInversePropertyName, setRelationInversePropertyName] = React.useState("")
  const [relationSelfDual, setRelationSelfDual] = React.useState(true)
  const [relationConfigProperty, setRelationConfigProperty] =
    React.useState<DatabasePropertySummary | null>(null)
  const [relationOptionsByProperty, setRelationOptionsByProperty] = React.useState<
    Record<string, Array<{ noteId: string; title: string; icon?: string | null }>>
  >({})
  const [mutationBusy, setMutationBusy] = React.useState(false)
  const [mutationError, setMutationError] = React.useState<string | null>(null)
  const [pendingCells, setPendingCells] = React.useState<Set<string>>(new Set())
  const [cellErrors, setCellErrors] = React.useState<Record<string, string>>({})
  const rowQueues = React.useRef(new Map<string, Promise<void>>())
  const revisionOverrides = React.useRef(new Map<string, string>())
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

  const [hiddenPropertiesByView, setHiddenPropertiesByView] = React.useState<
    Record<string, string[]>
  >(() => {
    try {
      const raw = localStorage.getItem("amby:db-view-hidden-properties")
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  })

  const activeHiddenPropertyIds = React.useMemo(() => {
    if (!activeView) return new Set<string>()
    const list = hiddenPropertiesByView[`${databaseId}:${activeView.viewId}`] ?? []
    return new Set<string>(list)
  }, [activeView, databaseId, hiddenPropertiesByView])

  const setViewHiddenPropertyIds = React.useCallback(
    (
      targetViewId: string,
      ids: Set<string> | string[] | ((current: Set<string>) => Set<string>),
    ) => {
      setHiddenPropertiesByView((current) => {
        const key = `${databaseId}:${targetViewId}`
        const currentIds = new Set(current[key] ?? [])
        const nextIds = typeof ids === "function" ? ids(currentIds) : ids
        const arr = Array.from(nextIds)
        const next = { ...current, [key]: arr }
        try {
          localStorage.setItem("amby:db-view-hidden-properties", JSON.stringify(next))
        } catch {
          // Ignore
        }
        return next
      })
    },
    [databaseId],
  )

  const togglePropertyVisibility = React.useCallback(
    (propertyId: string) => {
      if (!activeView) return
      setViewHiddenPropertyIds(activeView.viewId, (currentSet) => {
        const next = new Set(currentSet)
        if (next.has(propertyId)) next.delete(propertyId)
        else next.add(propertyId)
        return next
      })
    },
    [activeView, setViewHiddenPropertyIds],
  )

  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const propertyTypes = React.useMemo(() => {
    const map: Record<string, string> = { title: "text" }
    if (database?.properties) {
      for (const p of database.properties) {
        map[p.propertyId] = p.propertyType
      }
    }
    return map
  }, [database?.properties])

  const {
    host: queriedHost,
    loadNextPage,
    retry,
  } = useDatabaseQuery({
    databaseId,
    vaultGeneration,
    enabled: Boolean(runtime?.enabled) && catalogStatus === "ready" && Boolean(database),
    viewId,
    hostKind,
    hostId,
    search: searchQuery,
    filterValues,
    propertyTypes,
    sortValue,
  })
  const activeHost = queriedHost

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
  React.useEffect(() => {
    setSearchQuery("")
    setFilterValues({})
    setSearchOpen(false)
    setSortValue(null)
  }, [databaseId])

  // Search and sorting are backend query inputs. Never filter or reorder only
  // the currently loaded page: doing so makes page counts and distant rows
  // incorrect on large databases.
  const displayRows = activeHost?.rows ?? []

  const relationTargets = React.useMemo(
    () =>
      (database?.properties ?? [])
        .filter((property) => property.propertyType === "relation")
        .map((property) => {
          try {
            const config = JSON.parse(property.configJson) as { targetDatabaseId?: unknown }
            return {
              propertyId: property.propertyId,
              databaseId:
                typeof config.targetDatabaseId === "string" ? config.targetDatabaseId : databaseId,
            }
          } catch {
            return { propertyId: property.propertyId, databaseId }
          }
        }),
    [database?.properties, databaseId],
  )

  React.useEffect(() => {
    if (vaultGeneration === null || !runtime?.enabled || !relationTargets.length) {
      setRelationOptionsByProperty({})
      return
    }
    let cancelled = false
    void Promise.all(
      [...new Set(relationTargets.map((target) => target.databaseId))].map(
        async (targetDatabaseId) => {
          const result = await queryDatabase({
            expectedGeneration: vaultGeneration,
            databaseId: targetDatabaseId,
            source: {
              kind: "inline",
              spec: {
                sorts: [
                  { field: { kind: "system", field: "title" }, direction: "asc", nulls: "last" },
                ],
              },
            },
            page: { limit: 100 },
          })
          return [
            targetDatabaseId,
            result.rows.map((row) => ({
              noteId: row.noteId,
              title: row.title,
              icon: useViewStateStore.getState().iconOverrides[row.noteId] ?? null,
            })),
          ] as const
        },
      ),
    )
      .then((results) => {
        if (cancelled) return
        const byDatabaseId = Object.fromEntries(results)
        setRelationOptionsByProperty(
          Object.fromEntries(
            relationTargets.map((target) => [
              target.propertyId,
              byDatabaseId[target.databaseId] ?? [],
            ]),
          ),
        )
      })
      .catch(() => {
        if (!cancelled) setRelationOptionsByProperty({})
      })
    return () => {
      cancelled = true
    }
  }, [relationTargets, runtime?.enabled, vaultGeneration])

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
        } else if (viewName.trim() !== current.title) {
          await renameDatabaseView({
            expectedGeneration: currentGeneration,
            databaseId: targetDatabaseId,
            viewId: viewDialogViewId,
            expectedViewRevision: current.revision,
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
        setViewDialogOpen(false)
        await refreshDatabaseViews(viewDialogViewId)
      }
    } catch (error) {
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
          await refreshDatabaseViews(duplicate.viewId)
        } else if (action === "default") {
          await setDefaultDatabaseView({
            expectedGeneration: currentGeneration,
            databaseId: targetDatabaseId,
            viewId: target.viewId,
            expectedViewRevision: target.revision,
            expectedManifestRevision: database.manifestRevision,
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
          const fallback = database.views.find((view) => view.viewId !== target.viewId)?.viewId
          await refreshDatabaseViews(fallback)
        }
      } catch (error) {
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

  const selectedRow = displayRows.find((row) => row.noteId === selectedRowId) ?? null
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
    setMutationBusy(true)
    setMutationError(null)
    try {
      const isSelfRelation = relationTargetDatabaseId === databaseId
      const twoWay = isSelfRelation ? relationSelfDual : relationTwoWay
      const created = await createDatabaseProperty({
        expectedGeneration: currentGeneration,
        databaseId,
        expectedManifestRevision: database.manifestRevision,
        name: propertyName.trim(),
        propertyType,
        formulaExpression: propertyType === "formula" ? formulaExpression : undefined,
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
      setPropertyName("")
      setPropertyType("text")
      setFormulaExpression("0")
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
      setMutationError(error instanceof Error ? error.message : String(error))
    } finally {
      setMutationBusy(false)
    }
  }, [
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
        const changed = await changeDatabasePropertyType({
          expectedGeneration: vaultGeneration,
          databaseId,
          propertyId,
          expectedManifestRevision: database.manifestRevision,
          propertyType: nextPropertyType,
          relationTargetDatabaseId: nextRelationTargetDatabaseId,
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
        setMutationError(error instanceof Error ? error.message : String(error))
      }
    },
    [database, databaseId, isDatabaseLocked, onCatalogChanged, retry, vaultGeneration],
  )

  const commitCell = React.useCallback(
    (row: DatabaseRow, property: DatabasePropertySummary, valueJson?: string) => {
      const cellKey = `${row.noteId}:${property.propertyId}`
      const prior = rowQueues.current.get(row.noteId) ?? Promise.resolve()
      setPendingCells((current) => new Set(current).add(cellKey))
      setCellErrors((current) => {
        const next = { ...current }
        delete next[cellKey]
        return next
      })
      const task = prior
        .catch(() => {})
        .then(async () => {
          if (vaultGeneration === null) return
          if (property.propertyType === "relation") {
            let targetNoteIds: string[] = []
            if (valueJson) {
              try {
                const parsed = JSON.parse(valueJson) as { targetNoteIds?: string[] }
                if (Array.isArray(parsed.targetNoteIds)) {
                  targetNoteIds = parsed.targetNoteIds
                }
              } catch {
                // ignore
              }
            }
            const result = await updateDatabaseRelationValue({
              expectedGeneration: vaultGeneration,
              databaseId,
              noteId: row.noteId,
              propertyId: property.propertyId,
              targetNoteIds,
            })
            if (result.warnings.length) setMutationError(result.warnings.join("; "))
            await retry()
            void refreshHistoryStatus()
          } else {
            const result = await applyDatabaseValueBatch({
              expectedGeneration: vaultGeneration,
              databaseId,
              operationId:
                typeof crypto !== "undefined" && "randomUUID" in crypto
                  ? `cell-${crypto.randomUUID()}`
                  : `cell-${Date.now()}-${row.noteId}-${property.propertyId}`,
              cells: [
                {
                  noteId: row.noteId,
                  propertyId: property.propertyId,
                  valueJson,
                  expectedRevision: revisionOverrides.current.get(row.noteId) ?? row.rowRevision,
                },
              ],
            })
            const revision = result.revisions.find((item) => item.noteId === row.noteId)?.revision
            if (revision) revisionOverrides.current.set(row.noteId, revision)
            if (result.warnings.length) setMutationError(result.warnings.join("; "))
            await retry()
            void refreshHistoryStatus()
          }
        })
        .catch(async (error) => {
          revisionOverrides.current.delete(row.noteId)
          setCellErrors((current) => ({
            ...current,
            [cellKey]: error instanceof Error ? error.message : String(error),
          }))
          await retry()
        })
        .finally(() => {
          setPendingCells((current) => {
            const next = new Set(current)
            next.delete(cellKey)
            return next
          })
          if (rowQueues.current.get(row.noteId) === task) rowQueues.current.delete(row.noteId)
        })
      rowQueues.current.set(row.noteId, task)
      return task
    },
    [databaseId, refreshHistoryStatus, retry, vaultGeneration],
  )

  const handleCreateRelationRow = React.useCallback(
    async (targetDatabaseId: string, rowTitleText: string): Promise<string | void> => {
      if (vaultGeneration === null || !rowTitleText.trim() || mutationBusy) return
      setMutationBusy(true)
      setMutationError(null)
      try {
        const created = await createDatabaseRow({
          expectedGeneration: vaultGeneration,
          databaseId: targetDatabaseId,
          title: rowTitleText.trim(),
          template: { kind: "empty" },
        })
        await Promise.allSettled([onCatalogChanged?.(), retry()])
        return created.noteId
      } catch (error) {
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
      let values: unknown
      try {
        values = JSON.parse(row.valuesJson)
      } catch {
        throw new Error(t("databaseBoard.invalidValues"))
      }
      const current =
        values && typeof values === "object"
          ? (values as Record<string, unknown>)[groupField.propertyId]
          : null
      const typed =
        current && typeof current === "object" ? (current as Record<string, unknown>) : null
      if (!typed || (typed.type !== "select" && typed.type !== "status")) {
        throw new Error(t("databaseBoard.unsupportedValue"))
      }
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
    [databaseId, refreshHistoryStatus, retry, selectedView?.groupField, t, vaultGeneration],
  )

  const chartCategory = React.useMemo(() => {
    const property = database?.properties.find(
      (candidate) => candidate.propertyType === "select" || candidate.propertyType === "status",
    )
    return property ? { kind: "property" as const, propertyId: property.propertyId } : undefined
  }, [database?.properties])

  if (catalogStatus === "ready" && !database) {
    return (
      <section className="relative flex min-h-0 min-w-0 w-full flex-1 flex-col items-center justify-center gap-3 overflow-hidden bg-white p-8 text-center text-muted-foreground dark:bg-background">
        <Database className="size-10 stroke-1 text-muted-foreground/60" />
        <p className="text-sm font-medium">{t("databaseWorkspace.notFound")}</p>
      </section>
    )
  }

  return (
    <section className="relative flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden bg-white text-slate-900 dark:bg-background dark:text-foreground">
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
            const ActiveViewLayoutIcon = activeView ? getViewLayoutIcon(activeView.layout) : Table2
            const allProperties = database?.properties ?? []
            const visiblePropertiesCount = allProperties.filter(
              (prop) => !activeHiddenPropertyIds.has(prop.propertyId),
            ).length

            const settingsMenuContent = (
              <DropdownMenuContent align="end" className="w-60">
                {/* 1. (Новая, Шаблоны, Поиск) - only in compact mode */}
                {isCompactToolbar && (
                  <>
                    <DropdownMenuItem
                      disabled={isDatabaseLocked || vaultGeneration === null}
                      onSelect={() => openRowDialog({ kind: "default" })}
                    >
                      <Plus className="size-4" />
                      <span className="flex-1">{t("databaseWorkspace.newPage")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger
                        disabled={isDatabaseLocked || vaultGeneration === null}
                      >
                        <FileText className="size-4" />
                        <span className="flex-1">{t("databaseWorkspace.templates")}</span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-56">
                        <DropdownMenuItem onSelect={() => openRowDialog({ kind: "default" })}>
                          <Database className="size-4" />
                          <span>{t("databaseWorkspace.defaultTemplate")}</span>
                        </DropdownMenuItem>
                        {database?.templates.map((template) => (
                          <DropdownMenuItem
                            key={template.templateId}
                            onSelect={() =>
                              openRowDialog({ kind: "template", templateId: template.templateId })
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
                          <span>{t("databaseWorkspace.createTemplate")}</span>
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuItem onSelect={() => setSearchOpen((open) => !open)}>
                      {searchOpen ? <X className="size-4" /> : <Search className="size-4" />}
                      <span className="flex-1">
                        {searchOpen
                          ? t("databaseWorkspace.closeSearch")
                          : t("databaseWorkspace.search")}
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}

                {/* 2. Иконка текущего представления и Название */}
                {activeView && (
                  <DropdownMenuItem
                    onSelect={() => openRenameViewDialog(activeView)}
                    className="flex items-center gap-2 font-medium"
                  >
                    <ActiveViewLayoutIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate">{activeView.title}</span>
                    <Pencil className="size-3 text-muted-foreground opacity-60 shrink-0" />
                  </DropdownMenuItem>
                )}

                <DropdownMenuSeparator />

                {/* 3. Тип текущего представления (Раскладка) */}
                {activeView && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <ActiveViewLayoutIcon className="size-4" />
                      <span className="flex-1">{t("databaseWorkspace.layout")}</span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {t(`databaseLayouts.${activeView.layout}`)}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-48">
                      {(["table", "board", "list", "gallery", "chart"] as const).map((layout) => {
                        const LayoutIcon = getViewLayoutIcon(layout)
                        const isActive = activeView.layout === layout
                        return (
                          <DropdownMenuItem
                            key={layout}
                            disabled={isDatabaseLocked || vaultGeneration === null || mutationBusy}
                            onSelect={() => void changeActiveViewLayout(layout)}
                            className={cn(isActive && "font-medium")}
                          >
                            <LayoutIcon className="size-4 shrink-0" />
                            <span className="flex-1 truncate">
                              {t(`databaseLayouts.${layout}`)}
                            </span>
                            {isActive && <Check className="size-4 text-primary" />}
                          </DropdownMenuItem>
                        )
                      })}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}

                {/* 4. Видимые свойства */}
                {activeView && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Eye className="size-4" />
                      <span className="flex-1">{t("databaseWorkspace.propertyVisibility")}</span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {visiblePropertiesCount}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-56 max-h-80 overflow-y-auto">
                      <div className="flex items-center justify-between px-2 py-1 text-xs font-medium text-muted-foreground">
                        <span>{t("databaseWorkspace.propertyVisibility")}</span>
                        <span>
                          {visiblePropertiesCount}/{allProperties.length}
                        </span>
                      </div>
                      {allProperties.length > 1 && (
                        <>
                          <DropdownMenuItem
                            onSelect={(event) => {
                              event.preventDefault()
                              setViewHiddenPropertyIds(activeView.viewId, new Set())
                            }}
                          >
                            <Eye className="size-4" />
                            {t("databaseWorkspace.showAllProperties")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={(event) => {
                              event.preventDefault()
                              setViewHiddenPropertyIds(
                                activeView.viewId,
                                new Set(allProperties.map((property) => property.propertyId)),
                              )
                            }}
                          >
                            <EyeOff className="size-4" />
                            {t("databaseWorkspace.hideAllProperties")}
                          </DropdownMenuItem>
                        </>
                      )}
                      <DropdownMenuSeparator />
                      {allProperties.map((property) => {
                        const isVisible = !activeHiddenPropertyIds.has(property.propertyId)
                        return (
                          <DropdownMenuItem
                            key={property.propertyId}
                            onSelect={(e) => {
                              e.preventDefault()
                              togglePropertyVisibility(property.propertyId)
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
                      {allProperties.length === 0 && (
                        <DropdownMenuItem disabled>
                          {t("databaseWorkspace.noProperties")}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={
                          isDatabaseLocked ||
                          (vaultGeneration === null &&
                            useDatabaseStore.getState().vaultGeneration === null)
                        }
                        onSelect={() => {
                          setMutationError(null)
                          setPropertyInsertBeforeId(undefined)
                          setRelationTargetDatabaseId(databaseId)
                          setPropertyDialogOpen(true)
                        }}
                      >
                        <Plus className="size-4" />
                        <span>{t("databaseWorkspace.addProperty")}</span>
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}

                {/* 5. Фильтр */}
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Filter className="size-4" />
                    <span className="flex-1">{t("databaseWorkspace.filter")}</span>
                    {Object.keys(filterValues).length > 0 && (
                      <span className="ml-auto rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        {Object.keys(filterValues).length}
                      </span>
                    )}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-56">
                    <DropdownMenuLabel>{t("databaseWorkspace.filter")}</DropdownMenuLabel>
                    {Object.entries(filterValues).map(([key, value]) => {
                      const property =
                        key === "title"
                          ? { name: titleColumnName ?? t("databaseTable.title") }
                          : database?.properties.find((candidate) => candidate.propertyId === key)
                      return (
                        <DropdownMenuItem
                          key={key}
                          onSelect={() =>
                            setFilterValues((current) => {
                              const next = { ...current }
                              delete next[key]
                              return next
                            })
                          }
                        >
                          <span className="min-w-0 flex-1 truncate">{property?.name ?? key}</span>
                          <span className="max-w-24 truncate text-muted-foreground">{value}</span>
                          <X className="ml-1 size-3 text-muted-foreground" />
                        </DropdownMenuItem>
                      )
                    })}
                    {Object.keys(filterValues).length === 0 ? (
                      <DropdownMenuItem disabled>
                        {t("databaseWorkspace.noFilters")}
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onSelect={() => setFilterValues({})}>
                        {t("databaseTable.clearFilter")}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>

                {/* 6. Сортировка */}
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <ArrowDownUp className="size-4" />
                    <span className="flex-1">{t("databaseWorkspace.sort")}</span>
                    {sortValue && <span className="ml-auto text-xs text-primary">✓</span>}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-56">
                    <DropdownMenuLabel>{t("databaseWorkspace.sort")}</DropdownMenuLabel>
                    <DropdownMenuItem
                      onSelect={() => setSortValue({ key: "title", direction: "asc" })}
                    >
                      {t("databaseWorkspace.sortAscending")}
                      {sortValue?.key === "title" && sortValue.direction === "asc" && (
                        <span className="ml-auto text-primary">✓</span>
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => setSortValue({ key: "title", direction: "desc" })}
                    >
                      {t("databaseWorkspace.sortDescending")}
                      {sortValue?.key === "title" && sortValue.direction === "desc" && (
                        <span className="ml-auto text-primary">✓</span>
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!sortValue} onSelect={() => setSortValue(null)}>
                      {t("databaseTable.clearSort")}
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>

                {/* 7. Группировать (Заглушка) */}
                <DropdownMenuItem disabled className="opacity-60 cursor-not-allowed">
                  <Layers className="size-4" />
                  <span className="flex-1">{t("databaseWorkspace.group")}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {t("databaseWorkspace.comingSoon")}
                  </span>
                </DropdownMenuItem>

                {/* 8. Цвета (Заглушка) */}
                <DropdownMenuItem disabled className="opacity-60 cursor-not-allowed">
                  <Palette className="size-4" />
                  <span className="flex-1">{t("databaseWorkspace.conditionalColor")}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {t("databaseWorkspace.comingSoon")}
                  </span>
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                {/* 9. Копировать ссылку на представление */}
                {activeView && (
                  <DropdownMenuItem onSelect={() => void copyLinkToView()}>
                    {isLinkCopied ? (
                      <>
                        <Check className="size-4 text-primary" />
                        <span className="flex-1 text-primary">
                          {t("databaseWorkspace.linkCopied")}
                        </span>
                      </>
                    ) : (
                      <>
                        <Link className="size-4" />
                        <span>{t("databaseWorkspace.copyLinkToView")}</span>
                      </>
                    )}
                  </DropdownMenuItem>
                )}

                {/* 10. Заблокировать базу (Заглушка) */}
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault()
                    handleToggleLock()
                  }}
                >
                  {isDatabaseLocked ? (
                    <>
                      <Lock className="size-4 text-amber-600 dark:text-amber-500" />
                      <span className="flex-1">{t("databaseWorkspace.unlockDatabase")}</span>
                      <Check className="size-4 text-primary" />
                    </>
                  ) : (
                    <>
                      <Unlock className="size-4" />
                      <span className="flex-1">{t("databaseWorkspace.lockDatabase")}</span>
                    </>
                  )}
                </DropdownMenuItem>

                {/* Duplicate / Delete view */}
                {activeView && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={isDatabaseLocked || vaultGeneration === null || mutationBusy}
                      onSelect={() => void mutateView("duplicate", activeView.viewId)}
                    >
                      <Copy className="size-4" />
                      <span>{t("databaseWorkspace.duplicateView")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      disabled={
                        isDatabaseLocked ||
                        vaultGeneration === null ||
                        mutationBusy ||
                        (database?.views.length ?? 0) <= 1
                      }
                      onSelect={() => void mutateView("delete", activeView.viewId)}
                    >
                      <Trash2 className="size-4" />
                      <span>{t("databaseWorkspace.deleteView")}</span>
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            )

            return (
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
                        {(Object.keys(filterValues).length > 0 || sortValue !== null) && (
                          <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                        )}
                      </Button>
                    </DropdownMenuTrigger>
                    {settingsMenuContent}
                  </DropdownMenu>
                ) : (
                  <>
                    <DatabaseToolbarButton
                      icon={<Filter className="size-4" />}
                      label={t("databaseWorkspace.filter")}
                    >
                      <DropdownMenuLabel>{t("databaseWorkspace.filter")}</DropdownMenuLabel>
                      {Object.entries(filterValues).map(([key, value]) => {
                        const property =
                          key === "title"
                            ? { name: titleColumnName ?? t("databaseTable.title") }
                            : database?.properties.find((candidate) => candidate.propertyId === key)
                        return (
                          <DropdownMenuItem
                            key={key}
                            onSelect={() =>
                              setFilterValues((current) => {
                                const next = { ...current }
                                delete next[key]
                                return next
                              })
                            }
                          >
                            <span className="min-w-0 flex-1 truncate">{property?.name ?? key}</span>
                            <span className="max-w-24 truncate text-muted-foreground">{value}</span>
                            <X className="ml-1 size-3 text-muted-foreground" />
                          </DropdownMenuItem>
                        )
                      })}
                      {Object.keys(filterValues).length === 0 ? (
                        <DropdownMenuItem disabled>
                          {t("databaseWorkspace.noFilters")}
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onSelect={() => setFilterValues({})}>
                          {t("databaseTable.clearFilter")}
                        </DropdownMenuItem>
                      )}
                    </DatabaseToolbarButton>
                    <DatabaseToolbarButton
                      icon={<ArrowDownUp className="size-4" />}
                      label={t("databaseWorkspace.sort")}
                    >
                      <DropdownMenuLabel>{t("databaseWorkspace.sort")}</DropdownMenuLabel>
                      <DropdownMenuItem
                        onSelect={() => setSortValue({ key: "title", direction: "asc" })}
                      >
                        {t("databaseWorkspace.sortAscending")}
                        {sortValue?.key === "title" && sortValue.direction === "asc" && (
                          <span className="ml-auto text-primary">✓</span>
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => setSortValue({ key: "title", direction: "desc" })}
                      >
                        {t("databaseWorkspace.sortDescending")}
                        {sortValue?.key === "title" && sortValue.direction === "desc" && (
                          <span className="ml-auto text-primary">✓</span>
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={!sortValue} onSelect={() => setSortValue(null)}>
                        {t("databaseTable.clearSort")}
                      </DropdownMenuItem>
                    </DatabaseToolbarButton>
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
                          <DropdownMenuLabel>{t("databaseWorkspace.templates")}</DropdownMenuLabel>
                          <DropdownMenuItem onSelect={() => openRowDialog({ kind: "default" })}>
                            <Database className="size-4" />
                            {t("databaseWorkspace.defaultTemplate")}
                          </DropdownMenuItem>
                          {database?.templates.map((template) => (
                            <DropdownMenuItem
                              key={template.templateId}
                              onSelect={() =>
                                openRowDialog({ kind: "template", templateId: template.templateId })
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
            <div className="flex min-w-0 flex-1 overflow-hidden rounded-xl bg-white dark:bg-card">
              {selectedView?.layout === "chart" && viewId ? (
                <ChartView
                  databaseId={databaseId}
                  viewId={viewId}
                  expectedGeneration={vaultGeneration}
                  enabled={Boolean(runtime?.enabled) && catalogStatus === "ready"}
                  category={chartCategory}
                />
              ) : selectedView?.layout === "list" ? (
                <ListView
                  rows={displayRows}
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
                  loading={activeHost.status === "loading"}
                  error={activeHost.error}
                  hasNextPage={Boolean(activeHost.nextCursor)}
                  onLoadNextPage={loadNextPage}
                  onRetry={retry}
                  onRowSelect={(row) => setSelectedRowId(row.noteId)}
                />
              ) : selectedView?.layout === "board" ? (
                <BoardView
                  rows={displayRows}
                  groupField={selectedView.groupField}
                  loading={activeHost.status === "loading"}
                  error={activeHost.error}
                  hasNextPage={Boolean(activeHost.nextCursor)}
                  onLoadNextPage={loadNextPage}
                  onRetry={retry}
                  onRowSelect={(row) => setSelectedRowId(row.noteId)}
                  onMoveRow={moveRowToGroup}
                />
              ) : (
                <TableView
                  databaseId={databaseId}
                  rows={displayRows}
                  properties={database?.properties ?? EMPTY_PROPERTIES}
                  relationOptionsByProperty={relationOptionsByProperty}
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
                  filterValues={filterValues}
                  onFilterValuesChange={setFilterValues}
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
      <Dialog open={viewDialogOpen} onOpenChange={setViewDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {viewDialogMode === "create"
                ? t("databaseWorkspace.viewCreate")
                : viewDialogMode === "edit"
                  ? t("databaseWorkspace.editView")
                  : t("databaseWorkspace.renameView")}
            </DialogTitle>
            <DialogDescription>{t("databaseWorkspace.views")}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={viewName}
            placeholder={t("databaseWorkspace.viewNamePlaceholder")}
            aria-label={t("databaseWorkspace.viewName")}
            onChange={(event) => setViewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveViewDialog()
            }}
          />
          {(viewDialogMode === "create" || viewDialogMode === "edit") && (
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>{t("databaseWorkspace.viewLayout")}</span>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={viewLayout}
                onChange={(event) =>
                  setViewLayout(
                    event.target.value as "table" | "board" | "list" | "gallery" | "chart",
                  )
                }
              >
                {(["table", "board", "list", "gallery", "chart"] as const).map((layout) => (
                  <option key={layout} value={layout}>
                    {t(`databaseLayouts.${layout}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {mutationError && <p className="text-xs text-destructive">{mutationError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!viewName.trim() || mutationBusy}
              onClick={() => void saveViewDialog()}
            >
              {viewDialogMode === "create" ? t("common.create") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={rowDialogOpen} onOpenChange={setRowDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("databaseWorkspace.newPage")}</DialogTitle>
            <DialogDescription>{t("databaseWorkspace.newPageDescription")}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={rowTitle}
            placeholder={t("databaseWorkspace.pageTitle")}
            aria-label={t("databaseWorkspace.pageTitle")}
            onChange={(event) => setRowTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createRow()
            }}
          />
          {mutationError && <p className="text-xs text-destructive">{mutationError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRowDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={!rowTitle.trim() || mutationBusy} onClick={() => void createRow()}>
              {t("common.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={propertyDialogOpen}
        onOpenChange={(open) => {
          setPropertyDialogOpen(open)
          if (!open) setPropertyInsertBeforeId(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("databaseWorkspace.addProperty")}</DialogTitle>
            <DialogDescription>{t("databaseWorkspace.addPropertyDescription")}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={propertyName}
            placeholder={t("databaseWorkspace.propertyName")}
            aria-label={t("databaseWorkspace.propertyName")}
            onChange={(event) => setPropertyName(event.target.value)}
          />
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>{t("databaseWorkspace.propertyType")}</span>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={propertyType}
              onChange={(event) => setPropertyType(event.target.value)}
            >
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
              ].map((type) => (
                <option key={type} value={type}>
                  {t(`databaseWorkspace.propertyTypes.${type}`)}
                </option>
              ))}
            </select>
          </label>
          {propertyType === "formula" && (
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>{t("databaseWorkspace.formulaExpression")}</span>
              <Input
                value={formulaExpression}
                placeholder={t("databaseWorkspace.formulaExpressionHint")}
                aria-label={t("databaseWorkspace.formulaExpression")}
                onChange={(event) => setFormulaExpression(event.target.value)}
              />
            </label>
          )}
          {propertyType === "relation" && (
            <div className="space-y-3 pt-1">
              <label className="space-y-1 text-xs text-muted-foreground block">
                <span>{t("databaseWorkspace.relationTarget")}</span>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={relationTargetDatabaseId}
                  onChange={(event) => {
                    const nextId = event.target.value
                    setRelationTargetDatabaseId(nextId)
                    if (!relationInversePropertyName) {
                      setRelationInversePropertyName(title || "Related")
                    }
                  }}
                >
                  {databases.map((candidate) => (
                    <option key={candidate.databaseId} value={candidate.databaseId}>
                      {candidate.title}{" "}
                      {candidate.databaseId === databaseId
                        ? `(${t("databaseWorkspace.relationSelfSingle")})`
                        : ""}
                    </option>
                  ))}
                </select>
              </label>

              {/* Limit */}
              <div className="space-y-1.5">
                <span className="text-xs text-muted-foreground block">
                  {t("databaseWorkspace.relationLimit")}
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    className={`flex items-center justify-center rounded-md border px-3 py-1.5 text-xs ${
                      relationMaxItems === null
                        ? "border-primary bg-primary/10 text-primary font-semibold"
                        : "border-input bg-background text-muted-foreground hover:bg-accent/50"
                    }`}
                    onClick={() => setRelationMaxItems(null)}
                  >
                    {t("databaseWorkspace.relationLimitNoLimit")}
                  </button>
                  <button
                    type="button"
                    className={`flex items-center justify-center rounded-md border px-3 py-1.5 text-xs ${
                      relationMaxItems === 1
                        ? "border-primary bg-primary/10 text-primary font-semibold"
                        : "border-input bg-background text-muted-foreground hover:bg-accent/50"
                    }`}
                    onClick={() => setRelationMaxItems(1)}
                  >
                    {t("databaseWorkspace.relationLimitSingle")}
                  </button>
                </div>
              </div>

              {/* Two-way relation */}
              {relationTargetDatabaseId === databaseId ? (
                <div className="space-y-2 rounded-lg border border-border/80 bg-muted/20 p-2.5">
                  <span className="text-xs font-medium text-foreground block">
                    {t("databaseWorkspace.relationSelfDirection")}
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      className={`rounded-md border p-2 text-left text-xs ${
                        relationSelfDual
                          ? "border-primary bg-primary/10 text-primary font-semibold"
                          : "border-input bg-background text-muted-foreground hover:bg-accent/50"
                      }`}
                      onClick={() => setRelationSelfDual(true)}
                    >
                      <div>{t("databaseWorkspace.relationSelfDual")}</div>
                    </button>
                    <button
                      type="button"
                      className={`rounded-md border p-2 text-left text-xs ${
                        !relationSelfDual
                          ? "border-primary bg-primary/10 text-primary font-semibold"
                          : "border-input bg-background text-muted-foreground hover:bg-accent/50"
                      }`}
                      onClick={() => setRelationSelfDual(false)}
                    >
                      <div>{t("databaseWorkspace.relationSelfSingle")}</div>
                    </button>
                  </div>
                  {relationSelfDual && (
                    <label className="space-y-1 text-xs text-muted-foreground block pt-1">
                      <span>{t("databaseWorkspace.relationTwoWayTargetName")}</span>
                      <Input
                        value={relationInversePropertyName}
                        placeholder={t("databaseWorkspace.relationSelfDual")}
                        onChange={(e) => setRelationInversePropertyName(e.target.value)}
                      />
                    </label>
                  )}
                </div>
              ) : (
                <div className="space-y-2 rounded-lg border border-border/80 bg-muted/20 p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground">
                      {t("databaseWorkspace.relationTwoWay")}
                    </span>
                    <Switch checked={relationTwoWay} onCheckedChange={setRelationTwoWay} />
                  </div>
                  {relationTwoWay && (
                    <label className="space-y-1 text-xs text-muted-foreground block pt-1">
                      <span>{t("databaseWorkspace.relationTwoWayTargetName")}</span>
                      <Input
                        value={relationInversePropertyName}
                        placeholder={title || t("databaseWorkspace.relationTarget")}
                        onChange={(e) => setRelationInversePropertyName(e.target.value)}
                      />
                    </label>
                  )}
                </div>
              )}
            </div>
          )}
          {mutationError && <p className="text-xs text-destructive">{mutationError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPropertyDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!propertyName.trim() || mutationBusy}
              onClick={() => void createProperty()}
            >
              {t("common.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
            const changed = await changeDatabasePropertyType({
              expectedGeneration: vaultGeneration,
              databaseId,
              propertyId: relationConfigProperty.propertyId,
              expectedManifestRevision: database.manifestRevision,
              propertyType: "relation",
              relationTargetDatabaseId: config.targetDatabaseId,
              relationMaxItems: config.maxItems,
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

      {/* Floating Area Controls widget (Notes & Canvas benchmark style) */}
      <div className="pointer-events-none absolute bottom-2 right-4 z-10 select-none max-w-[calc(100%-2rem)]">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl border border-border/80 bg-card/90 p-1 shadow-md backdrop-blur-md">
          {/* Statistics: Row count & Property count */}
          <div className="flex items-center px-1.5 text-[11px] text-muted-foreground select-none">
            <span>
              {t("databaseWorkspace.rowsCount", {
                count: activeHost?.totalCount ?? displayRows.length,
              })}
            </span>
            <span className="mx-1.5 text-border/80">·</span>
            <span>
              {t("databaseWorkspace.propertiesCount", {
                count: database?.properties.length ?? 0,
              })}
            </span>
          </div>

          {/* Undo & Redo (Only shown in edit mode) */}
          {!isDatabaseLocked && (
            <>
              <div className="mx-0.5 h-3.5 w-px bg-border/80" />
              <ToolbarButton
                title={t("docEditor.undo")}
                disabled={!historyStatus.canUndo}
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleUndo}
              >
                <Undo2 className="size-3.5" />
              </ToolbarButton>
              <ToolbarButton
                title={t("docEditor.redo")}
                disabled={!historyStatus.canRedo}
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleRedo}
              >
                <Redo2 className="size-3.5" />
              </ToolbarButton>
            </>
          )}

          <div className="mx-0.5 h-3.5 w-px bg-border/80" />

          {/* Lock Toggle Button */}
          <ToolbarButton
            title={isDatabaseLocked ? t("docEditor.editMode") : t("docEditor.viewMode")}
            active={isDatabaseLocked}
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleToggleLock}
          >
            {isDatabaseLocked ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}
          </ToolbarButton>

          {/* Settings Popover */}
          {onContentWidthChange ? (
            <>
              <div className="mx-0.5 h-3.5 w-px bg-border/80" />
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    title={t("common.settings")}
                    onMouseDown={(e) => e.preventDefault()}
                    className="flex size-7 items-center justify-center rounded-lg text-foreground hover:bg-accent hover:text-accent-foreground select-none"
                  >
                    <Settings2 className="size-3.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="end"
                  sideOffset={13}
                  alignOffset={-5}
                  className="w-64 rounded-xl border border-border/80 bg-popover/95 p-3 text-foreground shadow-lg backdrop-blur-md"
                >
                  <div className="flex flex-col gap-3">
                    <span className="text-xs font-semibold text-foreground">
                      {t("common.settings")}
                    </span>
                    <div className="flex flex-col gap-1.5">
                      <span className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
                        <Maximize2 className="size-3 text-muted-foreground" />
                        {t("settings.editor.contentWidth")}
                      </span>
                      <div className="grid grid-cols-3 gap-1 rounded-lg border border-border/70 bg-muted/40 p-0.5">
                        {(["normal", "wide", "full"] as const).map((width) => (
                          <button
                            key={width}
                            type="button"
                            onClick={() => onContentWidthChange(width)}
                            className={cn(
                              "rounded-md py-1 text-center text-xs font-medium",
                              contentWidth === width
                                ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                            )}
                          >
                            {width === "full" ? "100%" : t(`settings.editor.${width}`)}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function onCreateRowAvailable(locked: boolean | undefined, generation: number | null) {
  return !locked && generation !== null
}

interface PeekRowEditorProps {
  row: DatabaseRow
  vault?: string
  onLoad: (row: DatabaseRow) => Promise<Document>
  onContentChange?: (fileId: string, content: string) => void
}

function PeekRowEditor({ row, vault, onLoad, onContentChange }: PeekRowEditorProps) {
  const { t } = useTranslation()
  const document = useDocStore((state) => state.openDocs[row.noteId] ?? null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    setError(null)
    void onLoad(row).catch((loadError) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError))
    })
    return () => {
      cancelled = true
    }
  }, [onLoad, row])

  if (error) return <p className="p-4 text-xs text-destructive">{error}</p>
  if (!document) {
    return <p className="p-4 text-xs text-muted-foreground">{t("databasePeek.loading")}</p>
  }
  return (
    <React.Suspense
      fallback={<p className="p-4 text-xs text-muted-foreground">{t("databasePeek.loading")}</p>}
    >
      <PeekDocumentEditor
        document={document}
        vault={vault}
        hideNavigation
        editorSurfaceOwner="databasePeek"
        onContentChange={(content, sourceDocumentId) =>
          onContentChange?.(sourceDocumentId, content)
        }
      />
    </React.Suspense>
  )
}
