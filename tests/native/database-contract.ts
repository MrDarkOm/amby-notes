import { joinStoragePath } from "../../src/lib/storage/storage-path"
import type { StorageContractContext } from "../../src/lib/storage/storage-contract"
import { DatabaseOperationError } from "../../src/lib/storage/database-types"
import {
  applySettingsPatch,
  conditionsToFilter,
  parseViewSettings,
  toQueryFilter,
} from "../../src/components/workspace/database/view-config"

interface RelationRecoveryJournalFixture {
  status: string
  requestRevision: string
  steps: Array<{
    noteId: string
    recordPath: string
    backupPath: string
    status: string
  }>
  result: unknown
  [key: string]: unknown
}

interface RelationSchemaRecoveryJournalFixture {
  status: string
  requestRevision: string
  steps: Array<{
    databaseId: string
    manifestPath: string
    backupPath: string
    status: string
  }>
  result: unknown
  [key: string]: unknown
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function noteId(result: { primaryId?: string | null }, message: string): string {
  check(result.primaryId, message)
  return result.primaryId
}

function relationTargets(row: { valuesJson: string }, propertyId: string): string[] {
  const values = JSON.parse(row.valuesJson) as Record<string, unknown>
  const value = values[propertyId]
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  const targets = (value as { targetNoteIds?: unknown }).targetNoteIds
  return Array.isArray(targets) && targets.every((target) => typeof target === "string")
    ? targets
    : []
}

function affectedKey(databaseId: string, noteId: string): string {
  return `${databaseId}:${noteId}`
}

function checkAffected(
  affectedNotes: Array<{ databaseId: string; noteId: string }>,
  expected: Array<{ databaseId: string; noteId: string }>,
  message: string,
): void {
  const actual = new Set(affectedNotes.map((note) => affectedKey(note.databaseId, note.noteId)))
  check(actual.size === affectedNotes.length, `${message}: affected notes are unique`)
  check(actual.size === expected.length, `${message}: only written notes are reported`)
  for (const note of expected) {
    check(actual.has(affectedKey(note.databaseId, note.noteId)), `${message}: ${note.noteId}`)
  }
}

async function queryDatabase(
  adapter: StorageContractContext["adapter"],
  generation: number,
  databaseId: string,
) {
  return adapter.queryDatabase({
    expectedGeneration: generation,
    databaseId,
    source: { kind: "inline", spec: { sorts: [] } },
    page: { limit: 20 },
  })
}

function rowFor<T extends { noteId: string }>(rows: T[], targetNoteId: string, message: string): T {
  const row = rows.find((candidate) => candidate.noteId === targetNoteId)
  check(row, message)
  return row
}

function returnedRevision(
  result: { revisions: Array<{ noteId: string; revision: string }> },
  noteId: string,
  message: string,
): string {
  const revision = result.revisions.find((candidate) => candidate.noteId === noteId)?.revision
  check(revision, message)
  return revision
}

function checkReplayResult(replay: unknown, original: unknown, message: string): void {
  check(JSON.stringify(replay) === JSON.stringify(original), message)
}

function manifestRevisionFor(
  result: { manifestRevisions: Array<{ databaseId: string; revision: string }> },
  databaseId: string,
  message: string,
): string {
  const revision = result.manifestRevisions.find((item) => item.databaseId === databaseId)?.revision
  check(revision, message)
  return revision
}

function schemaManifestPath(
  step: RelationSchemaRecoveryJournalFixture["steps"][number],
  message: string,
): string {
  check(step.manifestPath, message)
  return step.manifestPath
}

async function sha256Utf8(content: string): Promise<string> {
  check(
    typeof crypto !== "undefined" && crypto.subtle,
    "Native test runtime must provide Web Crypto SHA-256",
  )
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export const nativeDatabaseCases: Array<{
  name: string
  run: (context: StorageContractContext) => Promise<void>
}> = [
  {
    name: "native relation CAS and controlled crash-window journal recovery",
    async run({ adapter, vaultPath }) {
      const loaded = await adapter.loadActiveVaultData()
      let generation = loaded.generation
      const state = await adapter.getDatabaseModuleState()
      if (!state.enabled) await adapter.setDatabaseModuleEnabled(true, generation)
      await adapter.rebuildDatabaseProjection()

      const tasks = await adapter.createDatabase({
        expectedGeneration: generation,
        mode: "standalone",
        parentPath: vaultPath,
        name: "Tasks",
      })
      const projects = await adapter.createDatabase({
        expectedGeneration: generation,
        mode: "standalone",
        parentPath: vaultPath,
        name: "Projects",
      })
      const relationSchemaOperationId = `native-relation-schema-${tasks.databaseId}`
      const relationSchemaRequest = {
        expectedGeneration: generation,
        databaseId: tasks.databaseId,
        expectedManifestRevision: tasks.manifestRevision,
        operationId: relationSchemaOperationId,
        expectedTargetManifestRevision: projects.manifestRevision,
        name: "Project",
        propertyType: "relation",
        relationTargetDatabaseId: projects.databaseId,
        relationMaxItems: 1,
        relationTwoWay: true,
        relationInversePropertyName: "Tasks",
      }
      const forward = await adapter.createDatabaseProperty(relationSchemaRequest)
      check(
        forward.operationId === relationSchemaOperationId,
        "Two-way relation returns its operation ID",
      )
      check(forward.inversePropertyId, "Two-way relation returns its inverse property ID")
      const sourceManifestPath = tasks.manifestPath
      const targetManifestPath = projects.manifestPath
      const sourceManifestAfterCreate = await adapter.readFile(sourceManifestPath)
      const targetManifestAfterCreate = await adapter.readFile(targetManifestPath)
      check(
        manifestRevisionFor(
          forward,
          tasks.databaseId,
          "Two-way relation returns the source manifest revision",
        ) === (await sha256Utf8(sourceManifestAfterCreate)) &&
          manifestRevisionFor(
            forward,
            projects.databaseId,
            "Two-way relation returns the target manifest revision",
          ) === (await sha256Utf8(targetManifestAfterCreate)),
        "Two-way relation manifest revisions match raw manifest bytes",
      )
      const replayedForward = await adapter.createDatabaseProperty(relationSchemaRequest)
      checkReplayResult(
        replayedForward,
        forward,
        "Replaying an identical two-way relation creation returns the original result",
      )
      check(
        (await adapter.readFile(sourceManifestPath)) === sourceManifestAfterCreate &&
          (await adapter.readFile(targetManifestPath)) === targetManifestAfterCreate,
        "Identical two-way relation creation replay preserves manifest bytes",
      )
      let schemaPayloadReuseRejected = false
      try {
        await adapter.createDatabaseProperty({
          ...relationSchemaRequest,
          name: "Different Project",
        })
      } catch {
        schemaPayloadReuseRejected = true
      }
      check(schemaPayloadReuseRejected, "Reusing a schema operation ID with a new payload fails")
      check(
        (await adapter.readFile(sourceManifestPath)) === sourceManifestAfterCreate &&
          (await adapter.readFile(targetManifestPath)) === targetManifestAfterCreate,
        "Mismatched schema operation reuse preserves manifest bytes",
      )
      await adapter.createDatabaseProperty({
        expectedGeneration: generation,
        databaseId: projects.databaseId,
        expectedManifestRevision: manifestRevisionFor(
          forward,
          projects.databaseId,
          "Target manifest revision is returned",
        ),
        name: "Target Marker",
        propertyType: "text",
      })
      const sourceManifestBeforeStaleSchema = await adapter.readFile(sourceManifestPath)
      const targetManifestBeforeStaleSchema = await adapter.readFile(targetManifestPath)
      let staleTargetSchemaRejected = false
      try {
        await adapter.createDatabaseProperty({
          ...relationSchemaRequest,
          operationId: `${relationSchemaOperationId}-stale-target`,
          name: "Stale Project",
          expectedManifestRevision: manifestRevisionFor(
            forward,
            tasks.databaseId,
            "Source manifest revision is returned",
          ),
          expectedTargetManifestRevision: manifestRevisionFor(
            forward,
            projects.databaseId,
            "Original target manifest revision is returned",
          ),
        })
      } catch {
        staleTargetSchemaRejected = true
      }
      check(staleTargetSchemaRejected, "Stale target manifest revision is rejected")
      check(
        (await adapter.readFile(sourceManifestPath)) === sourceManifestBeforeStaleSchema &&
          (await adapter.readFile(targetManifestPath)) === targetManifestBeforeStaleSchema,
        "Stale target schema creation preserves both manifest bytes",
      )
      const summaries = await adapter.listDatabases()
      const projectsSummary = summaries.find(
        (database) => database.databaseId === projects.databaseId,
      )
      check(projectsSummary, "Reciprocal database is discoverable")
      const inverse = projectsSummary.properties.find(
        (property) => property.propertyType === "relation",
      )
      check(inverse, "Two-way relation creates an inverse property")
      check(
        inverse.propertyId === forward.inversePropertyId,
        "Catalog inverse property ID matches the creation result",
      )

      const sourceSummary = summaries.find((database) => database.databaseId === tasks.databaseId)
      check(sourceSummary, "Source database is discoverable before property conversion")
      const emptyProperty = await adapter.createDatabaseProperty({
        expectedGeneration: generation,
        databaseId: tasks.databaseId,
        expectedManifestRevision: sourceSummary.manifestRevision,
        name: "Migrated Project",
        propertyType: "text",
      })
      const targetRevisionBeforeConversion = projectsSummary.manifestRevision
      const conversionRequest = {
        expectedGeneration: generation,
        databaseId: tasks.databaseId,
        propertyId: emptyProperty.propertyId,
        expectedManifestRevision: emptyProperty.manifestRevision,
        propertyType: "relation",
        operationId: `native-relation-convert-${tasks.databaseId}`,
        expectedRelatedManifestRevisions: [
          { databaseId: projects.databaseId, revision: targetRevisionBeforeConversion },
        ],
        relationTargetDatabaseId: projects.databaseId,
        relationMaxItems: 0,
        relationTwoWay: true,
        relationInversePropertyName: "Migrated Tasks",
      }
      const converted = await adapter.changeDatabasePropertyType(conversionRequest)
      check(
        converted.operationId === conversionRequest.operationId && converted.inversePropertyId,
        "Converting an empty property to a reciprocal Relation returns durable IDs",
      )
      check(
        converted.manifestRevisions.length === 2 &&
          converted.manifestRevisions.some((item) => item.databaseId === projects.databaseId),
        "Relation conversion returns source and related manifest revisions",
      )
      const convertedCatalog = await adapter.listDatabases()
      const convertedSource = convertedCatalog.find(
        (database) => database.databaseId === tasks.databaseId,
      )
      const convertedTarget = convertedCatalog.find(
        (database) => database.databaseId === projects.databaseId,
      )
      check(convertedSource && convertedTarget, "Converted Relation databases remain discoverable")
      const convertedProperty = convertedSource.properties.find(
        (property) => property.propertyId === emptyProperty.propertyId,
      )
      const convertedInverse = convertedTarget.properties.find(
        (property) => property.propertyId === converted.inversePropertyId,
      )
      check(convertedProperty && convertedInverse, "Conversion creates both Relation definitions")
      check(
        JSON.parse(convertedProperty.configJson).inversePropertyId ===
          converted.inversePropertyId &&
          JSON.parse(convertedInverse.configJson).inversePropertyId === emptyProperty.propertyId,
        "Converted reciprocal Relation definitions point to each other",
      )
      const conversionSourceAfterCreate = await adapter.readFile(sourceManifestPath)
      const conversionTargetAfterCreate = await adapter.readFile(targetManifestPath)
      let conversionPayloadReuseRejected = false
      try {
        await adapter.changeDatabasePropertyType({
          ...conversionRequest,
          relationInversePropertyName: "Different Migrated Tasks",
        })
      } catch {
        conversionPayloadReuseRejected = true
      }
      check(
        conversionPayloadReuseRejected,
        "Reusing a conversion operation ID with new payload fails",
      )
      check(
        (await adapter.readFile(sourceManifestPath)) === conversionSourceAfterCreate &&
          (await adapter.readFile(targetManifestPath)) === conversionTargetAfterCreate,
        "Mismatched conversion replay preserves both manifests",
      )

      const sourceBeforeStaleRelationConfig = await adapter.readFile(sourceManifestPath)
      const targetBeforeStaleRelationConfig = await adapter.readFile(targetManifestPath)
      let staleRelatedRevisionRejected = false
      try {
        await adapter.changeDatabasePropertyType({
          ...conversionRequest,
          operationId: `${conversionRequest.operationId}-stale`,
          expectedManifestRevision: converted.manifestRevision,
          expectedRelatedManifestRevisions: [
            { databaseId: projects.databaseId, revision: targetRevisionBeforeConversion },
          ],
          relationTwoWay: false,
        })
      } catch {
        staleRelatedRevisionRejected = true
      }
      check(staleRelatedRevisionRejected, "Stale related Relation revision is rejected")
      check(
        (await adapter.readFile(sourceManifestPath)) === sourceBeforeStaleRelationConfig &&
          (await adapter.readFile(targetManifestPath)) === targetBeforeStaleRelationConfig,
        "Stale related Relation configuration preserves both manifests",
      )

      const disabled = await adapter.changeDatabasePropertyType({
        expectedGeneration: generation,
        databaseId: tasks.databaseId,
        propertyId: emptyProperty.propertyId,
        expectedManifestRevision: converted.manifestRevision,
        propertyType: "relation",
        operationId: `native-relation-disable-${tasks.databaseId}`,
        expectedRelatedManifestRevisions: [
          { databaseId: projects.databaseId, revision: convertedTarget.manifestRevision },
        ],
        relationTargetDatabaseId: projects.databaseId,
        relationMaxItems: 0,
        relationTwoWay: false,
      })
      check(
        disabled.operationId && disabled.inversePropertyId === null,
        "Disabling an empty reciprocal Relation clears the inverse pointer",
      )
      const disabledCatalog = await adapter.listDatabases()
      const disabledSource = disabledCatalog.find(
        (database) => database.databaseId === tasks.databaseId,
      )
      const disabledTarget = disabledCatalog.find(
        (database) => database.databaseId === projects.databaseId,
      )
      check(disabledSource && disabledTarget, "Disabled Relation databases remain discoverable")
      const disabledProperty = disabledSource.properties.find(
        (property) => property.propertyId === emptyProperty.propertyId,
      )
      check(disabledProperty, "Disabled Relation remains on the source database")
      check(
        JSON.parse(disabledProperty.configJson).inversePropertyId === undefined ||
          JSON.parse(disabledProperty.configJson).inversePropertyId === null,
        "Disabling a reciprocal Relation clears the source inverse pointer",
      )
      check(
        disabledTarget.properties.some(
          (property) => property.propertyId === converted.inversePropertyId,
        ),
        "Disabling an empty reciprocal Relation preserves its counterpart",
      )
      const disabledCounterpart = disabledTarget.properties.find(
        (property) => property.propertyId === converted.inversePropertyId,
      )
      check(disabledCounterpart, "Disabled reciprocal counterpart remains discoverable")
      const disabledCounterpartConfig = JSON.parse(disabledCounterpart.configJson) as {
        targetDatabaseId?: unknown
        inversePropertyId?: unknown
      }
      check(
        disabledCounterpartConfig.targetDatabaseId === tasks.databaseId &&
          (disabledCounterpartConfig.inversePropertyId === undefined ||
            disabledCounterpartConfig.inversePropertyId === null),
        "Disabling an empty reciprocal Relation clears the counterpart inverse pointer",
      )

      const selfSourceSummary = disabledCatalog.find(
        (database) => database.databaseId === tasks.databaseId,
      )
      check(selfSourceSummary, "Source database is discoverable before self Relation conversion")
      const selfProperty = await adapter.createDatabaseProperty({
        expectedGeneration: generation,
        databaseId: tasks.databaseId,
        expectedManifestRevision: selfSourceSummary.manifestRevision,
        name: "Parent Task",
        propertyType: "text",
      })
      const selfConverted = await adapter.changeDatabasePropertyType({
        expectedGeneration: generation,
        databaseId: tasks.databaseId,
        propertyId: selfProperty.propertyId,
        expectedManifestRevision: selfProperty.manifestRevision,
        propertyType: "relation",
        operationId: `native-relation-self-${tasks.databaseId}`,
        expectedRelatedManifestRevisions: [],
        relationTargetDatabaseId: tasks.databaseId,
        relationMaxItems: 1,
        relationTwoWay: true,
        relationInversePropertyName: "Child Tasks",
      })
      check(
        selfConverted.inversePropertyId && selfConverted.manifestRevisions.length === 1,
        "Self Relation conversion creates a reciprocal property in one manifest",
      )
      const selfCatalog = await adapter.listDatabases()
      const selfDatabase = selfCatalog.find((database) => database.databaseId === tasks.databaseId)
      check(selfDatabase, "Self Relation database remains discoverable")
      const selfForward = selfDatabase.properties.find(
        (property) => property.propertyId === selfProperty.propertyId,
      )
      const selfInverse = selfDatabase.properties.find(
        (property) => property.propertyId === selfConverted.inversePropertyId,
      )
      check(selfForward && selfInverse, "Self Relation conversion returns both properties")
      check(
        JSON.parse(selfForward.configJson).inversePropertyId === selfConverted.inversePropertyId &&
          JSON.parse(selfInverse.configJson).inversePropertyId === selfProperty.propertyId,
        "Self Relation properties point to each other",
      )

      const retargetDestination = selfCatalog.find(
        (database) => database.databaseId === projects.databaseId,
      )
      check(retargetDestination, "Retarget destination remains discoverable")
      const retargeted = await adapter.changeDatabasePropertyType({
        expectedGeneration: generation,
        databaseId: tasks.databaseId,
        propertyId: selfProperty.propertyId,
        expectedManifestRevision: selfConverted.manifestRevision,
        propertyType: "relation",
        operationId: `native-relation-retarget-${tasks.databaseId}`,
        expectedRelatedManifestRevisions: [
          { databaseId: projects.databaseId, revision: retargetDestination.manifestRevision },
        ],
        relationTargetDatabaseId: projects.databaseId,
      })
      check(
        retargeted.inversePropertyId && retargeted.manifestRevisions.length === 2,
        "Retargeting without a reciprocal-mode override keeps two-way Relation",
      )
      const retargetedCatalog = await adapter.listDatabases()
      const retargetedSource = retargetedCatalog.find(
        (database) => database.databaseId === tasks.databaseId,
      )
      const retargetedProperty = retargetedSource?.properties.find(
        (property) => property.propertyId === selfProperty.propertyId,
      )
      check(retargetedProperty, "Retargeted source property remains discoverable")
      check(
        JSON.parse(retargetedProperty.configJson).maxItems === 1,
        "Retargeting without a cardinality override preserves the one-page limit",
      )
      const formerSelfCounterpart = retargetedSource?.properties.find(
        (property) => property.propertyId === selfConverted.inversePropertyId,
      )
      check(
        formerSelfCounterpart && !JSON.parse(formerSelfCounterpart.configJson).inversePropertyId,
        "Retargeting preserves and detaches the former self counterpart",
      )

      const task = await adapter.createDatabaseRow({
        expectedGeneration: generation,
        databaseId: tasks.databaseId,
        title: "Task",
        template: { kind: "empty" },
      })
      const projectsPath = joinStoragePath(vaultPath, "Projects")
      const oldProjectNote = await adapter.createNote(vaultPath, projectsPath, "Old Project")
      const oldProject = noteId(oldProjectNote, "Project note is created with a durable identity")
      const newProjectNote = await adapter.createNote(vaultPath, projectsPath, "New Project")
      const newProject = noteId(
        newProjectNote,
        "Replacement project note is created with a durable identity",
      )

      // createNote is a normal note mutation, so publish the complete setup
      // before relation commands begin and use the resulting ownership map.
      await adapter.rebuildDatabaseProjection()
      const taskQuery = await queryDatabase(adapter, generation, tasks.databaseId)
      const projectQuery = await queryDatabase(adapter, generation, projects.databaseId)
      check(
        taskQuery.rows.some((row) => row.noteId === task.noteId),
        "Database row remains owned by Tasks",
      )
      check(
        projectQuery.rows.some((row) => row.noteId === oldProject) &&
          projectQuery.rows.some((row) => row.noteId === newProject),
        "Notes created inside Projects remain owned by Projects",
      )
      const initialTask = rowFor(
        taskQuery.rows,
        task.noteId,
        "Source task row is queryable before relation mutations",
      )
      const initialSourceRevision = initialTask.rowRevision
      let sourceRevision = initialSourceRevision
      const linkOperationId = `native-relation-link-${task.noteId}`
      const staleReplayOperationId = `native-relation-stale-${task.noteId}`
      const unlinkOperationId = `native-relation-unlink-${task.noteId}`
      const relinkOperationId = `native-relation-relink-${task.noteId}`
      const replacementOperationId = `native-relation-replace-${task.noteId}`

      const linked = await adapter.updateDatabaseRelationValue({
        expectedGeneration: generation,
        operationId: linkOperationId,
        databaseId: tasks.databaseId,
        noteId: task.noteId,
        propertyId: forward.propertyId,
        targetNoteIds: [oldProject],
        expectedRevision: sourceRevision,
      })
      sourceRevision = returnedRevision(
        linked,
        task.noteId,
        "Link returns the source note revision",
      )
      check(linked.operationId === linkOperationId, "Link returns its operation ID")
      check(
        linked.targetNoteIds.length === 1 && linked.targetNoteIds[0] === oldProject,
        "Link target is returned",
      )
      checkAffected(
        linked.affectedNotes,
        [
          { databaseId: tasks.databaseId, noteId: task.noteId },
          { databaseId: projects.databaseId, noteId: oldProject },
        ],
        "Link reports source and reciprocal target",
      )
      const linkedProjects = await queryDatabase(adapter, generation, projects.databaseId)
      const linkedOld = rowFor(linkedProjects.rows, oldProject, "Linked project row is queryable")
      check(
        relationTargets(linkedOld, inverse.propertyId).includes(task.noteId),
        "Inverse query reflects the link immediately",
      )
      const linkedState = await adapter.getDatabaseModuleState()
      check(
        linkedState.projection?.seq === linkedProjects.projection.seq,
        "Module projection sequence matches the latest inverse query",
      )

      const taskBytesAfterLink = await adapter.readFile(task.notePath)
      const oldProjectBytesAfterLink = await adapter.readFile(oldProjectNote.primaryPath!)
      const newProjectBytesBeforeStaleReplay = await adapter.readFile(newProjectNote.primaryPath!)
      check(
        (await sha256Utf8(taskBytesAfterLink)) === sourceRevision,
        "Link result revision matches the source note snapshot",
      )

      const replayedLink = await adapter.updateDatabaseRelationValue({
        expectedGeneration: generation,
        operationId: linkOperationId,
        databaseId: tasks.databaseId,
        noteId: task.noteId,
        propertyId: forward.propertyId,
        targetNoteIds: [oldProject],
        expectedRevision: initialSourceRevision,
      })
      checkReplayResult(
        replayedLink,
        linked,
        "Replaying an identical relation operation returns the original result",
      )
      check(
        (await adapter.readFile(task.notePath)) === taskBytesAfterLink &&
          (await adapter.readFile(oldProjectNote.primaryPath!)) === oldProjectBytesAfterLink &&
          (await adapter.readFile(newProjectNote.primaryPath!)) ===
            newProjectBytesBeforeStaleReplay,
        "Identical relation replay does not rewrite source or inverse bytes",
      )

      const reactivated = await adapter.loadVaultData(vaultPath)
      generation = reactivated.generation
      const schemaSourceBeforeReplay = await adapter.readFile(sourceManifestPath)
      const schemaTargetBeforeReplay = await adapter.readFile(targetManifestPath)
      const replayedSchemaAfterReactivation = await adapter.createDatabaseProperty({
        ...relationSchemaRequest,
        expectedGeneration: generation,
      })
      checkReplayResult(
        replayedSchemaAfterReactivation,
        forward,
        "Schema replay with the current generation survives vault reactivation",
      )
      const conversionSourceBeforeReplay = await adapter.readFile(sourceManifestPath)
      const conversionTargetBeforeReplay = await adapter.readFile(targetManifestPath)
      const replayedConversionAfterReactivation = await adapter.changeDatabasePropertyType({
        ...conversionRequest,
        expectedGeneration: generation,
      })
      checkReplayResult(
        replayedConversionAfterReactivation,
        converted,
        "Completed Relation conversion replay survives vault reactivation",
      )
      check(
        (await adapter.readFile(sourceManifestPath)) === conversionSourceBeforeReplay &&
          (await adapter.readFile(targetManifestPath)) === conversionTargetBeforeReplay,
        "Completed Relation conversion replay preserves current manifests",
      )
      let staleSchemaGenerationRejected = false
      try {
        await adapter.createDatabaseProperty(relationSchemaRequest)
      } catch (error) {
        staleSchemaGenerationRejected =
          error instanceof DatabaseOperationError && error.kind === "vaultGenerationConflict"
      }
      check(staleSchemaGenerationRejected, "Schema replay still requires the active generation")
      check(
        (await adapter.readFile(sourceManifestPath)) === schemaSourceBeforeReplay &&
          (await adapter.readFile(targetManifestPath)) === schemaTargetBeforeReplay,
        "Fresh-generation replay and stale-generation rejection preserve both manifests",
      )
      const replayedAfterReactivation = await adapter.updateDatabaseRelationValue({
        expectedGeneration: generation,
        operationId: linkOperationId,
        databaseId: tasks.databaseId,
        noteId: task.noteId,
        propertyId: forward.propertyId,
        targetNoteIds: [oldProject],
        expectedRevision: initialSourceRevision,
      })
      checkReplayResult(
        replayedAfterReactivation,
        linked,
        "Durable relation replay survives vault reactivation",
      )

      let reusedForTargetsRejected = false
      try {
        await adapter.updateDatabaseRelationValue({
          expectedGeneration: generation,
          operationId: linkOperationId,
          databaseId: tasks.databaseId,
          noteId: task.noteId,
          propertyId: forward.propertyId,
          targetNoteIds: [newProject],
          expectedRevision: initialSourceRevision,
        })
      } catch {
        reusedForTargetsRejected = true
      }
      check(reusedForTargetsRejected, "Reusing an operation ID with different targets is rejected")
      check(
        (await adapter.readFile(task.notePath)) === taskBytesAfterLink &&
          (await adapter.readFile(oldProjectNote.primaryPath!)) === oldProjectBytesAfterLink &&
          (await adapter.readFile(newProjectNote.primaryPath!)) ===
            newProjectBytesBeforeStaleReplay,
        "Target-mismatch operation reuse preserves relation bytes",
      )

      let reusedForRevisionRejected = false
      try {
        await adapter.updateDatabaseRelationValue({
          expectedGeneration: generation,
          operationId: linkOperationId,
          databaseId: tasks.databaseId,
          noteId: task.noteId,
          propertyId: forward.propertyId,
          targetNoteIds: [oldProject],
          expectedRevision: sourceRevision,
        })
      } catch {
        reusedForRevisionRejected = true
      }
      check(
        reusedForRevisionRejected,
        "Reusing an operation ID with a different expected revision is rejected",
      )
      check(
        (await adapter.readFile(task.notePath)) === taskBytesAfterLink &&
          (await adapter.readFile(oldProjectNote.primaryPath!)) === oldProjectBytesAfterLink &&
          (await adapter.readFile(newProjectNote.primaryPath!)) ===
            newProjectBytesBeforeStaleReplay,
        "Revision-mismatch operation reuse preserves relation bytes",
      )

      let staleReplayRejected = false
      try {
        await adapter.updateDatabaseRelationValue({
          expectedGeneration: generation,
          operationId: staleReplayOperationId,
          databaseId: tasks.databaseId,
          noteId: task.noteId,
          propertyId: forward.propertyId,
          targetNoteIds: [newProject],
          expectedRevision: initialSourceRevision,
        })
      } catch {
        staleReplayRejected = true
      }
      check(staleReplayRejected, "Replaying the initial source revision is rejected")
      check(
        (await adapter.readFile(task.notePath)) === taskBytesAfterLink &&
          (await adapter.readFile(oldProjectNote.primaryPath!)) === oldProjectBytesAfterLink &&
          (await adapter.readFile(newProjectNote.primaryPath!)) ===
            newProjectBytesBeforeStaleReplay,
        "Rejected stale relation replay preserves forward and inverse bytes",
      )
      const afterStaleReplay = await queryDatabase(adapter, generation, tasks.databaseId)
      const staleTask = rowFor(
        afterStaleReplay.rows,
        task.noteId,
        "Source task row remains queryable after stale relation replay",
      )
      check(
        relationTargets(staleTask, forward.propertyId).includes(oldProject),
        "Rejected stale relation replay preserves the forward query",
      )
      const afterStaleProjects = await queryDatabase(adapter, generation, projects.databaseId)
      const staleOldProject = rowFor(
        afterStaleProjects.rows,
        oldProject,
        "Old project row remains queryable after stale relation replay",
      )
      const staleNewProject = rowFor(
        afterStaleProjects.rows,
        newProject,
        "New project row remains queryable after stale relation replay",
      )
      check(
        relationTargets(staleOldProject, inverse.propertyId).includes(task.noteId) &&
          relationTargets(staleNewProject, inverse.propertyId).length === 0,
        "Rejected stale relation replay preserves inverse queries",
      )

      const unlinked = await adapter.updateDatabaseRelationValue({
        expectedGeneration: generation,
        operationId: unlinkOperationId,
        databaseId: tasks.databaseId,
        noteId: task.noteId,
        propertyId: forward.propertyId,
        targetNoteIds: [],
        expectedRevision: sourceRevision,
      })
      sourceRevision = returnedRevision(
        unlinked,
        task.noteId,
        "Unlink returns the source note revision",
      )
      check(unlinked.targetNoteIds.length === 0, "Unlink returns an empty target set")
      checkAffected(
        unlinked.affectedNotes,
        [
          { databaseId: tasks.databaseId, noteId: task.noteId },
          { databaseId: projects.databaseId, noteId: oldProject },
        ],
        "Unlink reports the old reciprocal target",
      )
      const relinked = await adapter.updateDatabaseRelationValue({
        expectedGeneration: generation,
        operationId: relinkOperationId,
        databaseId: tasks.databaseId,
        noteId: task.noteId,
        propertyId: forward.propertyId,
        targetNoteIds: [oldProject],
        expectedRevision: sourceRevision,
      })
      sourceRevision = returnedRevision(
        relinked,
        task.noteId,
        "Rapid relink returns the source note revision",
      )
      const replacementExpectedRevision = sourceRevision
      const replaced = await adapter.updateDatabaseRelationValue({
        expectedGeneration: generation,
        operationId: replacementOperationId,
        databaseId: tasks.databaseId,
        noteId: task.noteId,
        propertyId: forward.propertyId,
        targetNoteIds: [newProject],
        expectedRevision: sourceRevision,
      })
      sourceRevision = returnedRevision(
        replaced,
        task.noteId,
        "Replacement returns the source note revision",
      )
      checkAffected(
        replaced.affectedNotes,
        [
          { databaseId: tasks.databaseId, noteId: task.noteId },
          { databaseId: projects.databaseId, noteId: oldProject },
          { databaseId: projects.databaseId, noteId: newProject },
        ],
        "Replacement reports source, removed target, and new target",
      )
      const afterReplacement = await queryDatabase(adapter, generation, projects.databaseId)
      const replacedOld = rowFor(
        afterReplacement.rows,
        oldProject,
        "Removed project remains queryable",
      )
      const replacedNew = rowFor(afterReplacement.rows, newProject, "New project remains queryable")
      check(
        relationTargets(replacedOld, inverse.propertyId).length === 0,
        "Removed inverse is empty",
      )
      check(
        relationTargets(replacedNew, inverse.propertyId).includes(task.noteId),
        "New inverse points back to the task",
      )
      check(
        (await sha256Utf8(await adapter.readFile(task.notePath))) === sourceRevision,
        "Replacement result revision matches the source note snapshot",
      )

      const rebuiltState = await adapter.rebuildDatabaseProjection()
      const afterRebuild = await queryDatabase(adapter, generation, projects.databaseId)
      const rebuiltOld = rowFor(
        afterRebuild.rows,
        oldProject,
        "Rebuilt old project remains queryable",
      )
      const rebuiltNew = rowFor(
        afterRebuild.rows,
        newProject,
        "Rebuilt new project remains queryable",
      )
      check(
        relationTargets(rebuiltOld, inverse.propertyId).length === 0 &&
          relationTargets(rebuiltNew, inverse.propertyId).includes(task.noteId),
        "Explicit rebuild preserves replacement inverse values",
      )
      check(
        replacedOld.valuesJson === rebuiltOld.valuesJson &&
          replacedNew.valuesJson === rebuiltNew.valuesJson,
        "Incremental replacement matches explicit rebuild values",
      )
      check(
        rebuiltState.projection?.seq === afterRebuild.projection.seq,
        "Module projection sequence matches the rebuilt query",
      )

      const relationJournalPath = joinStoragePath(
        vaultPath,
        `.amby/recovery/database_relations/${replacementOperationId}.json`,
      )
      const relationJournal = JSON.parse(
        await adapter.readFile(relationJournalPath),
      ) as RelationRecoveryJournalFixture
      check(
        relationJournal.status === "completed" &&
          relationJournal.steps.length === 3 &&
          relationJournal.steps.every((step) => step.status === "applied") &&
          relationJournal.steps[0]?.noteId === task.noteId &&
          new Set(relationJournal.steps.map((step) => step.noteId)).size === 3 &&
          relationJournal.steps.some((step) => step.noteId === oldProject) &&
          relationJournal.steps.some((step) => step.noteId === newProject),
        "Replacement journal covers source and both inverse records",
      )
      const journalResult = JSON.stringify(relationJournal.result)
      const journalRequestRevision = relationJournal.requestRevision
      const recoveryFiles = await Promise.all(
        relationJournal.steps.map(async (step) => {
          const recordPath = joinStoragePath(vaultPath, step.recordPath)
          const backupPath = joinStoragePath(vaultPath, step.backupPath)
          return {
            recordPath,
            backupPath,
            pre: await adapter.readFile(backupPath),
            post: await adapter.readFile(recordPath),
          }
        }),
      )
      check(
        recoveryFiles[0]?.post === (await adapter.readFile(task.notePath)) &&
          recoveryFiles.every((file) => file.pre.length > 0),
        "Replacement journal backups and post bytes are readable",
      )

      for (const file of recoveryFiles) {
        await adapter.writeFile(file.recordPath, file.pre)
      }
      await adapter.writeFile(recoveryFiles[0]!.recordPath, recoveryFiles[0]!.post)
      relationJournal.status = "inProgress"
      relationJournal.steps.forEach((step, index) => {
        step.status = index === 0 ? "applied" : "planned"
      })
      check(
        JSON.stringify(relationJournal.result) === journalResult &&
          relationJournal.requestRevision === journalRequestRevision,
        "Crash-window fixture keeps journal outcome and request revision intact",
      )
      await adapter.writeFile(relationJournalPath, `${JSON.stringify(relationJournal, null, 2)}\n`)
      for (const [index, file] of recoveryFiles.entries()) {
        check(
          (await adapter.readFile(file.recordPath)) === (index === 0 ? file.post : file.pre),
          "Crash-window fixture leaves only the source publish applied",
        )
      }

      const recovered = await adapter.loadVaultData(vaultPath)
      generation = recovered.generation
      const recoveredFilesJournal = JSON.parse(
        await adapter.readFile(relationJournalPath),
      ) as RelationRecoveryJournalFixture
      check(
        recoveredFilesJournal.status === "rolledBack" &&
          recoveredFilesJournal.steps.every((step) => step.status === "rolledBack") &&
          recoveredFilesJournal.result === null &&
          recoveredFilesJournal.requestRevision === journalRequestRevision,
        "Vault activation rolls back the controlled Relation crash window",
      )
      for (const file of recoveryFiles) {
        check(
          (await adapter.readFile(file.recordPath)) === file.pre,
          "Recovery restores every Relation record byte-for-byte",
        )
      }
      const recoveredTaskQuery = await queryDatabase(adapter, generation, tasks.databaseId)
      const recoveredTask = rowFor(
        recoveredTaskQuery.rows,
        task.noteId,
        "Recovered source task remains queryable",
      )
      check(
        relationTargets(recoveredTask, forward.propertyId).includes(oldProject),
        "Recovered source query restores the old relation target",
      )
      const recoveredProjectsQuery = await queryDatabase(adapter, generation, projects.databaseId)
      const recoveredOld = rowFor(
        recoveredProjectsQuery.rows,
        oldProject,
        "Recovered old project remains queryable",
      )
      const recoveredNew = rowFor(
        recoveredProjectsQuery.rows,
        newProject,
        "Recovered new project remains queryable",
      )
      check(
        relationTargets(recoveredOld, inverse.propertyId).includes(task.noteId) &&
          relationTargets(recoveredNew, inverse.propertyId).length === 0,
        "Recovered inverse query matches the pre-replacement relation",
      )

      const reactivatedAgain = await adapter.loadVaultData(vaultPath)
      generation = reactivatedAgain.generation
      const noOpJournal = JSON.parse(
        await adapter.readFile(relationJournalPath),
      ) as RelationRecoveryJournalFixture
      check(
        noOpJournal.status === "rolledBack" &&
          noOpJournal.steps.every((step) => step.status === "rolledBack"),
        "A second vault activation leaves rolled-back Relation recovery unchanged",
      )

      let rolledBackReuseRejected = false
      try {
        await adapter.updateDatabaseRelationValue({
          expectedGeneration: generation,
          operationId: replacementOperationId,
          databaseId: tasks.databaseId,
          noteId: task.noteId,
          propertyId: forward.propertyId,
          targetNoteIds: [newProject],
          expectedRevision: replacementExpectedRevision,
        })
      } catch {
        rolledBackReuseRejected = true
      }
      check(rolledBackReuseRejected, "Rolled-back operation ID reuse is rejected")
      for (const file of recoveryFiles) {
        check(
          (await adapter.readFile(file.recordPath)) === file.pre,
          "Rolled-back operation ID reuse preserves restored bytes",
        )
      }

      const schemaJournalPath = joinStoragePath(
        vaultPath,
        `.amby/recovery/database_relation_schemas/${relationSchemaOperationId}.json`,
      )
      const schemaJournal = JSON.parse(
        await adapter.readFile(schemaJournalPath),
      ) as RelationSchemaRecoveryJournalFixture
      check(
        schemaJournal.status === "completed" &&
          schemaJournal.steps.length === 2 &&
          schemaJournal.steps.every((step) => step.status === "applied"),
        "Reciprocal Relation schema journal is complete before the crash fixture",
      )
      const schemaJournalResult = JSON.stringify(schemaJournal.result)
      const schemaJournalRequestRevision = schemaJournal.requestRevision
      const schemaRecoveryFiles = await Promise.all(
        schemaJournal.steps.map(async (step) => {
          const manifestPath = joinStoragePath(
            vaultPath,
            schemaManifestPath(step, "Schema journal manifest path is present"),
          )
          const backupPath = joinStoragePath(vaultPath, step.backupPath)
          const post =
            step.databaseId === tasks.databaseId
              ? sourceManifestAfterCreate
              : targetManifestAfterCreate
          check(
            (await adapter.readFile(backupPath)).length > 0,
            "Schema journal backup bytes are readable",
          )
          return {
            databaseId: step.databaseId,
            manifestPath,
            backupPath,
            pre: await adapter.readFile(backupPath),
            post,
          }
        }),
      )
      check(
        schemaRecoveryFiles.some((file) => file.databaseId === tasks.databaseId) &&
          schemaRecoveryFiles.some((file) => file.databaseId === projects.databaseId),
        "Schema journal covers both reciprocal manifests",
      )
      for (const file of schemaRecoveryFiles) {
        await adapter.writeFile(file.manifestPath, file.pre)
      }
      const sourceSchemaRecovery = schemaRecoveryFiles.find(
        (file) => file.databaseId === tasks.databaseId,
      )
      check(sourceSchemaRecovery, "Schema journal source step is present")
      await adapter.writeFile(sourceSchemaRecovery.manifestPath, sourceSchemaRecovery.post)
      schemaJournal.status = "inProgress"
      schemaJournal.steps.forEach((step, index) => {
        step.status = index === 0 ? "applied" : "planned"
      })
      check(
        JSON.stringify(schemaJournal.result) === schemaJournalResult &&
          schemaJournal.requestRevision === schemaJournalRequestRevision,
        "Schema crash-window fixture preserves its outcome and request revision",
      )
      await adapter.writeFile(schemaJournalPath, `${JSON.stringify(schemaJournal, null, 2)}\n`)
      for (const file of schemaRecoveryFiles) {
        check(
          (await adapter.readFile(file.manifestPath)) ===
            (file.databaseId === tasks.databaseId ? file.post : file.pre),
          "Schema crash-window fixture leaves only the source publish applied",
        )
      }

      const recoveredSchemaVault = await adapter.loadVaultData(vaultPath)
      generation = recoveredSchemaVault.generation
      const recoveredSchemaJournal = JSON.parse(
        await adapter.readFile(schemaJournalPath),
      ) as RelationSchemaRecoveryJournalFixture
      check(
        recoveredSchemaJournal.status === "rolledBack" &&
          recoveredSchemaJournal.steps.every((step) => step.status === "rolledBack") &&
          recoveredSchemaJournal.result === null &&
          recoveredSchemaJournal.requestRevision === schemaJournalRequestRevision,
        "Vault activation rolls back the controlled Relation schema crash window",
      )
      for (const file of schemaRecoveryFiles) {
        check(
          (await adapter.readFile(file.manifestPath)) === file.pre,
          "Schema recovery restores every manifest byte-for-byte",
        )
      }
      const recoveredSchemaSource = await queryDatabase(adapter, generation, tasks.databaseId)
      const recoveredSchemaTarget = await queryDatabase(adapter, generation, projects.databaseId)
      check(
        !recoveredSchemaSource.database.properties.some(
          (property) => property.propertyId === forward.propertyId,
        ) &&
          !recoveredSchemaTarget.database.properties.some(
            (property) => property.propertyId === forward.inversePropertyId,
          ),
        "Activation rebuilds both schema projections after rollback",
      )
      const noOpSchemaVault = await adapter.loadVaultData(vaultPath)
      generation = noOpSchemaVault.generation
      const noOpSchemaJournal = JSON.parse(
        await adapter.readFile(schemaJournalPath),
      ) as RelationSchemaRecoveryJournalFixture
      check(
        noOpSchemaJournal.status === "rolledBack" &&
          noOpSchemaJournal.steps.every((step) => step.status === "rolledBack"),
        "A second vault activation leaves rolled-back schema recovery unchanged",
      )
      let rolledBackSchemaReuseRejected = false
      try {
        await adapter.createDatabaseProperty({
          ...relationSchemaRequest,
          expectedGeneration: generation,
        })
      } catch {
        rolledBackSchemaReuseRejected = true
      }
      check(rolledBackSchemaReuseRejected, "Rolled-back schema operation ID reuse is rejected")
      for (const file of schemaRecoveryFiles) {
        check(
          (await adapter.readFile(file.manifestPath)) === file.pre,
          "Rolled-back schema operation reuse preserves restored bytes",
        )
      }
    },
  },
  {
    name: "native database cover assets resolve only validated image files",
    async run({ adapter, vaultPath }) {
      const { generation } = await adapter.loadActiveVaultData()
      const state = await adapter.getDatabaseModuleState()
      if (!state.enabled) await adapter.setDatabaseModuleEnabled(true, generation)
      await adapter.rebuildDatabaseProjection()
      const media = await adapter.createDatabase({
        expectedGeneration: generation,
        mode: "standalone",
        parentPath: vaultPath,
        name: "Covers",
      })
      const row = await adapter.createDatabaseRow({
        expectedGeneration: generation,
        databaseId: media.databaseId,
        title: "With cover",
        template: { kind: "empty" },
      })
      const source = joinStoragePath(vaultPath, "cover-source.png")
      await adapter.writeFile(source, "cover-bytes")
      const imported = await adapter.importDatabaseAsset({
        expectedGeneration: generation,
        databaseId: media.databaseId,
        noteId: row.noteId,
        sourcePath: source,
      })
      const resolved = await adapter.resolveDatabaseAssetPaths({
        expectedGeneration: generation,
        databaseId: media.databaseId,
        relativePaths: [
          imported.relativePath,
          `assets/${row.noteId}/missing.png`,
          `assets/${row.noteId}/../../../cover-source.png`,
          "https://example.com/cover.png",
        ],
      })
      check(resolved.paths.length === 4, "One result per requested path")
      check(resolved.paths[0], "The imported image resolves to a file path")
      check(
        (await adapter.readFile(resolved.paths[0])) === "cover-bytes",
        "The resolved path is the imported asset",
      )
      check(
        resolved.paths.slice(1).every((path) => path === null),
        "Missing, traversal and external paths do not resolve",
      )
    },
  },
  {
    name: "native relation candidates are searched on the server beyond the first hundred pages",
    async run({ adapter, vaultPath }) {
      const { generation } = await adapter.loadActiveVaultData()
      const state = await adapter.getDatabaseModuleState()
      if (!state.enabled) await adapter.setDatabaseModuleEnabled(true, generation)
      const pages = await adapter.createDatabase({
        expectedGeneration: generation,
        mode: "standalone",
        parentPath: vaultPath,
        name: "Lookup Targets",
      })
      const created: string[] = []
      for (let index = 1; index <= 105; index += 1) {
        const row = await adapter.createDatabaseRow({
          expectedGeneration: generation,
          databaseId: pages.databaseId,
          title: `Target ${String(index).padStart(3, "0")}`,
          template: { kind: "empty" },
        })
        created.push(row.noteId)
      }
      await adapter.rebuildDatabaseProjection()

      const first = await adapter.searchRelationCandidates({
        expectedGeneration: generation,
        databaseId: pages.databaseId,
        limit: 100,
      })
      check(first.candidates.length === 100 && first.nextCursor, "The first page is full")
      const second = await adapter.searchRelationCandidates({
        expectedGeneration: generation,
        databaseId: pages.databaseId,
        limit: 100,
        cursor: first.nextCursor,
      })
      check(second.candidates.length === 5 && !second.nextCursor, "The cursor reaches the rest")
      const all = new Set([...first.candidates, ...second.candidates].map((item) => item.noteId))
      check(all.size === 105, "Paging neither skips nor repeats a page")

      const found = await adapter.searchRelationCandidates({
        expectedGeneration: generation,
        databaseId: pages.databaseId,
        search: "target 104",
      })
      check(
        found.candidates.length === 1 && found.candidates[0].title === "Target 104",
        "A page after the first hundred is found by title",
      )

      const resolved = await adapter.resolveRecordReferences({
        expectedGeneration: generation,
        noteIds: [created[103], "01J00000000000000000000000"],
      })
      check(
        resolved.references[0].state === "ok" && resolved.references[0].title === "Target 104",
        "A selected far-away page is named by its ID",
      )
      check(resolved.references[1].state === "missing", "An unknown ID is reported as missing")

      let wrongGeneration = false
      try {
        await adapter.searchRelationCandidates({
          expectedGeneration: generation + 1,
          databaseId: pages.databaseId,
        })
      } catch {
        wrongGeneration = true
      }
      check(wrongGeneration, "A stale vault generation is rejected")
    },
  },
  {
    name: "native saved view keeps filter, widths and wrapping through validation and rebuild",
    async run({ adapter, vaultPath }) {
      const { generation } = await adapter.loadActiveVaultData()
      const state = await adapter.getDatabaseModuleState()
      if (!state.enabled) await adapter.setDatabaseModuleEnabled(true, generation)
      const created = await adapter.createDatabase({
        expectedGeneration: generation,
        mode: "standalone",
        parentPath: vaultPath,
        name: "Saved View Scores",
      })
      const score = await adapter.createDatabaseProperty({
        expectedGeneration: generation,
        databaseId: created.databaseId,
        expectedManifestRevision: created.manifestRevision,
        name: "Score",
        propertyType: "number",
        options: [],
      })
      const values = [5, 10]
      for (const [index, value] of values.entries()) {
        const row = await adapter.createDatabaseRow({
          expectedGeneration: generation,
          databaseId: created.databaseId,
          title: `Row ${index}`,
          template: { kind: "empty" },
        })
        await adapter.applyDatabaseValueBatch({
          expectedGeneration: generation,
          databaseId: created.databaseId,
          operationId: `native-saved-view-${index}-${created.databaseId}`,
          cells: [
            {
              noteId: row.noteId,
              propertyId: score.propertyId,
              valueJson: JSON.stringify({ type: "number", decimal: String(value) }),
              expectedRevision: row.recordRevision,
            },
          ],
        })
      }
      await adapter.rebuildDatabaseProjection()

      const summary = (await adapter.listDatabases()).find(
        (database) => database.databaseId === created.databaseId,
      )
      const view = summary?.views[0]
      check(view, "A new database has its default view")
      const loaded = await adapter.getDatabaseView({
        expectedGeneration: generation,
        databaseId: created.databaseId,
        viewId: view.viewId,
        expectedViewRevision: view.revision,
      })
      const nextConfig = applySettingsPatch(loaded.configJson, {
        filter: conditionsToFilter([
          {
            field: { kind: "property", propertyId: score.propertyId },
            operator: "greaterOrEqual",
            operand: "7",
          },
        ]),
        widths: { [score.propertyId]: 240, title: 300 },
        wrapped: [score.propertyId],
        frozenKey: "title",
        hidden: [],
      })
      const saved = await adapter.updateDatabaseViewConfig({
        expectedGeneration: generation,
        databaseId: created.databaseId,
        viewId: view.viewId,
        expectedViewRevision: loaded.revision,
        configJson: nextConfig,
      })
      check(saved.viewRevision !== loaded.revision, "The save produced a new view revision")

      let stale = false
      try {
        await adapter.updateDatabaseViewConfig({
          expectedGeneration: generation,
          databaseId: created.databaseId,
          viewId: view.viewId,
          expectedViewRevision: loaded.revision,
          configJson: nextConfig,
        })
      } catch {
        stale = true
      }
      check(stale, "A write based on an outdated view revision is rejected")

      await adapter.rebuildDatabaseProjection()
      const after = (await adapter.listDatabases())
        .find((database) => database.databaseId === created.databaseId)
        ?.views.find((candidate) => candidate.viewId === view.viewId)
      check(after, "The view survives a projection rebuild")
      const reread = await adapter.getDatabaseView({
        expectedGeneration: generation,
        databaseId: created.databaseId,
        viewId: view.viewId,
        expectedViewRevision: after.revision,
      })
      const settings = parseViewSettings(reread.configJson)
      check(settings.widths[score.propertyId] === 240, "The saved column width is kept")
      check(settings.wrapped.includes(score.propertyId), "The saved wrapping is kept")
      check(settings.frozenKey === "title", "The saved frozen column is kept")

      const result = await adapter.queryDatabase({
        expectedGeneration: generation,
        databaseId: created.databaseId,
        source: { kind: "inline", spec: { sorts: [] } },
        filter: toQueryFilter(settings.filter),
        page: { limit: 10 },
      })
      check(
        result.rows.length === 1 && result.rows[0].title === "Row 1",
        "The saved >= 7 filter returns only the matching row",
      )
    },
  },
  {
    name: "native board lanes count the whole view and page each lane on its own",
    async run({ adapter, vaultPath }) {
      const { generation } = await adapter.loadActiveVaultData()
      const state = await adapter.getDatabaseModuleState()
      if (!state.enabled) await adapter.setDatabaseModuleEnabled(true, generation)
      const created = await adapter.createDatabase({
        expectedGeneration: generation,
        mode: "standalone",
        parentPath: vaultPath,
        name: "Board Lanes",
      })
      const status = await adapter.createDatabaseProperty({
        expectedGeneration: generation,
        databaseId: created.databaseId,
        expectedManifestRevision: created.manifestRevision,
        name: "Stage",
        propertyType: "status",
        options: ["Todo", "Done"],
      })
      const summary = (await adapter.listDatabases()).find(
        (database) => database.databaseId === created.databaseId,
      )
      const property = summary?.properties.find(
        (candidate) => candidate.propertyId === status.propertyId,
      )
      const todo = property?.options.find((option) => option.name === "Todo")
      const done = property?.options.find((option) => option.name === "Done")
      check(todo && done, "The status options were created with IDs")

      const placements: Array<string | null> = [
        todo.optionId,
        todo.optionId,
        todo.optionId,
        done.optionId,
        null,
      ]
      for (const [index, optionId] of placements.entries()) {
        const row = await adapter.createDatabaseRow({
          expectedGeneration: generation,
          databaseId: created.databaseId,
          title: `Card ${index}`,
          template: { kind: "empty" },
        })
        if (!optionId) continue
        await adapter.applyDatabaseValueBatch({
          expectedGeneration: generation,
          databaseId: created.databaseId,
          operationId: `native-board-${index}-${created.databaseId}`,
          cells: [
            {
              noteId: row.noteId,
              propertyId: status.propertyId,
              valueJson: JSON.stringify({ type: "status", optionId }),
              expectedRevision: row.recordRevision,
            },
          ],
        })
      }
      await adapter.rebuildDatabaseProjection()

      const aggregate = await adapter.aggregateDatabase({
        expectedGeneration: generation,
        databaseId: created.databaseId,
        source: { kind: "inline", spec: { sorts: [] } },
        category: { kind: "property", propertyId: status.propertyId },
        aggregation: "count",
        limit: 256,
      })
      const counts = Object.fromEntries(aggregate.groups.map((group) => [group.key, group.count]))
      check(
        counts[todo.optionId] === 3 && counts[done.optionId] === 1 && counts.__empty__ === 1,
        "Group counts cover the whole database, including the no-value group",
      )

      const lane = (operator: string, value?: string, cursor?: string) =>
        adapter.queryDatabase({
          expectedGeneration: generation,
          databaseId: created.databaseId,
          source: { kind: "inline", spec: { sorts: [] } },
          filter: {
            kind: "condition",
            field: { kind: "property", propertyId: status.propertyId },
            operator,
            ...(value ? { value: JSON.stringify(value) } : {}),
          },
          page: { limit: 2, cursor },
        })
      const first = await lane("equals", todo.optionId)
      check(first.rows.length === 2 && first.nextCursor, "A lane pages by its own cursor")
      const second = await lane("equals", todo.optionId, first.nextCursor)
      check(second.rows.length === 1 && !second.nextCursor, "The lane's last page ends the cursor")
      const empty = await lane("isEmpty")
      check(
        empty.rows.length === 1 && empty.rows[0].title === "Card 4",
        "The no-value lane finds its card",
      )

      // The board's columns are chosen in the view: the saved group shows in the catalog.
      const view = summary?.views[0]
      check(view, "The database has its default view")
      const loadedView = await adapter.getDatabaseView({
        expectedGeneration: generation,
        databaseId: created.databaseId,
        viewId: view.viewId,
        expectedViewRevision: view.revision,
      })
      const grouped = applySettingsPatch(loadedView.configJson, { groupBy: status.propertyId })
      await adapter.updateDatabaseViewConfig({
        expectedGeneration: generation,
        databaseId: created.databaseId,
        viewId: view.viewId,
        expectedViewRevision: loadedView.revision,
        configJson: grouped,
      })
      await adapter.rebuildDatabaseProjection()
      const groupedView = (await adapter.listDatabases())
        .find((database) => database.databaseId === created.databaseId)
        ?.views.find((candidate) => candidate.viewId === view.viewId)
      check(
        groupedView?.groupField?.kind === "property" &&
          groupedView.groupField.propertyId === status.propertyId,
        "The saved board grouping is reported by the view catalog",
      )
    },
  },
  {
    name: "native rollup counts hours and progress and recalculates without a rebuild",
    async run({ adapter, vaultPath }) {
      const { generation } = await adapter.loadActiveVaultData()
      const state = await adapter.getDatabaseModuleState()
      if (!state.enabled) await adapter.setDatabaseModuleEnabled(true, generation)
      const projects = await adapter.createDatabase({
        expectedGeneration: generation,
        mode: "standalone",
        parentPath: vaultPath,
        name: "Rollup Projects",
      })
      const tasks = await adapter.createDatabase({
        expectedGeneration: generation,
        mode: "standalone",
        parentPath: vaultPath,
        name: "Rollup Tasks",
      })
      const hours = await adapter.createDatabaseProperty({
        expectedGeneration: generation,
        databaseId: tasks.databaseId,
        expectedManifestRevision: tasks.manifestRevision,
        name: "Hours",
        propertyType: "number",
      })
      const done = await adapter.createDatabaseProperty({
        expectedGeneration: generation,
        databaseId: tasks.databaseId,
        expectedManifestRevision: hours.manifestRevision,
        name: "Done",
        propertyType: "checkbox",
      })
      const link = await adapter.createDatabaseProperty({
        expectedGeneration: generation,
        databaseId: projects.databaseId,
        expectedManifestRevision: projects.manifestRevision,
        name: "Tasks",
        propertyType: "relation",
        relationTargetDatabaseId: tasks.databaseId,
      })
      let revision = link.manifestRevision
      let rejected = false
      try {
        await adapter.createDatabaseProperty({
          expectedGeneration: generation,
          databaseId: projects.databaseId,
          expectedManifestRevision: revision,
          name: "Bad",
          propertyType: "rollup",
          rollupRelationPropertyId: link.propertyId,
          rollupTargetPropertyId: done.propertyId,
          rollupAggregation: "sum",
        })
      } catch {
        rejected = true
      }
      check(rejected, "A sum over a checkbox is refused")
      const total = await adapter.createDatabaseProperty({
        expectedGeneration: generation,
        databaseId: projects.databaseId,
        expectedManifestRevision: revision,
        name: "Total hours",
        propertyType: "rollup",
        rollupRelationPropertyId: link.propertyId,
        rollupTargetPropertyId: hours.propertyId,
        rollupAggregation: "sum",
      })
      revision = total.manifestRevision
      const progress = await adapter.createDatabaseProperty({
        expectedGeneration: generation,
        databaseId: projects.databaseId,
        expectedManifestRevision: revision,
        name: "Progress",
        propertyType: "rollup",
        rollupRelationPropertyId: link.propertyId,
        rollupTargetPropertyId: done.propertyId,
        rollupAggregation: "percentChecked",
      })

      const project = await adapter.createDatabaseRow({
        expectedGeneration: generation,
        databaseId: projects.databaseId,
        title: "Site",
        template: { kind: "empty" },
      })
      const taskIds: string[] = []
      const taskRows = []
      for (const [index, hoursValue] of ["4", "6", "0"].entries()) {
        const task = await adapter.createDatabaseRow({
          expectedGeneration: generation,
          databaseId: tasks.databaseId,
          title: `Task ${index}`,
          template: { kind: "empty" },
        })
        const written = await adapter.applyDatabaseValueBatch({
          expectedGeneration: generation,
          databaseId: tasks.databaseId,
          operationId: `native-rollup-hours-${index}-${tasks.databaseId}`,
          cells: [
            {
              noteId: task.noteId,
              propertyId: hours.propertyId,
              valueJson: JSON.stringify({ type: "number", decimal: hoursValue }),
              expectedRevision: task.recordRevision,
            },
          ],
        })
        taskIds.push(task.noteId)
        taskRows.push({ ...task, revision: written.revisions[0].revision })
      }
      await adapter.rebuildDatabaseProjection()
      const projectRows = await adapter.queryDatabase({
        expectedGeneration: generation,
        databaseId: projects.databaseId,
        source: { kind: "inline", spec: { sorts: [] } },
        page: { limit: 10 },
      })
      const projectRow = projectRows.rows.find((row) => row.noteId === project.noteId)
      check(projectRow, "The project row is queryable")
      await adapter.updateDatabaseRelationValue({
        expectedGeneration: generation,
        operationId: `native-rollup-link-${projects.databaseId}`,
        databaseId: projects.databaseId,
        noteId: project.noteId,
        propertyId: link.propertyId,
        targetNoteIds: taskIds,
        expectedRevision: projectRow.rowRevision,
      })

      const rollups = async () => {
        const result = await adapter.queryDatabase({
          expectedGeneration: generation,
          databaseId: projects.databaseId,
          source: { kind: "inline", spec: { sorts: [] } },
          page: { limit: 10 },
        })
        const values = JSON.parse(result.rows[0].valuesJson) as Record<
          string,
          { decimal?: string; type: string }
        >
        return { total: values[total.propertyId], progress: values[progress.propertyId] }
      }
      const first = await rollups()
      check(first.total?.decimal === "10", "The sum of related hours is 10")
      check(first.progress?.decimal === "0.00", "No task is done yet: 0 percent, not empty")

      // Completing a task changes the project's progress without a rebuild.
      await adapter.applyDatabaseValueBatch({
        expectedGeneration: generation,
        databaseId: tasks.databaseId,
        operationId: `native-rollup-done-${tasks.databaseId}`,
        cells: [
          {
            noteId: taskIds[0],
            propertyId: done.propertyId,
            valueJson: JSON.stringify({ type: "checkbox", checked: true }),
            expectedRevision: taskRows[0].revision,
          },
        ],
      })
      const second = await rollups()
      check(second.progress?.decimal === "33.33", "One of three tasks done: 33.33 percent")
    },
  },
  {
    name: "native current-page filter shows only the records linked to the given page",
    async run({ adapter, vaultPath }) {
      const { generation } = await adapter.loadActiveVaultData()
      const state = await adapter.getDatabaseModuleState()
      if (!state.enabled) await adapter.setDatabaseModuleEnabled(true, generation)
      const projects = await adapter.createDatabase({
        expectedGeneration: generation,
        mode: "standalone",
        parentPath: vaultPath,
        name: "Context Projects",
      })
      const tasks = await adapter.createDatabase({
        expectedGeneration: generation,
        mode: "standalone",
        parentPath: vaultPath,
        name: "Context Tasks",
      })
      const project = await adapter.createDatabaseProperty({
        expectedGeneration: generation,
        databaseId: tasks.databaseId,
        expectedManifestRevision: tasks.manifestRevision,
        name: "Project",
        propertyType: "relation",
        relationTargetDatabaseId: projects.databaseId,
      })
      const first = await adapter.createDatabaseRow({
        expectedGeneration: generation,
        databaseId: projects.databaseId,
        title: "Site",
        template: { kind: "empty" },
      })
      const second = await adapter.createDatabaseRow({
        expectedGeneration: generation,
        databaseId: projects.databaseId,
        title: "App",
        template: { kind: "empty" },
      })
      const mine = await adapter.createDatabaseRow({
        expectedGeneration: generation,
        databaseId: tasks.databaseId,
        title: "Site task",
        template: { kind: "empty" },
      })
      await adapter.createDatabaseRow({
        expectedGeneration: generation,
        databaseId: tasks.databaseId,
        title: "Unlinked task",
        template: { kind: "empty" },
      })
      await adapter.rebuildDatabaseProjection()
      const before = await adapter.queryDatabase({
        expectedGeneration: generation,
        databaseId: tasks.databaseId,
        source: { kind: "inline", spec: { sorts: [] } },
        page: { limit: 10 },
      })
      const mineRow = before.rows.find((row) => row.noteId === mine.noteId)
      check(mineRow, "The task row is queryable")
      await adapter.updateDatabaseRelationValue({
        expectedGeneration: generation,
        operationId: `native-context-link-${tasks.databaseId}`,
        databaseId: tasks.databaseId,
        noteId: mine.noteId,
        propertyId: project.propertyId,
        targetNoteIds: [first.noteId],
        expectedRevision: mineRow.rowRevision,
      })

      const ask = (contextPageId?: string) =>
        adapter.queryDatabase({
          expectedGeneration: generation,
          databaseId: tasks.databaseId,
          source: { kind: "inline", spec: { sorts: [] } },
          filter: {
            kind: "condition",
            field: { kind: "property", propertyId: project.propertyId },
            operator: "contains",
            value: JSON.stringify("@currentPage"),
          },
          page: { limit: 10 },
          contextPageId,
        })
      const forSite = await ask(first.noteId)
      check(
        forSite.rows.length === 1 && forSite.rows[0].title === "Site task",
        "The project's own page shows its task",
      )
      const forApp = await ask(second.noteId)
      check(forApp.rows.length === 0, "Another project's page shows nothing")
      let withoutPage = false
      try {
        await ask()
      } catch {
        withoutPage = true
      }
      check(withoutPage, "Without a page the filter is an error, not every task")
    },
  },
  {
    name: "native option edits keep ids, keep old names resolving and never rewrite records",
    async run({ adapter, vaultPath }) {
      const { generation } = await adapter.loadActiveVaultData()
      const state = await adapter.getDatabaseModuleState()
      if (!state.enabled) await adapter.setDatabaseModuleEnabled(true, generation)
      const created = await adapter.createDatabase({
        expectedGeneration: generation,
        mode: "standalone",
        parentPath: vaultPath,
        name: "Option Edits",
      })
      const select = await adapter.createDatabaseProperty({
        expectedGeneration: generation,
        databaseId: created.databaseId,
        expectedManifestRevision: created.manifestRevision,
        name: "Kind",
        propertyType: "select",
        options: ["Todo", "Doing"],
      })
      const summaryOf = async () =>
        (await adapter.listDatabases()).find(
          (database) => database.databaseId === created.databaseId,
        )
      const optionsOf = async () =>
        (await summaryOf())?.properties.find(
          (candidate) => candidate.propertyId === select.propertyId,
        )?.options ?? []
      const [todo, doing] = await optionsOf()
      check(todo?.name === "Todo" && doing?.name === "Doing", "The options were created with IDs")

      const setOption = async (title: string, optionId: string) => {
        const row = await adapter.createDatabaseRow({
          expectedGeneration: generation,
          databaseId: created.databaseId,
          title,
          template: { kind: "empty" },
        })
        await adapter.applyDatabaseValueBatch({
          expectedGeneration: generation,
          databaseId: created.databaseId,
          operationId: `native-options-${title.split(" ")[0].toLowerCase()}-${created.databaseId}`,
          cells: [
            {
              noteId: row.noteId,
              propertyId: select.propertyId,
              valueJson: JSON.stringify({ type: "select", optionId }),
              expectedRevision: row.recordRevision,
            },
          ],
        })
        return row.noteId
      }
      const doingCard = await setOption("Doing card", doing.optionId)
      const todoCard = await setOption("Todo card", todo.optionId)
      const manifestRevision = (await summaryOf())?.manifestRevision
      check(manifestRevision, "The manifest revision is known")

      const updated = await adapter.updateDatabasePropertyOptions({
        expectedGeneration: generation,
        databaseId: created.databaseId,
        propertyId: select.propertyId,
        expectedManifestRevision: manifestRevision,
        // Rename and recolor "Todo", drop "Doing", add "Done".
        options: [
          { id: todo.optionId, name: "To do", color: "#EF4444" },
          { name: "Done", color: "#22c55e" },
        ],
      })
      check(
        updated.options.length === 2 &&
          updated.options[0].id === todo.optionId &&
          updated.options[0].name === "To do" &&
          updated.options[0].color === "#ef4444" &&
          updated.options[1].name === "Done",
        "The saved list keeps the ID of a renamed option and assigns one to a new option",
      )
      const afterUpdate = await optionsOf()
      check(
        afterUpdate.map((option) => option.name).join() === "To do,Done" &&
          !afterUpdate.some((option) => option.optionId === doing.optionId),
        "The catalog shows the new list without the removed option",
      )

      // Records store the option name and a renamed option keeps its old name as an
      // alias, so the renamed card still points at the same option after a rebuild.
      await adapter.rebuildDatabaseProjection()
      const result = await queryDatabase(adapter, generation, created.databaseId)
      const valueOf = (noteId: string) =>
        (
          JSON.parse(rowFor(result.rows, noteId, "The card is listed").valuesJson) as Record<
            string,
            { optionId?: string } | undefined
          >
        )[select.propertyId]?.optionId
      check(
        valueOf(todoCard) === todo.optionId,
        "A renamed option still resolves the records written with its old name",
      )
      // The removed option stays in the record: deleting an option never loses data.
      const kept = valueOf(doingCard)
      check(
        kept === doing.optionId || kept === doing.name,
        `The record keeps the removed option's value (${kept})`,
      )

      let stale = false
      try {
        await adapter.updateDatabasePropertyOptions({
          expectedGeneration: generation,
          databaseId: created.databaseId,
          propertyId: select.propertyId,
          expectedManifestRevision: manifestRevision,
          options: [],
        })
      } catch {
        stale = true
      }
      check(stale, "An edit based on an old manifest revision is refused")
      check((await optionsOf()).length === 2, "A refused edit changes nothing")
    },
  },
  {
    name: "native property settings change formats, and a date keeps its values valid",
    async run({ adapter, vaultPath }) {
      const { generation } = await adapter.loadActiveVaultData()
      const state = await adapter.getDatabaseModuleState()
      if (!state.enabled) await adapter.setDatabaseModuleEnabled(true, generation)
      const created = await adapter.createDatabase({
        expectedGeneration: generation,
        mode: "standalone",
        parentPath: vaultPath,
        name: "Property Settings",
      })
      const date = await adapter.createDatabaseProperty({
        expectedGeneration: generation,
        databaseId: created.databaseId,
        expectedManifestRevision: created.manifestRevision,
        name: "Due",
        propertyType: "date",
        options: [],
      })
      const summary = async () =>
        (await adapter.listDatabases()).find(
          (database) => database.databaseId === created.databaseId,
        )
      const configOf = async () =>
        JSON.parse(
          (await summary())?.properties.find((property) => property.propertyId === date.propertyId)
            ?.configJson ?? "{}",
        ) as Record<string, unknown>
      const revision = async () => {
        const current = (await summary())?.manifestRevision
        check(current, "The manifest revision is known")
        return current
      }
      const change = async (patch: Record<string, unknown>) =>
        adapter.updateDatabasePropertyConfig({
          expectedGeneration: generation,
          databaseId: created.databaseId,
          propertyId: date.propertyId,
          expectedManifestRevision: await revision(),
          ...patch,
        })

      await change({ dateFormat: "dayMonthYear", timeFormat: "12h" })
      const shown = await configOf()
      check(
        shown.dateFormat === "dayMonthYear" && shown.timeFormat === "12h",
        "The display formats are saved in the property",
      )
      await change({ includeTime: true })
      check(
        (await configOf()).includeTime === true,
        "Time can be switched on while there are no values",
      )

      const row = await adapter.createDatabaseRow({
        expectedGeneration: generation,
        databaseId: created.databaseId,
        title: "Card",
        template: { kind: "empty" },
      })
      await adapter.applyDatabaseValueBatch({
        expectedGeneration: generation,
        databaseId: created.databaseId,
        operationId: `native-settings-${created.databaseId}`,
        cells: [
          {
            noteId: row.noteId,
            propertyId: date.propertyId,
            valueJson: JSON.stringify({
              type: "date",
              start: "2026-10-03T09:00:00Z",
              end: null,
              timeZone: null,
            }),
            expectedRevision: row.recordRevision,
          },
        ],
      })
      let refused = ""
      try {
        await change({ includeTime: false })
      } catch (failure) {
        refused = failure instanceof Error ? failure.message : String(failure)
      }
      check(
        refused.includes("existing values are cleared") && (await configOf()).includeTime === true,
        "Switching the time off is refused while a value has one, and nothing changes",
      )
      await change({ dateFormat: "relative" })
      check(
        (await configOf()).dateFormat === "relative",
        "A display format still changes with values",
      )
      await adapter.rebuildDatabaseProjection()
      const result = await queryDatabase(adapter, generation, created.databaseId)
      check(result.rows.length === 1, "The record is still valid after the settings changed")
    },
  },
]
