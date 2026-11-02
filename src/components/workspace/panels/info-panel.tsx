import { useMotionPropertyOrder } from "./use-motion-property-order"
import * as React from "react"
import { Check, ChevronDown, Copy } from "lucide-react"
import { useTranslation } from "react-i18next"
import {
  deleteDatabaseProperty,
  getDatabaseNoteContext,
  listDatabases,
  renameDatabaseProperty,
  reorderDatabaseProperties,
  type CustomProperty,
  type DatabaseNoteContext,
  type DatabasePropertySummary,
} from "@/lib/storage"
import { noteEditingPolicy } from "../editor/note-editing-policy"
import type { PanelRenderProps } from "../panel-registry"
import { createRelationTargetRow, usePropertyMutation } from "../database/use-property-mutation"
import { useDatabaseStore } from "../database/database-store"
import { useViewStateStore } from "../use-view-state-store"
import { PanelHeader } from "./panel-header"
import { findTreeItem, formatModified } from "../workspace-tree-utils"
import { InfoPanelBody } from "./info-panel-body"
import { InfoPanelDatabaseView } from "./info-panel-database-view"

function MetadataSection({
  id,
  type,
  created,
  modified,
}: {
  id: string
  type: string
  created?: string
  modified?: string
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = React.useState(false)

  async function copyId() {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      // Clipboard access can be unavailable in browser previews.
    }
  }

  return (
    <details className="group/metadata shrink-0 px-4 pb-4">
      <summary className="flex cursor-pointer list-none items-center justify-between px-1 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground [&::-webkit-details-marker]:hidden">
        {t("infoPanel.metadata")}
        <ChevronDown className="size-3.5 rotate-180 group-open/metadata:rotate-0" />
      </summary>
      <div className="max-h-[40vh] overflow-y-auto text-[10px]">
        {[
          [t("infoPanel.type"), type],
          [t("infoPanel.created"), created || "—"],
          [t("infoPanel.modified"), modified || "—"],
        ].map(([label, value]) => (
          <div key={label} className="flex items-start justify-between gap-3 px-1 py-2">
            <span className="text-muted-foreground">{label}</span>
            <span className="min-w-0 max-w-[65%] break-words text-right text-foreground">
              {value}
            </span>
          </div>
        ))}
        <div className="flex items-start gap-2 px-1 py-2">
          <span className="text-muted-foreground">{t("infoPanel.id")}</span>
          <code className="min-w-0 flex-1 break-all text-right font-mono text-[10px] leading-relaxed text-foreground">
            {id}
          </code>
          <button
            type="button"
            onClick={() => void copyId()}
            className="flex size-4 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t(copied ? "infoPanel.copied" : "infoPanel.copyId")}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </button>
        </div>
      </div>
    </details>
  )
}

export function InfoPanel({
  treeItems,
  properties,
  propertyError,
  databaseProperties,
  onSelect,
  onUpsertCustomProperty,
  onDeleteCustomProperty,
  onReorderCustomProperties,
}: PanelRenderProps) {
  const { t } = useTranslation()
  const [propertyEditorOpen, setPropertyEditorOpen] = React.useState(false)
  const [editingProperty, setEditingProperty] = React.useState<CustomProperty | null>(null)
  const [databasePropertyEditorOpen, setDatabasePropertyEditorOpen] = React.useState(false)
  const [editingDatabaseProperty, setEditingDatabaseProperty] =
    React.useState<CustomProperty | null>(null)
  const [noteContextState, setNoteContextState] = React.useState<{
    noteId: string | null
    generation: number | null
    context: DatabaseNoteContext | null
  } | null>(null)
  const [propertyOrderBusy, setPropertyOrderBusy] = React.useState(false)
  const [customPropertyOrderBusy, setCustomPropertyOrderBusy] = React.useState(false)
  const databases = useDatabaseStore((state) => state.databases)
  const databaseInvalidationSeq = useDatabaseStore((state) => state.invalidationSeq)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const contextNoteId = properties?.id ?? null
  const contextKind = properties?.kind
  const contextScope = React.useRef({ noteId: contextNoteId, generation: vaultGeneration })
  contextScope.current = { noteId: contextNoteId, generation: vaultGeneration }
  const noteDatabaseContext =
    noteContextState?.noteId === contextNoteId && noteContextState?.generation === vaultGeneration
      ? noteContextState.context
      : null
  const setNoteDatabaseContext = React.useCallback(
    (next: React.SetStateAction<DatabaseNoteContext | null>) => {
      setNoteContextState((previous) => {
        if (
          contextScope.current.noteId !== contextNoteId ||
          contextScope.current.generation !== vaultGeneration
        )
          return previous
        const context =
          previous?.noteId === contextNoteId && previous?.generation === vaultGeneration
            ? previous.context
            : null
        return {
          noteId: contextNoteId,
          generation: vaultGeneration,
          context: typeof next === "function" ? next(context) : next,
        }
      })
    },
    [contextNoteId, vaultGeneration],
  )
  React.useEffect(() => {
    setPropertyEditorOpen(false)
    setEditingProperty(null)
    setDatabasePropertyEditorOpen(false)
    setEditingDatabaseProperty(null)
  }, [contextNoteId, databaseProperties?.id, vaultGeneration])
  const setDatabaseCatalog = useDatabaseStore((state) => state.setCatalog)
  const invalidateDatabaseHosts = useDatabaseStore((state) => state.invalidateHosts)
  const refreshDatabaseCatalog = React.useCallback(async () => {
    const catalog = await listDatabases()
    if (useDatabaseStore.getState().vaultGeneration === vaultGeneration) setDatabaseCatalog(catalog)
  }, [setDatabaseCatalog, vaultGeneration])
  const iconOverrides = useViewStateStore((state) => state.iconOverrides)
  const setIcon = useViewStateStore((state) => state.setIcon)
  const [databaseSchemaBusy, setDatabaseSchemaBusy] = React.useState(false)
  const customProperties = React.useMemo(
    () =>
      !properties || properties.kind === "folder" || properties.frontmatter.parseError
        ? []
        : (properties.frontmatter.customProperties ?? []),
    [properties],
  )
  const frontmatterProperties = React.useMemo(
    () =>
      !properties || properties.kind === "folder" || properties.frontmatter.parseError
        ? []
        : (properties.frontmatter.properties ?? []).filter((property) => {
            const key = property.key.trim().toLowerCase()
            return key !== "amby-id" && key !== "id"
          }),
    [properties],
  )
  const frontmatterKeySet = React.useMemo(
    () => new Set(frontmatterProperties.map((prop) => prop.key.trim().toLowerCase())),
    [frontmatterProperties],
  )
  const noteDatabasePropertyNamesSet = React.useMemo(() => {
    const set = new Set<string>()
    if (noteDatabaseContext) {
      for (const prop of noteDatabaseContext.properties) {
        set.add(prop.name.trim().toLowerCase())
        set.add(prop.propertyId.trim().toLowerCase())
      }
    }
    return set
  }, [noteDatabaseContext])
  const currentDatabaseName = React.useMemo(() => {
    if (!noteDatabaseContext) return undefined
    const found = databases.find((db) => db.databaseId === noteDatabaseContext.databaseId)
    return found?.title || noteDatabaseContext.databaseId
  }, [databases, noteDatabaseContext])
  const nonDatabaseFrontmatterProperties = React.useMemo(
    () =>
      frontmatterProperties.filter(
        (property) => !noteDatabasePropertyNamesSet.has(property.key.trim().toLowerCase()),
      ),
    [frontmatterProperties, noteDatabasePropertyNamesSet],
  )

  React.useEffect(() => {
    let cancelled = false
    if (!contextNoteId || contextKind === "folder") {
      setNoteDatabaseContext(null)
      return
    }
    void getDatabaseNoteContext(contextNoteId)
      .then((context) => {
        if (!cancelled) setNoteDatabaseContext(context)
      })
      .catch(() => {
        // Keep the last successful context during a transient reload failure.
      })
    return () => {
      cancelled = true
    }
  }, [databaseInvalidationSeq, contextNoteId, contextKind, vaultGeneration, setNoteDatabaseContext])

  // The same write path as the table: Relation goes through the Relation
  // command (inverse side and rollups stay consistent), writes to one row are
  // serialized, and the latest revision is reused.
  const propertyMutation = usePropertyMutation({
    databaseId: noteDatabaseContext?.databaseId ?? "",
    vaultGeneration: noteDatabaseContext?.vaultGeneration ?? null,
    // A write can change other rows (inverse Relations): reload every view and
    // this panel's own context, also after a failed write.
    onSettled: () => invalidateDatabaseHosts(),
  })
  const commitDatabaseProperty = React.useCallback(
    (property: DatabasePropertySummary, valueJson?: string) => {
      const context = noteDatabaseContext
      if (!context || context.locked) return Promise.resolve()
      return propertyMutation.commit(context.row, property, valueJson)
    },
    [noteDatabaseContext, propertyMutation],
  )
  const createDatabaseRelationRow = React.useCallback(
    async (targetDatabaseId: string, title: string): Promise<string | void> => {
      const context = noteDatabaseContext
      if (!context || !title.trim()) return
      const noteId = await createRelationTargetRow(context.vaultGeneration, targetDatabaseId, title)
      invalidateDatabaseHosts()
      return noteId
    },
    [invalidateDatabaseHosts, noteDatabaseContext],
  )

  const renameNoteDatabaseProperty = React.useCallback(
    async (property: DatabasePropertySummary, name: string) => {
      const context = noteDatabaseContext
      if (!context || context.locked) return
      setDatabaseSchemaBusy(true)
      try {
        await renameDatabaseProperty({
          expectedGeneration: context.vaultGeneration,
          databaseId: context.databaseId,
          propertyId: property.propertyId,
          expectedManifestRevision: context.manifestRevision,
          name,
        })
        const refreshed = await getDatabaseNoteContext(context.row.noteId)
        setNoteDatabaseContext(refreshed)
        void refreshDatabaseCatalog().catch(() => {})
        invalidateDatabaseHosts()
      } finally {
        setDatabaseSchemaBusy(false)
      }
    },
    [invalidateDatabaseHosts, noteDatabaseContext, refreshDatabaseCatalog, setNoteDatabaseContext],
  )

  const deleteNoteDatabaseProperty = React.useCallback(
    async (property: DatabasePropertySummary) => {
      const context = noteDatabaseContext
      if (!context || context.locked) return
      setDatabaseSchemaBusy(true)
      try {
        await deleteDatabaseProperty({
          expectedGeneration: context.vaultGeneration,
          databaseId: context.databaseId,
          propertyId: property.propertyId,
          expectedManifestRevision: context.manifestRevision,
        })
        const refreshed = await getDatabaseNoteContext(context.row.noteId)
        setNoteDatabaseContext(refreshed)
        void refreshDatabaseCatalog().catch(() => {})
        invalidateDatabaseHosts()
      } finally {
        setDatabaseSchemaBusy(false)
      }
    },
    [invalidateDatabaseHosts, noteDatabaseContext, refreshDatabaseCatalog, setNoteDatabaseContext],
  )

  const renameSchemaProperty = React.useCallback(
    async (property: DatabasePropertySummary, name: string) => {
      if (!databaseProperties || vaultGeneration === null || databaseProperties.locked) return
      setDatabaseSchemaBusy(true)
      try {
        await renameDatabaseProperty({
          expectedGeneration: vaultGeneration,
          databaseId: databaseProperties.id,
          propertyId: property.propertyId,
          expectedManifestRevision: databaseProperties.manifestRevision,
          name,
        })
        const catalog = await listDatabases()
        setDatabaseCatalog(catalog)
        invalidateDatabaseHosts()
      } finally {
        setDatabaseSchemaBusy(false)
      }
    },
    [databaseProperties, invalidateDatabaseHosts, setDatabaseCatalog, vaultGeneration],
  )
  const deleteSchemaProperty = React.useCallback(
    async (property: DatabasePropertySummary) => {
      if (!databaseProperties || vaultGeneration === null || databaseProperties.locked) return
      setDatabaseSchemaBusy(true)
      try {
        await deleteDatabaseProperty({
          expectedGeneration: vaultGeneration,
          databaseId: databaseProperties.id,
          propertyId: property.propertyId,
          expectedManifestRevision: databaseProperties.manifestRevision,
        })
        const catalog = await listDatabases()
        setDatabaseCatalog(catalog)
        invalidateDatabaseHosts()
      } finally {
        setDatabaseSchemaBusy(false)
      }
    },
    [databaseProperties, invalidateDatabaseHosts, setDatabaseCatalog, vaultGeneration],
  )
  const persistNoteDatabaseOrder = React.useCallback(
    async (propertyIds: string[]) => {
      const context = noteDatabaseContext
      if (!context || context.locked) return
      const propertyById = new Map(
        context.properties.map((property) => [property.propertyId, property]),
      )
      setPropertyOrderBusy(true)
      try {
        const result = await reorderDatabaseProperties({
          expectedGeneration: context.vaultGeneration,
          databaseId: context.databaseId,
          expectedManifestRevision: context.manifestRevision,
          propertyIds,
        })
        setNoteDatabaseContext((current) =>
          current?.databaseId === context.databaseId
            ? {
                ...current,
                manifestRevision: result.manifestRevision,
                properties: propertyIds.flatMap((id) => {
                  const property = propertyById.get(id)
                  return property ? [property] : []
                }),
              }
            : current,
        )
        void refreshDatabaseCatalog().catch(() => {})
        invalidateDatabaseHosts()
      } catch (error) {
        const refreshed = await getDatabaseNoteContext(context.row.noteId).catch(() => null)
        if (refreshed) setNoteDatabaseContext(refreshed)
        throw error
      } finally {
        setPropertyOrderBusy(false)
      }
    },
    [invalidateDatabaseHosts, noteDatabaseContext, refreshDatabaseCatalog, setNoteDatabaseContext],
  )

  const persistDatabaseSchemaOrder = React.useCallback(
    async (propertyIds: string[]) => {
      if (!databaseProperties || vaultGeneration === null || databaseProperties.locked) return
      setPropertyOrderBusy(true)
      try {
        await reorderDatabaseProperties({
          expectedGeneration: vaultGeneration,
          databaseId: databaseProperties.id,
          expectedManifestRevision: databaseProperties.manifestRevision,
          propertyIds,
        })
        const catalog = await listDatabases()
        setDatabaseCatalog(catalog)
        invalidateDatabaseHosts()
      } finally {
        setPropertyOrderBusy(false)
      }
    },
    [databaseProperties, invalidateDatabaseHosts, setDatabaseCatalog, vaultGeneration],
  )

  const persistCustomPropertyOrder = React.useCallback(
    async (propertyIds: string[]) => {
      if (!onReorderCustomProperties) return
      setCustomPropertyOrderBusy(true)
      try {
        await onReorderCustomProperties(propertyIds)
      } finally {
        setCustomPropertyOrderBusy(false)
      }
    },
    [onReorderCustomProperties],
  )

  const noteDatabaseOrder = useMotionPropertyOrder(
    noteDatabaseContext?.properties.map((property) => property.propertyId) ?? [],
    persistNoteDatabaseOrder,
  )
  const databaseSchemaOrder = useMotionPropertyOrder(
    databaseProperties?.properties.map((property) => property.propertyId) ?? [],
    persistDatabaseSchemaOrder,
  )
  const visibleCustomProperties = React.useMemo(
    () =>
      customProperties.filter(
        (property) =>
          !frontmatterKeySet.has(property.name.trim().toLowerCase()) &&
          !noteDatabasePropertyNamesSet.has(property.name.trim().toLowerCase()) &&
          !noteDatabasePropertyNamesSet.has(property.id.trim().toLowerCase()),
      ),
    [customProperties, frontmatterKeySet, noteDatabasePropertyNamesSet],
  )
  const customOrder = useMotionPropertyOrder(
    visibleCustomProperties.map((property) => property.id),
    persistCustomPropertyOrder,
  )
  const orderedNoteDatabaseProperties = noteDatabaseOrder.order.flatMap((id) => {
    const property = noteDatabaseContext?.properties.find(
      (candidate) => candidate.propertyId === id,
    )
    return property ? [property] : []
  })
  const orderedDatabaseSchemaProperties = databaseSchemaOrder.order.flatMap((id) => {
    const property = databaseProperties?.properties.find((candidate) => candidate.propertyId === id)
    return property ? [property] : []
  })
  const nonDuplicateCustomProperties = customOrder.order.flatMap((id) => {
    const property = visibleCustomProperties.find((candidate) => candidate.id === id)
    return property ? [property] : []
  })
  const hasNoteProperties =
    nonDatabaseFrontmatterProperties.length +
      nonDuplicateCustomProperties.length +
      (noteDatabaseContext?.properties.length ?? 0) >
    0
  const metadataId = databaseProperties?.id ?? properties?.id
  const metadataKind = databaseProperties ? "database" : (properties?.kind ?? "document")
  const attachedNoteId = databaseProperties
    ? databases.find((database) => database.databaseId === databaseProperties.id)?.attachedNoteId
    : null
  const metadataItem = metadataId
    ? (findTreeItem(treeItems, metadataId) ??
      (attachedNoteId ? findTreeItem(treeItems, attachedNoteId) : null))
    : null
  const documentMetadata = !databaseProperties && properties?.kind !== "folder" ? properties : null
  const metadata = metadataId ? (
    <MetadataSection
      key={`${metadataKind}:${metadataId}`}
      id={metadataId}
      type={databaseProperties ? t("infoPanel.databaseType") : (properties?.type ?? "—")}
      created={
        documentMetadata?.created ||
        (metadataItem?.created ? formatModified(metadataItem.created) : undefined)
      }
      modified={
        documentMetadata?.modified ||
        (metadataItem?.modified ? formatModified(metadataItem.modified) : undefined)
      }
    />
  ) : null
  if (databaseProperties) {
    return (
      <InfoPanelDatabaseView
        databaseProperties={databaseProperties}
        databaseSchemaBusy={databaseSchemaBusy}
        setEditingDatabaseProperty={setEditingDatabaseProperty}
        setDatabasePropertyEditorOpen={setDatabasePropertyEditorOpen}
        databaseSchemaOrder={databaseSchemaOrder}
        orderedDatabaseSchemaProperties={orderedDatabaseSchemaProperties}
        propertyOrderBusy={propertyOrderBusy}
        renameSchemaProperty={renameSchemaProperty}
        deleteSchemaProperty={deleteSchemaProperty}
        iconOverrides={iconOverrides}
        setIcon={setIcon}
        metadata={metadata}
        editingDatabaseProperty={editingDatabaseProperty}
        databasePropertyEditorOpen={databasePropertyEditorOpen}
        vaultGeneration={vaultGeneration}
        setDatabaseSchemaBusy={setDatabaseSchemaBusy}
        setDatabaseCatalog={setDatabaseCatalog}
        invalidateDatabaseHosts={invalidateDatabaseHosts}
      />
    )
  }
  if (!properties) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t("infoPanel.noDocument")}
      </div>
    )
  }
  const warningKey =
    properties.kind === "folder" ? null : noteEditingPolicy(properties.frontmatter).warningKey
  function openPropertyEditor() {
    setEditingProperty(null)
    setPropertyEditorOpen(true)
  }

  if (properties.kind === "folder") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PanelHeader
          title={t("panels.info")}
          actions={
            <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
              {properties.noteCount}
            </span>
          }
        />
        <div className="flex-1" />
        {metadata}
      </div>
    )
  }

  return (
    <InfoPanelBody
      properties={properties}
      openPropertyEditor={openPropertyEditor}
      nonDatabaseFrontmatterProperties={nonDatabaseFrontmatterProperties}
      nonDuplicateCustomProperties={nonDuplicateCustomProperties}
      noteDatabaseContext={noteDatabaseContext}
      propertyError={propertyError}
      warningKey={warningKey}
      hasNoteProperties={hasNoteProperties}
      orderedNoteDatabaseProperties={orderedNoteDatabaseProperties}
      noteDatabaseOrder={noteDatabaseOrder}
      propertyMutation={propertyMutation}
      databases={databases}
      onSelect={onSelect}
      createDatabaseRelationRow={createDatabaseRelationRow}
      commitDatabaseProperty={commitDatabaseProperty}
      renameNoteDatabaseProperty={renameNoteDatabaseProperty}
      deleteNoteDatabaseProperty={deleteNoteDatabaseProperty}
      iconOverrides={iconOverrides}
      setIcon={setIcon}
      propertyOrderBusy={propertyOrderBusy}
      customProperties={customProperties}
      onUpsertCustomProperty={onUpsertCustomProperty}
      onDeleteCustomProperty={onDeleteCustomProperty}
      customOrder={customOrder}
      setEditingProperty={setEditingProperty}
      setPropertyEditorOpen={setPropertyEditorOpen}
      customPropertyOrderBusy={customPropertyOrderBusy}
      onReorderCustomProperties={onReorderCustomProperties}
      metadata={metadata}
      editingProperty={editingProperty}
      propertyEditorOpen={propertyEditorOpen}
      currentDatabaseName={currentDatabaseName}
      setNoteDatabaseContext={setNoteDatabaseContext}
      refreshDatabaseCatalog={refreshDatabaseCatalog}
      invalidateDatabaseHosts={invalidateDatabaseHosts}
    />
  )
}
