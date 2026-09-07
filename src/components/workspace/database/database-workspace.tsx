import * as React from "react"
import {
  ArrowDownUp,
  ChevronDown,
  Database,
  Eye,
  FileText,
  Filter,
  LayoutGrid,
  List,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Table2,
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
import { motionTransitions } from "@/lib/motion-config"
import {
  applyDatabaseValueBatch,
  createDatabaseProperty,
  deleteDatabaseProperty,
  createDatabaseRow,
  renameDatabase,
  renameDatabaseProperty,
  resolveDatabaseYamlConflict,
  syncDatabaseYaml,
  type DatabaseYamlConflict,
  type DatabaseYamlResolution,
  type DatabaseRow,
  type DatabaseRowTemplate,
  type CreatedDatabaseRow,
  type DatabasePropertySummary,
  type DatabaseYamlSyncResult,
} from "@/lib/storage"
import { useDatabaseStore, databaseHostKey, selectDatabaseHost } from "./database-store"
import { useDatabaseQuery } from "./use-database-query"
import { TableView } from "./table-view"
import { DatabaseSidePeek } from "./peek/database-side-peek"
import { BoardView, GalleryView, ListView } from "./layouts"
import type { DatabaseHostKind } from "./database-store"
import { useDocStore, type Document } from "../use-doc-store"
import { EmojiPickerPanel } from "../tiptap/EmojiPickerPanel"
import { IconValue } from "../icon-value"
import { EDITOR_CONTENT_WIDTH } from "@/lib/themes"
import type { ContentWidth } from "../app-config"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const PeekDocumentEditor = React.lazy(() =>
  import("../document-editor").then((module) => ({ default: module.DocumentEditor })),
)

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
}

export function DatabaseWorkspace({
  databaseId,
  title,
  hostKind = "tab",
  hostId = null,
  vault,
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
}: DatabaseWorkspaceProps) {
  const { t } = useTranslation()
  const host = useDatabaseStore(
    selectDatabaseHost(databaseHostKey(hostKind, databaseId, null, hostId)),
  )
  const runtime = useDatabaseStore((state) => state.runtime)
  const catalogStatus = useDatabaseStore((state) => state.catalogStatus)
  const database = useDatabaseStore((state) =>
    state.databases.find((candidate) => candidate.databaseId === databaseId),
  )
  const [selectedViewId, setSelectedViewId] = React.useState<string | null>(null)
  const [selectedRowId, setSelectedRowId] = React.useState<string | null>(null)
  const [rowDialogOpen, setRowDialogOpen] = React.useState(false)
  const [rowTitle, setRowTitle] = React.useState("")
  const [rowTemplate, setRowTemplate] = React.useState<DatabaseRowTemplate>({ kind: "empty" })
  const [databaseTitle, setDatabaseTitle] = React.useState(title)
  const [editingDatabaseTitle, setEditingDatabaseTitle] = React.useState(false)
  const [databaseIcon, setDatabaseIcon] = React.useState(icon ?? "")
  const [iconPickerOpen, setIconPickerOpen] = React.useState(false)
  const iconTriggerRef = React.useRef<HTMLButtonElement>(null)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState("")
  const [sortDirection, setSortDirection] = React.useState<"asc" | "desc" | null>(null)
  const [propertyDialogOpen, setPropertyDialogOpen] = React.useState(false)
  const [propertyInsertBeforeId, setPropertyInsertBeforeId] = React.useState<string | undefined>()
  const [propertyName, setPropertyName] = React.useState("")
  const [propertyType, setPropertyType] = React.useState("text")
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
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const {
    host: queriedHost,
    loadNextPage,
    retry,
  } = useDatabaseQuery({
    databaseId,
    vaultGeneration,
    enabled: Boolean(runtime?.enabled) && catalogStatus === "ready",
    viewId,
    hostKind,
    hostId,
  })
  const activeHost = queriedHost ?? host
  React.useEffect(() => setDatabaseTitle(title), [title])
  React.useEffect(() => setDatabaseIcon(icon ?? ""), [icon])
  React.useEffect(() => {
    setSearchQuery("")
    setSearchOpen(false)
    setSortDirection(null)
  }, [databaseId])

  const displayRows = React.useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase()
    const filteredRows = (activeHost?.rows ?? []).filter((row) => {
      if (!query) return true
      if (
        [row.title, row.relativePath].some((value) => value.toLocaleLowerCase().includes(query))
      ) {
        return true
      }
      try {
        return row.valuesJson.toLocaleLowerCase().includes(query)
      } catch {
        return false
      }
    })
    if (!sortDirection) return filteredRows
    return [...filteredRows].sort((left, right) => {
      const comparison = left.title.localeCompare(right.title, undefined, { sensitivity: "base" })
      return sortDirection === "asc" ? comparison : -comparison
    })
  }, [activeHost?.rows, searchQuery, sortDirection])

  const persistDatabaseTitle = React.useCallback(
    async (next: string) => {
      if (vaultGeneration === null || !database?.manifestRevision || database.locked) {
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
    [database, databaseId, onCatalogChanged, onRenameTitle, retry, title, vaultGeneration],
  )

  const commitDatabaseTitle = () => {
    const next = databaseTitle.trim()
    if (next && next !== title) void persistDatabaseTitle(next)
    setEditingDatabaseTitle(false)
  }

  const openRowDialog = React.useCallback((template: DatabaseRowTemplate) => {
    setRowTemplate(template)
    setRowTitle("")
    setMutationError(null)
    setRowDialogOpen(true)
  }, [])

  const displayedDatabaseIcon = databaseIcon || database?.icon || undefined

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
    if (
      vaultGeneration === null ||
      !database?.manifestRevision ||
      !propertyName.trim() ||
      mutationBusy
    )
      return
    setMutationBusy(true)
    setMutationError(null)
    try {
      const created = await createDatabaseProperty({
        expectedGeneration: vaultGeneration,
        databaseId,
        expectedManifestRevision: database.manifestRevision,
        name: propertyName.trim(),
        propertyType,
        beforePropertyId: propertyInsertBeforeId,
      })
      setPropertyName("")
      setPropertyType("text")
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
    mutationBusy,
    onCatalogChanged,
    propertyName,
    propertyInsertBeforeId,
    propertyType,
    retry,
    vaultGeneration,
  ])

  const deleteProperty = React.useCallback(
    async (propertyId: string) => {
      if (vaultGeneration === null || !database?.manifestRevision || database.locked) return
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
    [database, databaseId, onCatalogChanged, retry, vaultGeneration],
  )

  const persistPropertyName = React.useCallback(
    async (propertyId: string, nextName: string) => {
      const property = database?.properties.find((candidate) => candidate.propertyId === propertyId)
      const name = nextName.trim()
      if (
        vaultGeneration === null ||
        !database?.manifestRevision ||
        database.locked ||
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
    [database, databaseId, onCatalogChanged, retry, vaultGeneration],
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
    [databaseId, retry, vaultGeneration],
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
    },
    [databaseId, retry, selectedView?.groupField, t, vaultGeneration],
  )

  return (
    <section className="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-white text-slate-900 dark:bg-background dark:text-foreground">
      <div
        className="mx-auto flex min-h-0 w-full flex-1 flex-col overflow-hidden px-4 sm:px-8 lg:px-10"
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
              title={t("databaseWorkspace.renameTitle")}
              className="h-8 min-w-0 w-full cursor-text border-0 bg-transparent p-0 text-2xl font-semibold leading-none tracking-tight text-foreground outline-none sm:h-10 sm:text-3xl"
            />
          </div>
        </header>
        <div className="flex min-h-10 shrink-0 items-center justify-between gap-4 px-0 py-1">
          {database && database.views.length > 0 ? (
            <nav
              aria-label={t("databaseWorkspace.views")}
              className="flex min-w-0 items-center gap-1 overflow-x-auto"
            >
              {database.views.map((view) => {
                const ViewIcon =
                  view.layout === "gallery" ? LayoutGrid : view.layout === "list" ? List : Table2
                return (
                  <button
                    key={view.viewId}
                    type="button"
                    className={`inline-flex h-8 shrink-0 items-center gap-2 rounded-full px-3 text-xs ${view.viewId === viewId ? "bg-slate-100 font-medium text-slate-900 dark:bg-accent dark:text-foreground" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-muted-foreground dark:hover:bg-accent/50 dark:hover:text-foreground"}`}
                    onClick={() => setSelectedViewId(view.viewId)}
                  >
                    <ViewIcon className="size-4" />
                    {view.title}
                  </button>
                )
              })}
            </nav>
          ) : (
            <div />
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <DatabaseToolbarButton
              icon={<Filter className="size-4" />}
              label={t("databaseWorkspace.filter")}
            >
              <DropdownMenuLabel>{t("databaseWorkspace.filter")}</DropdownMenuLabel>
              <DropdownMenuItem disabled>{t("databaseWorkspace.noFilters")}</DropdownMenuItem>
            </DatabaseToolbarButton>
            <DatabaseToolbarButton
              icon={<ArrowDownUp className="size-4" />}
              label={t("databaseWorkspace.sort")}
            >
              <DropdownMenuLabel>{t("databaseWorkspace.sort")}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setSortDirection("asc")}>
                {t("databaseWorkspace.sortAscending")}
                {sortDirection === "asc" && <span className="ml-auto text-primary">✓</span>}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSortDirection("desc")}>
                {t("databaseWorkspace.sortDescending")}
                {sortDirection === "desc" && <span className="ml-auto text-primary">✓</span>}
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
            <DatabaseToolbarButton
              icon={<SlidersHorizontal className="size-4" />}
              label={t("databaseWorkspace.display")}
            >
              <DropdownMenuLabel>{t("databaseWorkspace.display")}</DropdownMenuLabel>
              <DropdownMenuItem>
                <Eye className="size-4" />
                {t("databaseWorkspace.displayDefault")}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Settings2 className="size-4" />
                {t("databaseWorkspace.displaySettings")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("settings.editor.contentWidth")}</DropdownMenuLabel>
              {(["normal", "wide", "full"] as const).map((width) => (
                <DropdownMenuItem key={width} onSelect={() => onContentWidthChange?.(width)}>
                  <span className="flex-1">{t(`settings.editor.${width}`)}</span>
                  {contentWidth === width && <span className="text-primary">✓</span>}
                </DropdownMenuItem>
              ))}
            </DatabaseToolbarButton>
            <div className="ml-2 inline-flex items-stretch">
              <Button
                size="sm"
                className="h-8 rounded-l-md rounded-r-none bg-primary px-3 text-xs text-primary-foreground shadow-sm hover:bg-primary/90"
                disabled={database?.locked || vaultGeneration === null}
                onClick={() => openRowDialog({ kind: "default" })}
              >
                <Plus className="size-4" />
                {t("databaseWorkspace.newPage")}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-sm"
                    className="h-8 w-8 rounded-l-none rounded-r-md border-l border-primary-foreground/25 bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
                    disabled={database?.locked || vaultGeneration === null}
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
                    {t("databaseWorkspace.emptyPage")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
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
          <div className="flex min-h-0 flex-1 gap-4 px-0 pb-6 pt-2">
            <div className="flex min-w-0 flex-1 overflow-hidden rounded-xl bg-white dark:bg-card">
              {selectedView?.layout === "list" ? (
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
                  properties={database?.properties ?? []}
                  titleColumnName={titleColumnName ?? t("databaseTable.title")}
                  onTitleColumnNameChange={onTitleColumnNameChange}
                  onRenameProperty={
                    onRenameProperty ??
                    (!database?.locked && vaultGeneration !== null
                      ? persistPropertyName
                      : undefined)
                  }
                  onRenameRow={onRenameRow}
                  pendingCells={pendingCells}
                  cellErrors={cellErrors}
                  onCellCommit={commitCell}
                  onDeleteProperty={
                    database?.locked || vaultGeneration === null ? undefined : deleteProperty
                  }
                  loading={activeHost.status === "loading"}
                  error={activeHost.error}
                  hasNextPage={Boolean(activeHost.nextCursor)}
                  onLoadNextPage={loadNextPage}
                  onRetry={retry}
                  onRowSelect={(row) => setSelectedRowId(row.noteId)}
                  onAddProperty={
                    database?.locked || vaultGeneration === null
                      ? undefined
                      : (beforePropertyId) => {
                          setMutationError(null)
                          setPropertyInsertBeforeId(beforePropertyId)
                          setPropertyDialogOpen(true)
                        }
                  }
                  onCreateRow={
                    database?.locked || vaultGeneration === null
                      ? undefined
                      : () => openRowDialog({ kind: "empty" })
                  }
                  newPageLabel={t("databaseWorkspace.newPage")}
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
              {onCreateRowAvailable(database?.locked, vaultGeneration) && (
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
              {["text", "number", "checkbox", "date", "url"].map((type) => (
                <option key={type} value={type}>
                  {t(`databaseWorkspace.propertyTypes.${type}`)}
                </option>
              ))}
            </select>
          </label>
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
