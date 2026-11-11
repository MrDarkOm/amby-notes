import type { RenameOutcome } from "../file-actions/rename-outcome"
import { EMPTY_ROWS } from "./empty-collections"
import { DatabaseTitleHeader } from "./database-title-header"
import { DatabaseSettingsToggle } from "./database-settings-toggle"
import { DatabaseViewTabs } from "./database-view-tabs"
import { DatabaseToolbarActions } from "./database-toolbar-actions"
import { DatabaseViewContent } from "./database-view-content"
import { DatabaseSettingsOverlay } from "./database-settings-overlay"
import * as React from "react"

import { Database, Search, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import i18n from "@/lib/i18n"

import { Button } from "@/components/ui/button"

import { Input } from "@/components/ui/input"

import { cn } from "@/lib/utils"
import { type DatabaseRow, type CreatedDatabaseRow } from "@/lib/storage"
import { useDatabaseStore } from "./database-store"
import { useDatabaseQuery } from "./use-database-query"

import { useViewQueryState } from "./use-view-query-state"

import { SortResetDialog } from "./sort-reset-dialog"
import { applyManualOrder } from "./row-order"
import { type DatabaseRowActions } from "./use-row-menu"

import { OptionActionsProvider } from "./option-actions"

import { usePropertyMutation } from "./use-property-mutation"
import { referenceTitles, relationTargetIds, useRecordReferences } from "./use-record-references"

import type { DatabaseHostKind } from "./database-store"
import type { Document } from "../use-doc-store"

import { EDITOR_CONTENT_WIDTH } from "@/lib/themes"
import type { ContentWidth } from "../app-config"

import { DatabaseViewDialog, DatabaseRowDialog, DatabasePropertyDialog } from "./database-dialogs"

import { DatabaseFloatingToolbar } from "./database-floating-toolbar"

import { ViewIcon } from "./view-icon"

import { useSelectedView } from "./use-selected-view"
import { useViewDisplayModes } from "./use-view-display-modes"
import { useToolbarLayout } from "./use-toolbar-layout"
import { useDatabaseHistory } from "./use-database-history"
import { useDatabaseTitle } from "./use-database-title"
import { useDatabaseViewActions } from "./use-database-view-actions"
import { useDatabaseRowActions } from "./use-database-row-actions"
import { useDatabasePropertyActions } from "./use-database-property-actions"
import { useViewGrouping } from "./use-view-grouping"
import { useSelectedRow } from "./use-selected-row"
import { useRowEditing } from "./use-row-editing"
import { useViewStateStore } from "../use-view-state-store"
import { warningNotices } from "@/lib/operation-errors"
import { NoticeLevelIcon, NoticeShell } from "../notices/notice-level"

interface DatabaseWorkspaceProps {
  databaseId: string
  title: string
  onOpenInNewTab: () => void
  hostKind?: DatabaseHostKind
  hostId?: string | null
  /** Only the active workspace tab consumes navigation from the database panel. */
  isNavigationTarget?: boolean
  vault?: string
  isLocked?: boolean
  onToggleLock?: () => void
  onOpenRowFullPage?: (row: DatabaseRow) => void
  onRenameRow?: (rowId: string, name: string) => Promise<RenameOutcome | void> | void
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
  /** Slot in the host's tab bar where the compact view-settings icon is placed when `hideHeader` is set. */
  toolbarHost?: HTMLElement | null
  /**
   * How the host wants a database shown the first time it shows it: a plain table becomes a
   * gallery and a view that never chose how rows open opens them as whole pages. It is written
   * to the first view once per database (remembered on this device) and never again, so what the
   * author picks afterwards stays.
   */
  initialPresentation?: { layout: "gallery"; openMode: "fullPage" }
}

/**
 * Wires the database surface together. State and actions live in the `use-*` hooks beside it
 * (views, properties, rows, title, history, grouping); the layout is in the `database-*` components.
 * `mutationBusy`/`mutationError` are shared with those hooks through their parameters.
 */
export function DatabaseWorkspace({
  databaseId,
  title,
  hostKind = "tab",
  hostId = null,
  isNavigationTarget = false,
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
  toolbarHost = null,
  initialPresentation,
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
  const { selectedViewId, setSelectedViewId } = useSelectedView({
    databaseId,
    isNavigationTarget,
    database,
  })
  const [activeViewMenuOpen, setActiveViewMenuOpen] = React.useState(false)
  const { viewDisplayModes, setViewDisplayMode } = useViewDisplayModes({ databaseId })
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState("")
  const { toolbarContainerRef, viewsMeasureRef, actionsRef, isCompactToolbar } = useToolbarLayout({
    database,
    viewDisplayModes,
  })
  const [mutationBusy, setMutationBusy] = React.useState(false)
  const [mutationError, setMutationError] = React.useState<string | null>(null)
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
  const { cardFieldIds, groupField, groupDisplay, boardGroupProperty, chartCategory } =
    useViewGrouping({
      database,
      activeHiddenPropertyIds,
      savedView,
      viewSettings,
      selectedView,
    })
  const [queryPanel, setQueryPanel] = React.useState<"filter" | "sort" | null>(null)
  const [requestedFilterField, setRequestedFilterField] = React.useState<string | null>(null)
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
      // The diagnostic's own sentence is the developer's; the person gets the dictionary text.
      if (diagnostic.code === "formulaError") {
        errors.formula ??= i18n.t("databaseErrors.computed.formula")
      }
      if (diagnostic.code === "rollupError") {
        errors.rollup ??= i18n.t("databaseErrors.computed.rollup")
      }
    }
    return errors
  }, [activeHost?.diagnostics])

  const { historyStatus, refreshHistoryStatus, handleUndo, handleRedo } = useDatabaseHistory({
    databaseId,
    database,
    isDatabaseLocked,
    retry,
    onCatalogChanged,
  })

  const {
    iconTriggerRef,
    iconPickerOpen,
    setIconPickerOpen,
    displayedDatabaseIcon,
    setDatabaseIcon,
    databaseTitle,
    setDatabaseTitle,
    editingDatabaseTitle,
    setEditingDatabaseTitle,
    commitDatabaseTitle,
    cancelDatabaseTitle,
    titleHint,
  } = useDatabaseTitle({
    title,
    icon,
    vaultGeneration,
    database,
    isDatabaseLocked,
    onRenameTitle,
    databaseId,
    onCatalogChanged,
    retry,
    setMutationError,
  })
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

  const {
    setSelectedRowId,
    setSelectedRowSnapshot,
    openRow,
    selectedRow,
    selectedRowIndex,
    selectAdjacentRow,
  } = useSelectedRow({ viewSettings, onOpenRowFullPage, setSettingsOpen, displayRows })

  const {
    mutateView,
    openCreateViewDialog,
    tabViews,
    setViewOrder,
    persistViewOrder,
    viewDialogOpen,
    setViewDialogOpen,
    viewName,
    setViewName,
    viewLayout,
    setViewLayout,
    saveViewDialog,
    isLinkCopied,
    renameActiveView,
    changeActiveViewLayout,
    copyLinkToView,
  } = useDatabaseViewActions({
    setMutationError,
    setMutationBusy,
    mutationBusy,
    onCatalogChanged,
    retry,
    setSelectedViewId,
    database,
    vaultGeneration,
    databaseId,
    isDatabaseLocked,
    activeView,
    initialPresentation,
  })

  const {
    rowDialogOpen,
    setRowDialogOpen,
    rowTitle,
    setRowTitle,
    createRow,
    openRowDialog,
    openRowDialogInLane,
    handleCreateRelationRow,
    moveRowToGroup,
  } = useDatabaseRowActions({
    databaseId,
    vaultGeneration,
    database,
    groupField,
    mutationBusy,
    setMutationBusy,
    setMutationError,
    setSelectedRowId,
    onRowCreated,
    onCatalogChanged,
    retry,
    refreshHistoryStatus,
  })

  // The view's own menu (Rename, Configure) opens the settings panel on that view; Rename also
  // puts the cursor in the view's name.
  const openViewSettings = React.useCallback(
    (targetViewId: string, focusName: boolean) => {
      setSelectedViewId(targetViewId)
      setSelectedRowId(null)
      setSettingsOpen(true)
      if (focusName) setSettingsFocusSignal((signal) => signal + 1)
    },
    [setSelectedViewId, setSelectedRowId],
  )
  const toggleSettings = React.useCallback(() => {
    setSettingsOpen((open) => {
      if (!open) setSelectedRowId(null)
      return !open
    })
  }, [setSelectedRowId])
  const {
    optionActions,
    persistPropertyName,
    persistPropertyType,
    renderPropertySettings,
    deleteProperty,
    setPropertyInsertBeforeId,
    setRelationTargetDatabaseId,
    propertyDialogOpen,
    setPropertyDialogOpen,
    propertyName,
    setPropertyName,
    propertyType,
    setPropertyType,
    formulaExpression,
    setFormulaExpression,
    relationTargetDatabaseId,
    relationInversePropertyName,
    setRelationInversePropertyName,
    relationMaxItems,
    setRelationMaxItems,
    relationSelfDual,
    setRelationSelfDual,
    relationTwoWay,
    setRelationTwoWay,
    rollupDraft,
    setRollupDraft,
    createProperty,
  } = useDatabasePropertyActions({
    databaseId,
    title,
    vaultGeneration,
    database,
    databases,
    mutationBusy,
    setMutationBusy,
    setMutationError,
    onCatalogChanged,
    retry,
    isDatabaseLocked,
  })
  const {
    commit: commitCell,
    pendingCells,
    cellErrors,
  } = usePropertyMutation({
    databaseId,
    vaultGeneration,
    onSettled: async (outcome) => {
      if (outcome.ok && outcome.result?.warnings.length) {
        setMutationError(warningNotices(outcome.result.warnings).join("; "))
      }
      await retry()
      if (outcome.ok) useDatabaseStore.getState().invalidateHosts()
      if (outcome.ok) void refreshHistoryStatus()
    },
  })

  const {
    cardEdit,
    rowMenu,
    rowReorder,
    deleteRows,
    commitPeekCell,
    sortPromptOpen,
    setSortPromptOpen,
  } = useRowEditing({
    isDatabaseLocked,
    commitCell,
    pendingCells,
    cellErrors,
    handleOpenNote,
    onRenameRow,
    retry,
    setSelectedRowSnapshot,
    database,
    databases,
    databaseId,
    handleCreateRelationRow,
    viewSettings,
    vaultGeneration,
    rowActions,
    openRow,
    setMutationError,
    displayRows,
    updateViewSettings,
  })
  if (catalogStatus === "ready" && !database) {
    return (
      <section className="relative flex min-h-0 min-w-0 w-full flex-1 flex-col items-center justify-center gap-3 overflow-hidden bg-[var(--note-surface)] p-8 text-center text-muted-foreground">
        <Database className="size-10 stroke-1 text-muted-foreground/60" />
        <p className="text-sm font-medium">{t("databaseWorkspace.notFound")}</p>
      </section>
    )
  }

  // A refusal of a dialog's own action is said in the dialog, under the field, and nowhere else
  // (docs/notices.md, section 4): the line above the table waits until the dialog is closed.
  const dialogOpen = viewDialogOpen || rowDialogOpen || propertyDialogOpen
  // Cancelling a dialog takes its refusal away with it.
  const closeDialog = (open: boolean, setOpen: (open: boolean) => void) => {
    if (!open) setMutationError(null)
    setOpen(open)
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
            <DatabaseTitleHeader
              iconTriggerRef={iconTriggerRef}
              setIconPickerOpen={setIconPickerOpen}
              displayedDatabaseIcon={displayedDatabaseIcon}
              iconPickerOpen={iconPickerOpen}
              setDatabaseIcon={setDatabaseIcon}
              onIconChange={onIconChange}
              databaseTitle={databaseTitle}
              editingDatabaseTitle={editingDatabaseTitle}
              setEditingDatabaseTitle={setEditingDatabaseTitle}
              setDatabaseTitle={setDatabaseTitle}
              commitDatabaseTitle={commitDatabaseTitle}
              cancelDatabaseTitle={cancelDatabaseTitle}
              titleHint={titleHint}
              title={title}
            />
          )}
          {hideHeader ? (
            <DatabaseSettingsToggle
              toolbarHost={toolbarHost}
              queryPanel={queryPanel}
              setQueryPanel={setQueryPanel}
              actionsRef={actionsRef}
              settingsOpen={settingsOpen}
              toggleSettings={toggleSettings}
              filterCount={filterCount}
              viewSettings={viewSettings}
              savedConditions={savedConditions}
              database={database}
              titleColumnName={titleColumnName}
              requestedFilterField={requestedFilterField}
              setRequestedFilterField={setRequestedFilterField}
              updateViewSettings={updateViewSettings}
            />
          ) : (
            <div
              ref={toolbarContainerRef}
              className="flex min-h-10 shrink-0 min-w-0 items-center justify-between gap-2 sm:gap-4 px-0 py-1"
            >
              <DatabaseViewTabs
                database={database}
                isCompactToolbar={isCompactToolbar}
                viewId={viewId}
                viewDisplayModes={viewDisplayModes}
                databaseId={databaseId}
                activeViewMenuOpen={activeViewMenuOpen}
                setActiveViewMenuOpen={setActiveViewMenuOpen}
                setSelectedViewId={setSelectedViewId}
                openViewSettings={openViewSettings}
                setViewDisplayMode={setViewDisplayMode}
                mutateView={mutateView}
                isDatabaseLocked={isDatabaseLocked}
                vaultGeneration={vaultGeneration}
                openCreateViewDialog={openCreateViewDialog}
                tabViews={tabViews}
                setViewOrder={setViewOrder}
                persistViewOrder={persistViewOrder}
              />
              <DatabaseToolbarActions
                queryPanel={queryPanel}
                setQueryPanel={setQueryPanel}
                actionsRef={actionsRef}
                isCompactToolbar={isCompactToolbar}
                searchOpen={searchOpen}
                setSearchOpen={setSearchOpen}
                settingsOpen={settingsOpen}
                toggleSettings={toggleSettings}
                filterCount={filterCount}
                viewSettings={viewSettings}
                isDatabaseLocked={isDatabaseLocked}
                vaultGeneration={vaultGeneration}
                openRowDialog={openRowDialog}
                database={database}
                savedConditions={savedConditions}
                titleColumnName={titleColumnName}
                requestedFilterField={requestedFilterField}
                setRequestedFilterField={setRequestedFilterField}
                updateViewSettings={updateViewSettings}
              />
            </div>
          )}
          {searchOpen && (
            <div className="my-1 flex shrink-0 items-center gap-2 rounded-lg bg-slate-50 px-3 py-1 dark:bg-muted/40">
              <Search className="size-4 text-slate-400 dark:text-muted-foreground" />
              <Input
                autoFocus
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setSearchQuery("")
                    if (hideHeader) setSearchOpen(false)
                  }
                }}
                placeholder={t("databaseWorkspace.searchPlaceholder")}
                aria-label={t("databaseWorkspace.search")}
                className="h-8 max-w-sm border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
              />
              {(searchQuery || hideHeader) && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={searchQuery ? undefined : t("databaseWorkspace.closeSearch")}
                  onClick={() => {
                    if (searchQuery) {
                      setSearchQuery("")
                    } else {
                      setSearchOpen(false)
                    }
                  }}
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
          )}
          {mutationError && !dialogOpen && (
            <NoticeShell
              level="warning"
              variant="calm"
              data-testid="database-notice"
              className="my-1 flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs text-foreground"
            >
              <NoticeLevelIcon level="warning" className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0">{mutationError}</span>
            </NoticeShell>
          )}
          <DatabaseViewContent
            contentAreaRef={contentAreaRef}
            viewId={viewId}
            selectedView={selectedView}
            databaseId={databaseId}
            vaultGeneration={vaultGeneration}
            queriesEnabled={queriesEnabled}
            chartCategory={chartCategory}
            queryFilter={queryFilter}
            searchQuery={searchQuery}
            displayRows={displayRows}
            cardFieldIds={cardFieldIds}
            cardEdit={cardEdit}
            database={database}
            relationTitles={relationTitles}
            activeHost={activeHost}
            loadNextPage={loadNextPage}
            retry={retry}
            openRow={openRow}
            rowMenu={rowMenu}
            rowReorder={rowReorder}
            isDatabaseLocked={isDatabaseLocked}
            openRowDialog={openRowDialog}
            boardGroupProperty={boardGroupProperty}
            viewSettings={viewSettings}
            querySorts={querySorts}
            boardEnabled={boardEnabled}
            groupDisplay={groupDisplay}
            openRowDialogInLane={openRowDialogInLane}
            moveRowToGroup={moveRowToGroup}
            groupField={groupField}
            updateViewSettings={updateViewSettings}
            databases={databases}
            handleOpenNote={handleOpenNote}
            handleCreateRelationRow={handleCreateRelationRow}
            titleColumnName={titleColumnName}
            onTitleColumnNameChange={onTitleColumnNameChange}
            onRenameProperty={onRenameProperty}
            persistPropertyName={persistPropertyName}
            persistPropertyType={persistPropertyType}
            computedErrors={computedErrors}
            renderPropertySettings={renderPropertySettings}
            onRenameRow={onRenameRow}
            filteredFieldKeys={filteredFieldKeys}
            setRequestedFilterField={setRequestedFilterField}
            setQueryPanel={setQueryPanel}
            sortValue={sortValue}
            setSortValue={setSortValue}
            pendingCells={pendingCells}
            cellErrors={cellErrors}
            commitCell={commitCell}
            deleteProperty={deleteProperty}
            deleteRows={deleteRows}
            setMutationError={setMutationError}
            setPropertyInsertBeforeId={setPropertyInsertBeforeId}
            setRelationTargetDatabaseId={setRelationTargetDatabaseId}
            setPropertyDialogOpen={setPropertyDialogOpen}
            tableSavedSettings={tableSavedSettings}
            activeHiddenPropertyIds={activeHiddenPropertyIds}
            activeView={activeView}
            setViewHiddenPropertyIds={setViewHiddenPropertyIds}
            selectedRow={selectedRow}
            commitPeekCell={commitPeekCell}
            selectedRowIndex={selectedRowIndex}
            selectAdjacentRow={selectAdjacentRow}
            setSelectedRowId={setSelectedRowId}
            onOpenRowFullPage={onOpenRowFullPage}
            onLoadRowDocument={onLoadRowDocument}
            vault={vault}
            onRowContentChange={onRowContentChange}
          />
        </div>
        <SortResetDialog
          open={sortPromptOpen}
          onOpenChange={setSortPromptOpen}
          onConfirm={() => updateViewSettings({ sorts: [] })}
        />
        <DatabaseViewDialog
          open={viewDialogOpen}
          onOpenChange={(open) => closeDialog(open, setViewDialogOpen)}
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
          onOpenChange={(open) => closeDialog(open, setRowDialogOpen)}
          rowTitle={rowTitle}
          onRowTitleChange={setRowTitle}
          mutationBusy={mutationBusy}
          mutationError={mutationError}
          onCreate={() => void createRow()}
        />
        <DatabasePropertyDialog
          open={propertyDialogOpen}
          onOpenChange={(open) => {
            closeDialog(open, setPropertyDialogOpen)
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
        <DatabaseSettingsOverlay
          settingsOpen={settingsOpen}
          settingsPanelTop={settingsPanelTop}
          settingsFocusSignal={settingsFocusSignal}
          hideHeader={hideHeader}
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
          viewSettings={viewSettings}
          setQueryPanel={setQueryPanel}
          openRowDialog={openRowDialog}
          setSearchOpen={setSearchOpen}
          setSettingsOpen={setSettingsOpen}
          setSearchQuery={setSearchQuery}
          iconOverrides={iconOverrides}
          databaseId={databaseId}
          setIcon={setIcon}
          renameActiveView={renameActiveView}
          renderPropertySettings={renderPropertySettings}
          persistPropertyName={persistPropertyName}
          persistPropertyType={persistPropertyType}
          deleteProperty={deleteProperty}
          changeActiveViewLayout={changeActiveViewLayout}
          updateViewSettings={updateViewSettings}
          groupField={groupField}
          setViewHiddenPropertyIds={setViewHiddenPropertyIds}
          togglePropertyVisibility={togglePropertyVisibility}
          setMutationError={setMutationError}
          setPropertyInsertBeforeId={setPropertyInsertBeforeId}
          setRelationTargetDatabaseId={setRelationTargetDatabaseId}
          setPropertyDialogOpen={setPropertyDialogOpen}
          copyLinkToView={copyLinkToView}
          handleToggleLock={handleToggleLock}
          mutateView={mutateView}
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
    </OptionActionsProvider>
  )
}
