"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { ArrowDownUp, Filter, Maximize2, Plus, Search, SlidersHorizontal, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  applyDatabaseValueBatch,
  createDatabaseRow,
  getDatabaseNoteContext,
  getFileRevision,
  updateDatabaseRelationValue,
  type DatabaseFieldRef,
  type DatabasePropertySummary,
  type DatabaseRow,
  type DatabaseSummary,
  type DatabaseViewSummary,
} from "@/lib/storage"
import { BoardLanesView } from "./board-lanes-view"
import type { GroupDisplay } from "./layouts/board-model"
import type { CardCellEdit } from "./database-value-cell"
import { openDatabaseFromEmbed, openNoteFromDatabase } from "./database-navigation"
import { useDatabaseStore } from "./database-store"
import type { DatabaseViewChoice } from "./database-view-picker-model"
import { QueryPanelButton } from "./database-view-menu"
import {
  combineFilters,
  currentPageFilter,
  currentPageRelations,
  hasOtherConditions,
  pageRelationCandidates,
  EMBED_AUTO_MAX_HEIGHT,
  EMBED_MIN_HEIGHT,
  EMBED_LAYOUTS,
  type EmbedLayout,
} from "./embedded-view-model"
import { BoardView, GalleryView, ListView } from "./layouts"
import type { LinkedView } from "./linked-block"
import { PickerPopover, LinkedViewExtras, PageFilterField } from "./linked-view-controls"
import { placeNewRecordInLane } from "./new-record-lane"
import { TableView } from "./table-view"
import { applyManualOrder } from "./row-order"
import { useLocalView } from "./use-local-view"
import { createDatabaseOperationId, usePropertyMutation } from "./use-property-mutation"
import { referenceTitles, relationTargetIds, useRecordReferences } from "./use-record-references"
import { useDatabaseQuery } from "./use-database-query"
import { useViewSettingsDerived } from "./use-view-query-state"
import { ViewFilterEditor } from "./view-filter-editor"
import { ViewSettingsPanel } from "./view-settings-panel"
import { ViewSortEditor } from "./view-sort-editor"
import { conditionsToFilter } from "./view-config"
import { viewLabel } from "./linked-block"
import { toQueryFilter } from "./view-config"

const EMPTY_PROPERTIES: DatabasePropertySummary[] = []
const EMPTY_ROWS: DatabaseRow[] = []

export interface LinkedViewPaneProps {
  view: LinkedView
  /** Every tab of the shortcut: the settings panel counts them. */
  views: LinkedView[]
  /** The page the shortcut sits on; `@currentPage` filters and new records tie to it. */
  noteId?: string
  /** False in a read-only note: nothing the shortcut stores can change. */
  editable: boolean
  /** The least height the content takes: the tallest tab seen so far. */
  minHeight: number
  /** Reports the content's height so the owner can keep it for the other tabs. */
  onContentHeight: (height: number) => void
  /** The tab strip, drawn at the start of the toolbar; it folds into a list when `collapsed`. */
  tabs: (state: { collapsed: boolean }) => React.ReactNode
  /** Changes when the view's name should take focus (Rename in the tabs' list). */
  focusNameSignal: number
  onPatchView: (patch: Partial<Omit<LinkedView, "id" | "extra">>) => void
  /** Another database (or layout) for this tab; the old settings do not carry over. */
  onChangeSource: (choice: DatabaseViewChoice) => void
  onDuplicate: () => void
  onDelete: () => void
  settingsOpen: boolean
  onSettingsOpenChange: (open: boolean) => void
}

/**
 * One tab of a shortcut: the toolbar of a database view (filter, sort, search,
 * settings, New) over the view itself. The view's settings are the tab's own copy
 * and the values are the database's, edited in place like in the database tab.
 */
export function LinkedViewPane({
  view,
  views,
  noteId,
  editable,
  tabs,
  focusNameSignal,
  minHeight,
  onContentHeight,
  onPatchView,
  onChangeSource,
  onDuplicate,
  onDelete,
  settingsOpen,
  onSettingsOpenChange,
}: LinkedViewPaneProps) {
  const { t } = useTranslation()
  const hostId = React.useId()
  const runtime = useDatabaseStore((state) => state.runtime)
  const catalogStatus = useDatabaseStore((state) => state.catalogStatus)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const databases = useDatabaseStore((state) => state.databases)
  const database = databases.find((candidate) => candidate.databaseId === view.databaseId)

  const [search, setSearch] = React.useState("")
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [queryPanel, setQueryPanel] = React.useState<"filter" | "sort" | null>(null)
  const [requestedFilterField, setRequestedFilterField] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [pageDatabaseId, setPageDatabaseId] = React.useState<string | null>(null)
  // Like the database tab: with too little room the tools fold into the settings
  // panel and only the tabs and one settings button stay.
  const contentRef = React.useRef<HTMLDivElement>(null)
  const toolbarRef = React.useRef<HTMLDivElement>(null)
  const actionsRef = React.useRef<HTMLDivElement>(null)
  const expandedActionsWidth = React.useRef(280)
  // The tabs' width when drawn in full; folded tabs have no strip to measure.
  const tabsNaturalWidth = React.useRef(0)
  const [narrow, setNarrow] = React.useState(false)
  const narrowRef = React.useRef(narrow)
  narrowRef.current = narrow
  const compact = editable && narrow
  const collapsedTabs = narrow
  const hasDatabase = Boolean(database)
  const moduleEnabled = Boolean(runtime?.enabled)
  const contentHeightRef = React.useRef(onContentHeight)
  contentHeightRef.current = onContentHeight
  const tabsSignature = views.map((candidate) => `${candidate.id}:${candidate.title}`).join("|")
  // Other tabs, other widths: draw them in full once to measure them again.
  React.useLayoutEffect(() => {
    tabsNaturalWidth.current = 0
    setNarrow(false)
  }, [tabsSignature])
  React.useLayoutEffect(() => {
    const bar = toolbarRef.current
    if (!bar) return
    const measure = () => {
      // Nothing to fit into before the toolbar has a width (not laid out yet).
      if (bar.clientWidth === 0) return
      if (!narrowRef.current && actionsRef.current) {
        const width = actionsRef.current.offsetWidth
        if (width > 60) expandedActionsWidth.current = width
      }
      const tabList = bar.querySelector<HTMLElement>('[role="tablist"]')
      if (tabList) tabsNaturalWidth.current = tabList.scrollWidth
      const needed = tabsNaturalWidth.current + 44 + expandedActionsWidth.current + 16
      setNarrow((previous) => (previous ? bar.clientWidth < needed + 24 : bar.clientWidth < needed))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [tabsSignature, narrow, editable, hasDatabase, moduleEnabled])
  React.useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    const report = () => contentHeightRef.current(content.offsetHeight)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(content)
    return () => observer.disconnect()
  }, [hasDatabase, moduleEnabled])

  const localView = useLocalView(
    view.config,
    React.useCallback((config) => onPatchView({ config }), [onPatchView]),
  )
  const {
    viewSettings: settings,
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
    querySorts,
    queryManualOrder,
  } = useViewSettingsDerived({ savedView: localView, viewId: view.id })

  const filter = React.useMemo(
    () => combineFilters(settings.filter, view.pageFilter),
    [settings.filter, view.pageFilter],
  )
  const queryFilter = React.useMemo(() => toQueryFilter(filter), [filter])
  const groupField = React.useMemo<DatabaseFieldRef | null>(
    () => (settings.groupBy ? { kind: "property", propertyId: settings.groupBy } : null),
    [settings.groupBy],
  )
  const layout: EmbedLayout = view.layout
  const groupDisplay = React.useMemo(
    () => ({
      sort: settings.groupSort,
      order: settings.groupOrder,
      hidden: settings.hiddenGroups,
      hideEmpty: settings.hideEmptyGroups,
    }),
    [settings.groupSort, settings.groupOrder, settings.hiddenGroups, settings.hideEmptyGroups],
  )

  React.useEffect(() => {
    let cancelled = false
    if (!noteId) {
      setPageDatabaseId(null)
      return
    }
    void getDatabaseNoteContext(noteId)
      .then((context) => !cancelled && setPageDatabaseId(context?.databaseId ?? null))
      .catch(() => !cancelled && setPageDatabaseId(null))
    return () => {
      cancelled = true
    }
  }, [noteId])

  const enabled = Boolean(runtime?.enabled) && catalogStatus === "ready" && Boolean(database)
  const { host, retry, loadNextPage } = useDatabaseQuery({
    databaseId: view.databaseId,
    viewId: view.id,
    hostKind: "block",
    hostId,
    vaultGeneration,
    enabled,
    search,
    filter: queryFilter,
    sorts: querySorts,
    manualOrder: queryManualOrder,
    contextPageId: noteId,
  })
  const rows = React.useMemo(() => {
    const loaded = host?.rows ?? EMPTY_ROWS
    return queryManualOrder ? applyManualOrder(loaded, queryManualOrder) : loaded
  }, [host?.rows, queryManualOrder])
  const properties = database?.properties ?? EMPTY_PROPERTIES
  // Cards show the properties the view shows.
  const cardFields = React.useMemo(
    () =>
      properties
        .filter((property) => !activeHiddenPropertyIds.has(property.propertyId))
        .map((property) => property.propertyId),
    [properties, activeHiddenPropertyIds],
  )
  const relationReferences = useRecordReferences(
    React.useMemo(() => relationTargetIds(rows.map((row) => row.valuesJson)), [rows]),
  )
  const relationTitles = React.useMemo(
    () => referenceTitles(relationReferences),
    [relationReferences],
  )
  const mutation = usePropertyMutation({
    databaseId: view.databaseId,
    vaultGeneration,
    onSettled: () => retry(),
  })

  const cardEdit = React.useMemo<CardCellEdit | undefined>(
    () =>
      editable && !database?.locked
        ? {
            onCommit: mutation.commit,
            pendingCells: mutation.pendingCells,
            cellErrors: mutation.cellErrors,
            onOpenNote: openNoteFromDatabase,
          }
        : undefined,
    [database?.locked, editable, mutation.cellErrors, mutation.commit, mutation.pendingCells],
  )

  const pageRelations = React.useMemo(
    () => pageRelationCandidates(properties, pageDatabaseId, view.databaseId),
    [pageDatabaseId, properties, view.databaseId],
  )
  const tiedRelations = React.useMemo(() => currentPageRelations(filter), [filter])
  const ownTied = currentPageRelations(combineFilters(null, view.pageFilter))[0] ?? ""

  // A card dropped on another column writes the column's option into the group property.
  const moveRowToGroup = React.useCallback(
    async (row: DatabaseRow, laneKey: string) => {
      if (!groupField || groupField.kind !== "property" || vaultGeneration === null) return
      const groupProperty = properties.find(
        (candidate) => candidate.propertyId === groupField.propertyId,
      )
      if (
        !groupProperty ||
        (groupProperty.propertyType !== "select" && groupProperty.propertyType !== "status")
      ) {
        throw new Error(t("databaseBoard.unsupportedValue"))
      }
      await applyDatabaseValueBatch({
        expectedGeneration: vaultGeneration,
        databaseId: view.databaseId,
        operationId: `board-${Date.now()}-${row.noteId}`,
        cells: [
          {
            noteId: row.noteId,
            propertyId: groupField.propertyId,
            valueJson:
              laneKey === "__empty__"
                ? undefined
                : JSON.stringify({ type: groupProperty.propertyType, optionId: laneKey }),
            expectedRevision: row.rowRevision,
          },
        ],
      })
      retry()
    },
    [groupField, properties, retry, t, vaultGeneration, view.databaseId],
  )

  // Settings and the filter/sort editor are both popovers: the second opens once
  // the first has closed, or it would be dismissed by the first one's focus change.
  function openQueryPanel(panel: "filter" | "sort") {
    onSettingsOpenChange(false)
    window.setTimeout(() => setQueryPanel(panel), 60)
  }

  async function createRecord(laneKey?: string) {
    if (vaultGeneration === null || creating) return
    setCreating(true)
    setNotice(null)
    try {
      const created = await createDatabaseRow({
        expectedGeneration: vaultGeneration,
        databaseId: view.databaseId,
        title: t("databaseEmbed.newTitle"),
        template: { kind: "empty" },
      })
      // A page added from a board lane belongs to that lane.
      const groupProperty =
        laneKey && groupField?.kind === "property"
          ? properties.find((candidate) => candidate.propertyId === groupField.propertyId)
          : undefined
      if (laneKey && groupProperty) {
        await placeNewRecordInLane({
          vaultGeneration,
          databaseId: view.databaseId,
          created,
          groupProperty,
          laneKey,
        })
      }
      let linkFailure: string | null = null
      if (noteId && tiedRelations.length > 0) {
        try {
          for (const propertyId of tiedRelations) {
            await updateDatabaseRelationValue({
              expectedGeneration: vaultGeneration,
              operationId: createDatabaseOperationId(
                "embed-link",
                `${created.noteId}-${propertyId}`,
              ),
              databaseId: view.databaseId,
              noteId: created.noteId,
              propertyId,
              targetNoteIds: [noteId],
              expectedRevision: await getFileRevision(created.notePath),
            })
          }
        } catch (failure) {
          linkFailure = failure instanceof Error ? failure.message : String(failure)
        }
      }
      setNotice(
        linkFailure
          ? t("databaseEmbed.linkFailed", { message: linkFailure })
          : tiedRelations.length > 0
            ? hasOtherConditions(filter)
              ? t("databaseEmbed.mayBeHidden")
              : t("databaseEmbed.created")
            : null,
      )
      useDatabaseStore.getState().invalidateHosts()
    } catch (failure) {
      setNotice(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setCreating(false)
    }
  }

  const rootRef = React.useRef<HTMLDivElement>(null)
  const shell = (children: React.ReactNode) => (
    <div
      ref={rootRef}
      className="amby-database-host group/embed relative my-2 max-w-full text-foreground"
      style={{ width: "100%" }}
    >
      {children}
    </div>
  )

  if (!runtime?.enabled || catalogStatus !== "ready") {
    return shell(
      <>
        <div className="flex items-center gap-2 py-1">{tabs({ collapsed: false })}</div>
        <p className="px-3 py-4 text-xs text-muted-foreground">
          {t("databaseLinkedView.unavailable")}
        </p>
      </>,
    )
  }
  if (!database) {
    return shell(
      <>
        <div className="flex items-center gap-2 py-1">{tabs({ collapsed: false })}</div>
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">{t("databaseLinkedView.missing")}</span>
          {editable && (
            <PickerPopover onChoose={onChangeSource} align="end">
              <Button variant="outline" size="sm" className="h-7 px-2 text-xs">
                {t("databaseEmbed.chooseSource")}
              </Button>
            </PickerPopover>
          )}
        </div>
      </>,
    )
  }

  const loading = host?.status === "loading"
  const common = {
    rows,
    loading: Boolean(loading),
    error: host?.error ?? null,
    hasNextPage: Boolean(host?.nextCursor),
    onLoadNextPage: () => void loadNextPage(),
    onRetry: retry,
  }
  const open = (row: DatabaseRow) => openNoteFromDatabase(row.noteId)
  const canCreate = editable && !database.locked && vaultGeneration !== null
  const title = viewLabel(view, database.title)

  // The panel's own idea of "the database's views" is this shortcut's tabs.
  const panelDatabase: DatabaseSummary = {
    ...database,
    views: views.map((candidate) => ({
      viewId: candidate.id,
      title: viewLabel(candidate, database.title),
      layout: candidate.layout,
      revision: "",
      groupField: null,
    })),
  }
  const activeView: DatabaseViewSummary = {
    viewId: view.id,
    title,
    layout,
    revision: "",
    groupField,
  }

  return shell(
    <>
      <div ref={toolbarRef} className="flex items-center gap-2 py-1">
        {tabs({ collapsed: collapsedTabs })}
        <Popover
          open={queryPanel !== null}
          onOpenChange={(next) => {
            if (!next) setQueryPanel(null)
          }}
        >
          <PopoverAnchor asChild>
            <div ref={actionsRef} className="ml-auto flex shrink-0 items-center gap-1">
              {editable && !compact && (
                <>
                  <QueryPanelButton
                    icon={<Filter className="size-4" />}
                    label={t("databaseWorkspace.filter")}
                    count={filterCount + (ownTied ? 1 : 0)}
                    active={queryPanel === "filter"}
                    onClick={() =>
                      setQueryPanel((current) => (current === "filter" ? null : "filter"))
                    }
                  />
                  <QueryPanelButton
                    icon={<ArrowDownUp className="size-4" />}
                    label={t("databaseWorkspace.sort")}
                    count={settings.sorts.length}
                    active={queryPanel === "sort"}
                    onClick={() => setQueryPanel((current) => (current === "sort" ? null : "sort"))}
                  />
                </>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-foreground"
                title={t("databaseWorkspace.search")}
                aria-label={t("databaseWorkspace.search")}
                aria-pressed={searchOpen}
                onClick={() => {
                  if (searchOpen) setSearch("")
                  setSearchOpen((current) => !current)
                }}
              >
                {searchOpen ? <X className="size-4" /> : <Search className="size-4" />}
              </Button>
              {!compact && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-foreground"
                  title={t("databaseEmbed.open")}
                  aria-label={t("databaseEmbed.open")}
                  onClick={() => openDatabaseFromEmbed(view.databaseId, database.title)}
                >
                  <Maximize2 className="size-4" />
                </Button>
              )}
              {editable && (
                <Popover open={settingsOpen} onOpenChange={onSettingsOpenChange}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="relative text-muted-foreground hover:text-foreground"
                      title={t("databaseWorkspace.settings")}
                      aria-label={t("databaseWorkspace.settings")}
                      aria-pressed={settingsOpen}
                    >
                      <SlidersHorizontal className="size-4" />
                      {compact &&
                        (filterCount > 0 || ownTied !== "" || settings.sorts.length > 0) && (
                          <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />
                        )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    sideOffset={6}
                    className="w-auto border-0 bg-transparent p-0 shadow-none"
                    // The next panel takes focus; the trigger must not take it back.
                    onCloseAutoFocus={(event) => event.preventDefault()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <ViewSettingsPanel
                      variant="inline"
                      focusNameSignal={focusNameSignal}
                      isCompactToolbar={compact}
                      isDatabaseLocked={false}
                      vaultGeneration={vaultGeneration}
                      activeView={activeView}
                      database={panelDatabase}
                      mutationBusy={false}
                      searchOpen={searchOpen}
                      activeHiddenPropertyIds={activeHiddenPropertyIds}
                      cardSize={settings.cardSize}
                      openMode={settings.openMode}
                      onCardSizeChange={(cardSize) => updateViewSettings({ cardSize })}
                      groupPropertyId={settings.groupBy}
                      onGroupPropertyChange={(groupBy) => updateViewSettings({ groupBy })}
                      coverVisible={settings.coverVisible}
                      onCoverVisibleChange={(coverVisible) => updateViewSettings({ coverVisible })}
                      colorColumns={settings.colorColumns}
                      onColorColumnsChange={(colorColumns) => updateViewSettings({ colorColumns })}
                      groupSort={settings.groupSort}
                      onGroupSortChange={(groupSort) => updateViewSettings({ groupSort })}
                      hideEmptyGroups={settings.hideEmptyGroups}
                      onHideEmptyGroupsChange={(hideEmptyGroups) =>
                        updateViewSettings({ hideEmptyGroups })
                      }
                      groupOrder={settings.groupOrder}
                      onGroupOrderChange={(groupOrder) =>
                        updateViewSettings({ groupOrder, groupSort: "manual" })
                      }
                      hiddenGroups={settings.hiddenGroups}
                      onHiddenGroupsChange={(hiddenGroups) => updateViewSettings({ hiddenGroups })}
                      filterCount={filterCount + (ownTied ? 1 : 0)}
                      sortCount={settings.sorts.length}
                      onOpenFilter={() => openQueryPanel("filter")}
                      onOpenSort={() => openQueryPanel("sort")}
                      openRowDialog={() => void createRecord()}
                      viewIcon={view.icon}
                      onViewIconChange={(icon) => onPatchView({ icon: icon || undefined })}
                      onRenameView={(name) => onPatchView({ title: name.trim() })}
                      layouts={EMBED_LAYOUTS}
                      changeActiveViewLayout={(next) => {
                        if ((EMBED_LAYOUTS as readonly string[]).includes(next)) {
                          onPatchView({ layout: next as EmbedLayout })
                        }
                      }}
                      setViewHiddenPropertyIds={setViewHiddenPropertyIds}
                      togglePropertyVisibility={togglePropertyVisibility}
                      mutateView={(action) => (action === "duplicate" ? onDuplicate() : onDelete())}
                      onOpenDatabase={() => openDatabaseFromEmbed(view.databaseId, database.title)}
                      extra={
                        <LinkedViewExtras database={database} onChooseSource={onChangeSource} />
                      }
                      onClose={() => onSettingsOpenChange(false)}
                    />
                  </PopoverContent>
                </Popover>
              )}
              {canCreate && !compact && (
                <Button
                  size="sm"
                  className="ml-2 h-8 gap-1 rounded-md px-3 text-xs shadow-sm"
                  disabled={creating}
                  onClick={() => void createRecord()}
                >
                  <Plus className="size-4" />
                  {t("databaseWorkspace.newPageButton")}
                </Button>
              )}
            </div>
          </PopoverAnchor>
          <PopoverContent
            align="end"
            className="w-[28rem] max-w-[calc(100vw-2rem)] p-3"
            aria-label={queryPanel === "sort" ? t("databaseSort.title") : t("databaseFilter.title")}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {queryPanel === "filter" && (
              <div className="space-y-3">
                <ViewFilterEditor
                  conditions={savedConditions ?? []}
                  complex={savedConditions === null}
                  properties={properties}
                  titleName={t("databaseTable.title")}
                  requestedField={requestedFilterField}
                  onRequestedFieldHandled={() => setRequestedFilterField(null)}
                  onChange={(conditions) =>
                    updateViewSettings({ filter: conditionsToFilter(conditions) })
                  }
                  onResetComplex={() => updateViewSettings({ filter: null })}
                />
                <PageFilterField
                  pageRelations={pageRelations}
                  pageFilterProperty={ownTied}
                  onPageFilterChange={(propertyId) =>
                    onPatchView({
                      pageFilter: propertyId ? currentPageFilter(propertyId) : undefined,
                    })
                  }
                />
              </div>
            )}
            {queryPanel === "sort" && (
              <ViewSortEditor
                sorts={settings.sorts}
                properties={properties}
                titleName={t("databaseTable.title")}
                onChange={(sorts) => updateViewSettings({ sorts })}
              />
            )}
          </PopoverContent>
        </Popover>
      </div>

      {searchOpen && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-1">
          <Search className="size-4 text-muted-foreground" />
          <Input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder={t("databaseWorkspace.searchPlaceholder")}
            aria-label={t("databaseWorkspace.search")}
            className="h-8 max-w-sm border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
          />
        </div>
      )}
      {notice && (
        <p
          role="status"
          className="mb-2 rounded-lg bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground"
        >
          {notice}
        </p>
      )}

      <div
        ref={contentRef}
        className="flex min-h-0 flex-col"
        style={{
          minHeight: Math.max(EMBED_MIN_HEIGHT, minHeight),
          maxHeight: EMBED_AUTO_MAX_HEIGHT,
        }}
      >
        {layout === "board" && groupField?.kind === "property" ? (
          <BoardHostLayout
            databaseId={view.databaseId}
            groupPropertyId={groupField.propertyId}
            properties={properties}
            relationTitles={relationTitles}
            cardFields={cardFields}
            cardEdit={cardEdit}
            filter={queryFilter}
            sorts={querySorts}
            search={search}
            contextPageId={noteId}
            enabled={enabled}
            onRowSelect={open}
            onMoveRow={moveRowToGroup}
            colorColumns={settings.colorColumns}
            groupDisplay={groupDisplay}
            onCreateCard={canCreate ? (laneKey) => createRecord(laneKey) : undefined}
          />
        ) : layout === "board" ? (
          <BoardView
            {...common}
            properties={properties}
            relationTitles={relationTitles}
            cardFields={cardFields}
            cardEdit={cardEdit}
            groupField={groupField}
            onRowSelect={open}
            onCreateCard={canCreate ? () => void createRecord() : undefined}
          />
        ) : layout === "list" ? (
          <ListView
            {...common}
            properties={properties}
            relationTitles={relationTitles}
            cardFields={cardFields}
            cardEdit={cardEdit}
            onRowSelect={open}
            onCreateCard={canCreate ? () => void createRecord() : undefined}
          />
        ) : layout === "gallery" ? (
          <GalleryView
            {...common}
            properties={properties}
            relationTitles={relationTitles}
            databaseId={view.databaseId}
            vaultGeneration={vaultGeneration}
            cardFields={cardFields}
            cardEdit={cardEdit}
            cardSize={settings.cardSize}
            coverVisible={settings.coverVisible}
            onRowSelect={open}
            onCreateCard={canCreate ? () => void createRecord() : undefined}
          />
        ) : (
          <TableView
            {...common}
            databaseId={view.databaseId}
            properties={properties}
            databases={databases}
            pendingCells={mutation.pendingCells}
            cellErrors={mutation.cellErrors}
            onCellCommit={
              editable ? (row, property, value) => mutation.commit(row, property, value) : undefined
            }
            filteredFieldKeys={filteredFieldKeys}
            onFilterColumn={
              editable
                ? (key) => {
                    setRequestedFilterField(key)
                    setQueryPanel("filter")
                  }
                : undefined
            }
            sortValue={sortValue}
            onSortValueChange={editable ? setSortValue : undefined}
            onCreateRow={canCreate ? () => void createRecord() : undefined}
            newPageLabel={t("databaseWorkspace.newPage")}
            hiddenPropertyIds={activeHiddenPropertyIds}
            onHiddenPropertyIdsChange={
              editable ? (next) => setViewHiddenPropertyIds(view.id, next) : undefined
            }
            savedSettings={tableSavedSettings}
            onSavedSettingsChange={editable ? updateViewSettings : undefined}
            onRowSelect={open}
            onOpenNote={openNoteFromDatabase}
          />
        )}
      </div>
    </>,
  )
}

function BoardHostLayout(props: {
  databaseId: string
  groupPropertyId: string
  properties: DatabasePropertySummary[]
  relationTitles: Record<string, string>
  cardFields: string[] | null
  cardEdit?: CardCellEdit
  filter: ReturnType<typeof toQueryFilter>
  sorts: ReturnType<typeof import("./view-config").toQuerySorts>
  search: string
  contextPageId?: string
  enabled: boolean
  onRowSelect: (row: DatabaseRow) => void
  onMoveRow: (row: DatabaseRow, laneKey: string) => Promise<void>
  onCreateCard?: (laneKey: string) => void | Promise<void>
  colorColumns: boolean
  groupDisplay: GroupDisplay
}) {
  const groupProperty = props.properties.find(
    (property) => property.propertyId === props.groupPropertyId,
  )
  if (
    !groupProperty ||
    (groupProperty.propertyType !== "select" && groupProperty.propertyType !== "status")
  ) {
    return null
  }
  return (
    <BoardLanesView
      databaseId={props.databaseId}
      groupProperty={groupProperty}
      properties={props.properties}
      relationTitles={props.relationTitles}
      cardFields={props.cardFields}
      cardEdit={props.cardEdit}
      filter={props.filter}
      sorts={props.sorts}
      search={props.search}
      contextPageId={props.contextPageId}
      enabled={props.enabled}
      onRowSelect={props.onRowSelect}
      onMoveRow={props.onMoveRow}
      onCreateCard={props.onCreateCard}
      colorColumns={props.colorColumns}
      groupDisplay={props.groupDisplay}
    />
  )
}
