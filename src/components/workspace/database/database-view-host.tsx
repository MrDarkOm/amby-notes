import * as React from "react"
import { ExternalLink, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  createDatabaseRow,
  getDatabaseNoteContext,
  type DatabasePropertySummary,
  getFileRevision,
  updateDatabaseRelationValue,
  type DatabaseRow,
} from "@/lib/storage"
import { cn } from "@/lib/utils"
import { BoardLanesView } from "./board-lanes-view"
import { openDatabaseFromEmbed, openNoteFromDatabase } from "./database-navigation"
import { useDatabaseStore } from "./database-store"
import { getViewLayoutIcon } from "./database-layout-icons"
import {
  combineFilters,
  currentPageFilter,
  currentPageRelations,
  hasOtherConditions,
  pageRelationCandidates,
} from "./embedded-view-model"
import type { DatabaseLinkedReference } from "./linked-reference"
import { BoardView, GalleryView, ListView } from "./layouts"
import { TableView } from "./table-view"
import { createDatabaseOperationId, usePropertyMutation } from "./use-property-mutation"
import { referenceTitles, relationTargetIds, useRecordReferences } from "./use-record-references"
import { useDatabaseQuery } from "./use-database-query"
import { useSavedView } from "./use-saved-view"
import { toQueryFilter, toQuerySorts } from "./view-config"

const LAYOUTS = ["table", "board", "list", "gallery"] as const
type EmbedLayout = (typeof LAYOUTS)[number]
const EMPTY_PROPERTIES: DatabasePropertySummary[] = []
const EMPTY_ROWS: DatabaseRow[] = []

interface DatabaseViewHostProps {
  reference: DatabaseLinkedReference
  /** The page the view sits on; `@currentPage` filters and new records tie to it. */
  noteId?: string
  editable: boolean
  /** Saves the embedding's own configuration (layout, page filter) into the block. */
  onReferenceChange?: (next: Partial<DatabaseLinkedReference>) => void
}

/**
 * A database view inside a note. It reads the shared saved view (layout, filter,
 * sorts, card properties) and renders it with the same layouts, cells and write
 * path as the database tab. The embedding owns only what its reference states: a
 * layout and an extra filter such as "linked to this page".
 */
export function DatabaseViewHost({
  reference,
  noteId,
  editable,
  onReferenceChange,
}: DatabaseViewHostProps) {
  const { t } = useTranslation()
  const hostId = React.useId()
  const runtime = useDatabaseStore((state) => state.runtime)
  const catalogStatus = useDatabaseStore((state) => state.catalogStatus)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const databases = useDatabaseStore((state) => state.databases)
  const database = databases.find((candidate) => candidate.databaseId === reference.databaseId)
  const view = database?.views.find((candidate) => candidate.viewId === reference.viewId)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [pageDatabaseId, setPageDatabaseId] = React.useState<string | null>(null)

  // The shared view's own settings, never written from here.
  const savedView = useSavedView({
    databaseId: reference.databaseId,
    vaultGeneration,
    view: view ? { viewId: view.viewId, revision: view.revision } : null,
    persist: false,
  })
  const settings = savedView.settings
  const filter = React.useMemo(
    () => combineFilters(settings.filter, reference.filter),
    [reference.filter, settings.filter],
  )
  const queryFilter = React.useMemo(() => toQueryFilter(filter), [filter])
  const querySorts = React.useMemo(() => toQuerySorts(settings.sorts), [settings.sorts])
  const layout: EmbedLayout = (LAYOUTS as readonly string[]).includes(
    reference.layout ?? view?.layout ?? "",
  )
    ? ((reference.layout ?? view?.layout) as EmbedLayout)
    : "table"

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

  const enabled =
    Boolean(runtime?.enabled) && catalogStatus === "ready" && Boolean(view) && savedView.ready
  const { host, retry, loadNextPage } = useDatabaseQuery({
    databaseId: reference.databaseId,
    viewId: reference.viewId,
    hostKind: "block",
    hostId,
    vaultGeneration,
    enabled,
    filter: queryFilter,
    sorts: querySorts,
    contextPageId: noteId,
  })
  const rows = host?.rows ?? EMPTY_ROWS
  const properties = database?.properties ?? EMPTY_PROPERTIES
  const relationReferences = useRecordReferences(
    React.useMemo(() => relationTargetIds(rows.map((row) => row.valuesJson)), [rows]),
  )
  const relationTitles = React.useMemo(
    () => referenceTitles(relationReferences),
    [relationReferences],
  )
  const mutation = usePropertyMutation({
    databaseId: reference.databaseId,
    vaultGeneration,
    onSettled: () => retry(),
  })

  const pageRelations = React.useMemo(
    () => pageRelationCandidates(properties, pageDatabaseId, reference.databaseId),
    [pageDatabaseId, properties, reference.databaseId],
  )
  const tiedRelations = React.useMemo(() => currentPageRelations(filter), [filter])
  const ownTied = currentPageRelations(combineFilters(null, reference.filter))[0] ?? ""

  async function createRecord() {
    if (vaultGeneration === null || creating) return
    setCreating(true)
    setNotice(null)
    try {
      const created = await createDatabaseRow({
        expectedGeneration: vaultGeneration,
        databaseId: reference.databaseId,
        title: t("databaseEmbed.newTitle"),
        template: { kind: "empty" },
      })
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
              databaseId: reference.databaseId,
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

  if (!runtime?.enabled || catalogStatus !== "ready") {
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground">
        {t("databaseLinkedView.unavailable")}
      </p>
    )
  }
  if (!database || !view) {
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground">
        {t("databaseLinkedView.unavailable")}
      </p>
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

  return (
    <div className="amby-database-host my-2 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3 py-1.5 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium">
          {database.title}
          <span className="font-normal text-muted-foreground"> · {view.title}</span>
        </span>
        {editable && onReferenceChange && pageRelations.length > 0 && (
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <span>{t("databaseEmbed.pageFilter")}</span>
            <select
              className="h-7 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
              value={ownTied}
              onChange={(event) =>
                onReferenceChange({
                  filter: event.target.value ? currentPageFilter(event.target.value) : undefined,
                })
              }
            >
              <option value="">{t("databaseEmbed.pageFilterNone")}</option>
              {pageRelations.map((property) => (
                <option key={property.propertyId} value={property.propertyId}>
                  {property.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {editable && onReferenceChange && (
          <div role="group" aria-label={t("databaseEmbed.layout")} className="flex items-center">
            {LAYOUTS.map((candidate) => {
              const Icon = getViewLayoutIcon(candidate)
              return (
                <Button
                  key={candidate}
                  variant="ghost"
                  size="icon-sm"
                  aria-pressed={layout === candidate}
                  title={t(`databaseLayouts.${candidate}`)}
                  aria-label={t(`databaseLayouts.${candidate}`)}
                  className={cn(layout === candidate && "bg-accent text-foreground")}
                  onClick={() => onReferenceChange({ layout: candidate })}
                >
                  <Icon className="size-3.5" />
                </Button>
              )
            })}
          </div>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          title={t("databaseEmbed.open")}
          aria-label={t("databaseEmbed.open")}
          onClick={() => openDatabaseFromEmbed(reference.databaseId, database.title)}
        >
          <ExternalLink className="size-3.5" />
        </Button>
        {editable && (
          <Button
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={creating || database.locked}
            onClick={() => void createRecord()}
          >
            <Plus className="size-3.5" />
            {t("databaseEmbed.newRecord")}
          </Button>
        )}
      </div>
      {notice && (
        <p
          role="status"
          className="border-b border-border/70 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground"
        >
          {notice}
        </p>
      )}
      <div className="flex h-[420px] min-h-0 flex-col">
        {layout === "board" && view.groupField?.kind === "property" ? (
          <BoardHostLayout
            databaseId={reference.databaseId}
            groupPropertyId={view.groupField.propertyId}
            properties={properties}
            relationTitles={relationTitles}
            cardFields={settings.cardFields}
            filter={queryFilter}
            sorts={querySorts}
            contextPageId={noteId}
            enabled={enabled}
            onRowSelect={open}
          />
        ) : layout === "board" ? (
          <BoardView
            {...common}
            properties={properties}
            relationTitles={relationTitles}
            cardFields={settings.cardFields}
            groupField={view.groupField}
            onRowSelect={open}
          />
        ) : layout === "list" ? (
          <ListView
            {...common}
            properties={properties}
            relationTitles={relationTitles}
            cardFields={settings.cardFields}
            onRowSelect={open}
          />
        ) : layout === "gallery" ? (
          <GalleryView
            {...common}
            properties={properties}
            relationTitles={relationTitles}
            databaseId={reference.databaseId}
            vaultGeneration={vaultGeneration}
            cardFields={settings.cardFields}
            cardSize={settings.cardSize}
            onRowSelect={open}
          />
        ) : (
          <TableView
            {...common}
            databaseId={reference.databaseId}
            properties={properties}
            databases={databases}
            pendingCells={mutation.pendingCells}
            cellErrors={mutation.cellErrors}
            onCellCommit={
              editable ? (row, property, value) => mutation.commit(row, property, value) : undefined
            }
            hiddenPropertyIds={new Set(settings.hidden)}
            savedSettings={{
              widths: settings.widths,
              wrapped: settings.wrapped,
              frozenKey: settings.frozenKey,
            }}
            onRowSelect={open}
            onOpenNote={openNoteFromDatabase}
          />
        )}
      </div>
    </div>
  )
}

function BoardHostLayout(props: {
  databaseId: string
  groupPropertyId: string
  properties: DatabasePropertySummary[]
  relationTitles: Record<string, string>
  cardFields: string[] | null
  filter: ReturnType<typeof toQueryFilter>
  sorts: ReturnType<typeof toQuerySorts>
  contextPageId?: string
  enabled: boolean
  onRowSelect: (row: DatabaseRow) => void
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
      filter={props.filter}
      sorts={props.sorts}
      contextPageId={props.contextPageId}
      enabled={props.enabled}
      onRowSelect={props.onRowSelect}
    />
  )
}
