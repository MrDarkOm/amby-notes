import type { DatabaseSummary } from "@/lib/storage"
import * as React from "react"

import { useTranslation } from "react-i18next"

import { logger } from "@/lib/logger"

import {
  changeDatabasePropertyType,
  createDatabaseProperty,
  deleteDatabaseProperty,
  renameDatabaseProperty,
  updateDatabasePropertyOptions,
  updateDatabasePropertyConfig,
  configureDatabaseRollup,
  listDatabases,
  type DatabasePropertySummary,
} from "@/lib/storage"
import { useDatabaseStore } from "./database-store"

import { EMPTY_ROLLUP_DRAFT, type RollupDraft } from "./rollup-model"

import { type OptionActions } from "./option-actions"
import { databaseErrorText } from "./database-error"
import { PropertyConfigEditor, type PropertyConfigPatch } from "./property-config-editor"
import { hasPropertySettings, type RelationConfigState } from "./property-settings"
import {
  defaultStatusOptionNames,
  draftsFromProperty,
  draftsToInputs,
  nextOptionColor,
  type OptionDraft,
} from "./option-model"
import { createDatabaseOperationId } from "./use-property-mutation"
import { ShownError, operationErrorText, reportOperationError } from "@/lib/operation-errors"

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
    if (!summary?.manifestRevision) throw new ShownError(unavailableMessage)
    return [{ databaseId, revision: summary.manifestRevision }]
  })
}

interface UseDatabasePropertyActionsParams {
  databaseId: string
  title: string
  vaultGeneration: number | null
  database: DatabaseSummary | undefined
  databases: DatabaseSummary[]
  mutationBusy: boolean
  setMutationBusy: React.Dispatch<React.SetStateAction<boolean>>
  setMutationError: React.Dispatch<React.SetStateAction<string | null>>
  onCatalogChanged: (() => Promise<void>) | undefined
  retry: () => Promise<void>
  isDatabaseLocked: boolean
}

export function useDatabasePropertyActions({
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
}: UseDatabasePropertyActionsParams) {
  const { t } = useTranslation()
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
        notices.push(operationErrorText(refreshFailure.reason))
      }
      setMutationError(notices.length ? notices.join("; ") : null)
    } catch (error) {
      logger.error("database.create_property_failed", {
        databaseId,
        propertyName: propertyName.trim(),
        propertyType,
        error,
      })
      setMutationError(operationErrorText(error))
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
    setMutationBusy,
    setMutationError,
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
          notices.push(operationErrorText(refreshFailure.reason))
        }
        setMutationError(notices.length ? notices.join("; ") : null)
      } catch (error) {
        logger.error("database.delete_property_failed", { databaseId, propertyId, error })
        setMutationError(operationErrorText(error))
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
      setMutationBusy,
      setMutationError,
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
          notices.push(operationErrorText(refreshFailure.reason))
        }
        setMutationError(notices.length ? notices.join("; ") : null)
      } catch (error) {
        logger.error("database.rename_property_failed", {
          databaseId,
          propertyId,
          newName: name,
          error,
        })
        setMutationError(operationErrorText(error))
      }
    },
    [
      database,
      databaseId,
      isDatabaseLocked,
      onCatalogChanged,
      retry,
      vaultGeneration,
      setMutationError,
    ],
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
        notices.push(operationErrorText(refreshFailure.reason))
      }
      setMutationError(notices.length ? notices.join("; ") : null)
    },
    [onCatalogChanged, retry, setMutationError],
  )

  const saveOptionDrafts = React.useCallback(
    (propertyId: string, drafts: OptionDraft[]) =>
      enqueueSchema(async () => {
        const property = database?.properties.find(
          (candidate) => candidate.propertyId === propertyId,
        )
        const revision = manifestRevisionRef.current
        if (vaultGeneration === null || !revision || isDatabaseLocked || !property) {
          throw new ShownError(t("databaseOptions.unavailable"))
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
          throw new ShownError(t("databaseOptions.unavailable"))
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
        throw new ShownError(databaseErrorText(error, t, "date"))
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
          setMutationError(reportOperationError(error))
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
          setMutationError(reportOperationError(error))
        }
      },
    }
  }, [database?.properties, isDatabaseLocked, saveOptionDrafts, vaultGeneration, setMutationError])

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
          notices.push(operationErrorText(refreshFailure.reason))
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
    [
      database,
      databaseId,
      isDatabaseLocked,
      onCatalogChanged,
      retry,
      t,
      vaultGeneration,
      setMutationError,
    ],
  )

  // Saves the relation settings of a property. A relation also touches the database it points to
  // (the reverse property), so it goes through the same checked schema change as a type change.
  const saveRelationConfig = React.useCallback(
    (property: DatabasePropertySummary, config: RelationConfigState) =>
      enqueueSchema(async () => {
        const revision = manifestRevisionRef.current
        if (vaultGeneration === null || !revision || isDatabaseLocked) {
          throw new ShownError(t("databaseOptions.unavailable"))
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
        throw new ShownError(databaseErrorText(error, t, "relation"))
      }),
    [databaseId, enqueueSchema, isDatabaseLocked, refreshAfterSchemaEdit, t, vaultGeneration],
  )
  const saveRollupConfig = React.useCallback(
    (property: DatabasePropertySummary, draft: RollupDraft) =>
      enqueueSchema(async () => {
        const revision = manifestRevisionRef.current
        if (vaultGeneration === null || !revision || isDatabaseLocked) {
          throw new ShownError(t("databaseOptions.unavailable"))
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

  return {
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
  }
}
