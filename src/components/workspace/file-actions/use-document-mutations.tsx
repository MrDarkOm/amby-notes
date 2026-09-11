import * as React from "react"
import i18n from "@/lib/i18n"
import { saveRecoveryDraft } from "@/lib/recovery-drafts"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  applyDatabaseValueBatch,
  backupCustomProperties,
  confirmAction,
  createDatabaseProperty,
  deleteItem,
  getDatabaseNoteContext,
  getNoteProperties,
  moveItem,
  previewMoveRefactor,
  previewRenameRefactor,
  readNote,
  renameItem,
  showErrorMessage,
  type FsMutationResult,
  type CustomProperty,
  type DatabaseNoteContext,
  type DatabasePropertySummary,
} from "@/lib/storage"
import { useDocStore } from "../use-doc-store"
import { useTabsStore } from "../use-tabs-store"
import { findTreeItem } from "../workspace-tree-utils"
import { moveTreeItemsOptimistically } from "../workspace-mutations"
import { beginLocalTreeMutation, recordLocalTreePaths } from "../watcher-tree-reconciliation"
import type { MarkdownAutosaveActions, UseFileActionsParams } from "./types"

type Params = Pick<
  UseFileActionsParams,
  "vault" | "treeItems" | "setTreeItems" | "refreshTree" | "backendGeneration"
> &
  MarkdownAutosaveActions & { handleSelect: (id: string) => Promise<void> }

type PropertyMigrationChoice = "database" | "backup"

interface PendingPropertyMigration {
  count: number
  database: string
  resolve: (choice: PropertyMigrationChoice) => void
}

function migratedPropertyType(property: CustomProperty): string {
  if (
    property.propertyType === "number" &&
    (!property.value || Number.isFinite(Number(property.value)))
  )
    return "number"
  if (property.propertyType === "checkbox") return "checkbox"
  if (
    property.propertyType === "date" &&
    (!property.value || /^\d{4}-\d{2}-\d{2}/.test(property.value))
  )
    return "date"
  if (property.propertyType === "url") return "url"
  if (property.propertyType === "select") return "select"
  return "text"
}

function migratedOptions(property: CustomProperty): string[] {
  const options = property.settings
    .split(",")
    .map((option) => option.trim())
    .filter(Boolean)
  if (
    property.value &&
    !options.some(
      (option) => option.localeCompare(property.value, undefined, { sensitivity: "base" }) === 0,
    )
  ) {
    options.push(property.value)
  }
  return options
}

function migratedValue(
  property: CustomProperty,
  propertyType: string,
  targetProperty: DatabasePropertySummary,
): string | undefined {
  if (!property.value) return undefined
  if (propertyType === "number") {
    return JSON.stringify({ type: "number", decimal: property.value })
  }
  if (propertyType === "checkbox") {
    return JSON.stringify({ type: "checkbox", checked: property.value === "true" })
  }
  if (propertyType === "date") {
    return JSON.stringify({ type: "date", start: property.value })
  }
  if (propertyType === "select") {
    const option = targetProperty.options.find(
      (candidate) =>
        candidate.name.localeCompare(property.value, undefined, { sensitivity: "base" }) === 0,
    )
    if (!option) {
      throw new Error(
        i18n.t("infoPanel.databasePropertyMoveOptionMissing", { property: property.name }),
      )
    }
    return JSON.stringify({ type: "select", optionId: option.optionId })
  }
  return JSON.stringify({ type: propertyType, value: property.value })
}

async function migratePropertiesToDatabase(
  vault: string,
  context: DatabaseNoteContext,
  properties: CustomProperty[],
) {
  let manifestRevision = context.manifestRevision
  const usedNames = new Set(context.properties.map((property) => property.name.toLocaleLowerCase()))
  const targetProperties: Array<{ propertyId: string; property: CustomProperty; type: string }> = []

  for (const property of properties) {
    const type = migratedPropertyType(property)
    const matching = context.properties.find(
      (candidate) =>
        candidate.name.localeCompare(property.name, undefined, { sensitivity: "base" }) === 0 &&
        candidate.propertyType === type &&
        (type !== "select" ||
          !property.value ||
          candidate.options.some(
            (option) =>
              option.name.localeCompare(property.value, undefined, { sensitivity: "base" }) === 0,
          )),
    )
    if (matching) {
      targetProperties.push({ propertyId: matching.propertyId, property, type })
      continue
    }
    let name = property.name.trim()
    let suffix = 2
    while (usedNames.has(name.toLocaleLowerCase())) name = `${property.name.trim()} ${suffix++}`
    const created = await createDatabaseProperty({
      expectedGeneration: context.vaultGeneration,
      databaseId: context.databaseId,
      expectedManifestRevision: manifestRevision,
      name,
      propertyType: type,
      options: type === "select" ? migratedOptions(property) : undefined,
    })
    manifestRevision = created.manifestRevision
    usedNames.add(name.toLocaleLowerCase())
    targetProperties.push({ propertyId: created.propertyId, property, type })
  }

  const refreshedContext = (await getDatabaseNoteContext(context.row.noteId)) ?? context
  const cells = targetProperties.flatMap(({ propertyId, property, type }) => {
    const targetProperty = refreshedContext.properties.find(
      (candidate) => candidate.propertyId === propertyId,
    )
    if (!targetProperty) {
      throw new Error(
        i18n.t("infoPanel.databasePropertyMoveFieldMissing", { property: property.name }),
      )
    }
    const valueJson = migratedValue(property, type, targetProperty)
    return valueJson
      ? [
          {
            noteId: context.row.noteId,
            propertyId,
            valueJson,
            expectedRevision: context.row.rowRevision,
          },
        ]
      : []
  })
  if (cells.length) {
    await applyDatabaseValueBatch({
      expectedGeneration: context.vaultGeneration,
      databaseId: context.databaseId,
      operationId:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? `property-migration-${crypto.randomUUID()}`
          : `property-migration-${Date.now()}`,
      cells,
    })
  }
  await backupCustomProperties(vault, context.row.noteId)
}

export function useDocumentMutations({
  vault,
  treeItems,
  setTreeItems,
  refreshTree,
  backendGeneration,
  autosave,
  autosaveKey,
  handleApplyMutation,
  handleSelect,
  recoveryScope,
}: Params) {
  const t = i18n.t.bind(i18n)
  const [pendingPropertyMigration, setPendingPropertyMigration] =
    React.useState<PendingPropertyMigration | null>(null)
  const { patchDoc, markUnsaved } = useDocStore.getState()
  const { setTabs } = useTabsStore.getState()
  const requestPropertyMigration = React.useCallback(
    (count: number, database: string) =>
      new Promise<PropertyMigrationChoice>((resolve) => {
        setPendingPropertyMigration({ count, database, resolve })
      }),
    [],
  )
  const finishPropertyMigration = React.useCallback((choice: PropertyMigrationChoice) => {
    setPendingPropertyMigration((current) => {
      current?.resolve(choice)
      return null
    })
  }, [])
  const handleRenameFile = React.useCallback(
    async (id: string, newName: string) => {
      const item = findTreeItem(treeItems, id)
      if (!item) return
      let finishLocalMutation: (() => void) | null = null
      try {
        const path = item.path ?? id
        const preview = await previewRenameRefactor(vault ?? "", path, newName)
        if (
          preview.replacements > 0 &&
          !(await confirmAction(
            t("workspace.renameRefactorConfirm", {
              replacements: preview.replacements,
              notes: preview.notes,
            }),
          ))
        )
          return
        finishLocalMutation = beginLocalTreeMutation()
        const result = await renameItem(vault ?? "", path, newName)
        handleApplyMutation(result)
        finishLocalMutation()
        patchDoc(id, { title: newName, path: result.primaryPath ?? item.path ?? id })
        setTabs((previous) =>
          previous.map((tab) => (tab.fileId === id ? { ...tab, title: newName } : tab)),
        )
      } catch (error) {
        console.error("Failed to rename:", error)
      } finally {
        finishLocalMutation?.()
      }
    },
    [handleApplyMutation, patchDoc, setTabs, t, treeItems, vault],
  )
  const handleMoveItem = React.useCallback(
    async (sourceIds: string[], targetId: string | null) => {
      if (!vault) return
      const uniqueSourceIds = [...new Set(sourceIds)]
      const selectedSources = uniqueSourceIds
        .map((id) => findTreeItem(treeItems, id))
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
      if (!selectedSources.length) return
      const target = targetId ? findTreeItem(treeItems, targetId) : null
      if ((targetId && !target) || (target && target.type !== "folder" && target.type !== "file"))
        return
      const normalize = (path: string) => path.replace(/\\/g, "/")
      const dirname = (path: string) => {
        const value = normalize(path).replace(/\/+$/, "")
        const index = value.lastIndexOf("/")
        return index === -1 ? "" : value.slice(0, index)
      }
      const basename = (path: string) => normalize(path).replace(/\/+$/, "").split("/").pop() ?? ""
      const stem = (path: string) => basename(path).replace(/\.[^.]+$/, "")
      const targetPath = target?.path ?? vault
      const normalizedTarget = normalize(targetPath)
      const sourceEntries = selectedSources
        .map((source) => {
          const sourcePath = source.path ?? source.id
          const normalizedSource = normalize(sourcePath)
          const sourceRoot =
            source.type === "file" && basename(dirname(normalizedSource)) === stem(normalizedSource)
              ? dirname(normalizedSource)
              : normalizedSource
          return { source, sourcePath, sourceRoot }
        })
        .filter(
          (entry, index, entries) =>
            !entries.some(
              (candidate, candidateIndex) =>
                candidateIndex !== index && entry.sourceRoot.startsWith(`${candidate.sourceRoot}/`),
            ),
        )
      if (!sourceEntries.length) return
      if (
        sourceEntries.some(
          ({ sourceRoot }) =>
            normalizedTarget.startsWith(`${sourceRoot}/`) || normalizedTarget === sourceRoot,
        )
      )
        return
      if (
        target?.type === "file" &&
        basename(dirname(normalizedTarget)) === stem(normalizedTarget) &&
        sourceEntries.some(
          ({ sourceRoot }) =>
            sourceRoot === dirname(normalizedTarget) ||
            sourceRoot.startsWith(`${dirname(normalizedTarget)}/`),
        )
      )
        return
      if (
        !targetId &&
        sourceEntries.some(({ sourceRoot }) => dirname(sourceRoot) === normalize(vault))
      )
        return

      const previousTree = treeItems
      setTreeItems((current) =>
        moveTreeItemsOptimistically(
          current,
          sourceEntries.map(({ source }) => source.id),
          targetId,
        ),
      )

      const results: FsMutationResult[] = []
      const finishLocalMutation = beginLocalTreeMutation()
      try {
        const source = sourceEntries.length === 1 ? sourceEntries[0].source : null
        const previousProperties =
          source?.type === "file"
            ? await getNoteProperties(vault, source.id).catch(() => null)
            : null
        if (sourceEntries.length === 1) {
          const preview = await previewMoveRefactor(vault, sourceEntries[0].sourcePath, targetPath)
          if (
            preview.replacements > 0 &&
            !(await confirmAction(
              t("workspace.moveRefactorConfirm", {
                replacements: preview.replacements,
                notes: preview.notes,
              }),
            ))
          ) {
            setTreeItems(previousTree)
            return
          }
        }

        let currentTargetPath = targetPath
        for (const { sourcePath } of sourceEntries) {
          const result = await moveItem(vault, sourcePath, currentTargetPath)
          results.push(result)
          if (target?.type === "file") {
            currentTargetPath =
              result.pathChanges.find(
                (change) => normalize(change.oldPath) === normalize(currentTargetPath),
              )?.newPath ?? currentTargetPath
          }
        }

        const lastResult = results[results.length - 1]
        const pathChanges = results.flatMap((result, index) => {
          const entry = sourceEntries[index]
          if (
            entry?.source.type !== "folder" ||
            !result.primaryPath ||
            result.pathChanges.some(
              (change) => normalize(change.oldPath) === normalize(entry.sourceRoot),
            )
          ) {
            return result.pathChanges
          }
          return [...result.pathChanges, { oldPath: entry.sourceRoot, newPath: result.primaryPath }]
        })
        handleApplyMutation({
          primaryId: lastResult?.primaryId ?? null,
          primaryPath: lastResult?.primaryPath ?? null,
          pathChanges,
          deletedPaths: results.flatMap((result) => result.deletedPaths),
          deletedIds: results.flatMap((result) => result.deletedIds ?? []),
        })
        recordLocalTreePaths(sourceEntries.map((entry) => entry.sourceRoot))
        finishLocalMutation()

        if (previousProperties?.customProperties.length && source) {
          const databaseContext = await getDatabaseNoteContext(source.id).catch(() => null)
          if (databaseContext) {
            const choice = await requestPropertyMigration(
              previousProperties.customProperties.length,
              databaseContext.databaseTitle,
            )
            if (choice === "database") {
              await migratePropertiesToDatabase(
                vault,
                databaseContext,
                previousProperties.customProperties,
              )
            } else {
              await backupCustomProperties(vault, source.id)
            }
            await refreshTree()
          }
        }
      } catch (error) {
        if (results.length) {
          await refreshTree()
        } else {
          setTreeItems(previousTree)
        }
        console.error("Failed to move item:", error)
        void showErrorMessage(
          t("infoPanel.databasePropertyMoveFailed", {
            message: error instanceof Error ? error.message : String(error),
          }),
        )
      } finally {
        finishLocalMutation()
      }
    },
    [handleApplyMutation, refreshTree, requestPropertyMigration, setTreeItems, t, treeItems, vault],
  )
  const handleMergeFile = React.useCallback(
    async (sourceId: string, targetId: string) => {
      if (!vault || sourceId === targetId) return
      const source = findTreeItem(treeItems, sourceId)
      const target = findTreeItem(treeItems, targetId)
      if (
        source?.type !== "file" ||
        target?.type !== "file" ||
        !(await confirmAction(
          t("workspace.mergeFilesConfirm", { source: source.name, target: target.name }),
        ))
      )
        return
      try {
        await Promise.all([
          autosave.flush(autosaveKey(sourceId)),
          autosave.flush(autosaveKey(targetId)),
        ])
        const documents = useDocStore.getState().openDocs
        const targetDocument = documents[targetId]
        const sourceContent =
          documents[sourceId]?.content ?? (await readNote(vault, sourceId)).content
        const targetRead = targetDocument ? null : await readNote(vault, targetId)
        const targetContent = targetDocument?.content ?? targetRead!.content
        const content = [targetContent.trimEnd(), sourceContent.trimStart()]
          .filter(Boolean)
          .join("\n\n")
        const path = targetDocument?.path ?? target.path
        if (targetDocument) {
          patchDoc(targetId, {
            content,
            wordCount: content.trim() ? content.trim().split(/\s+/u).length : 0,
          })
          markUnsaved(targetId)
        }
        void saveRecoveryDraft(targetId, content, "markdown", path, recoveryScope)
        autosave.enqueueImmediate(autosaveKey(targetId), {
          fileId: targetId,
          path,
          content,
          backendGeneration,
          expectedRevision: targetDocument?.revision ?? targetRead!.revision,
        })
        await autosave.flush(autosaveKey(targetId))
        const finishLocalMutation = beginLocalTreeMutation()
        try {
          handleApplyMutation(await deleteItem(vault, source.path))
          finishLocalMutation()
        } finally {
          finishLocalMutation()
        }
        await handleSelect(targetId)
      } catch (error) {
        console.error("Failed to merge files:", error)
      }
    },
    [
      autosave,
      autosaveKey,
      backendGeneration,
      handleApplyMutation,
      handleSelect,
      markUnsaved,
      patchDoc,
      recoveryScope,
      t,
      treeItems,
      vault,
    ],
  )
  const propertyMigrationDialog = (
    <Dialog open={Boolean(pendingPropertyMigration)}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("infoPanel.databasePropertyMoveTitle")}</DialogTitle>
          <DialogDescription>
            {t("infoPanel.databasePropertyMoveDescription", {
              count: pendingPropertyMigration?.count ?? 0,
              database: pendingPropertyMigration?.database ?? "",
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            className="h-9 rounded-md border border-border px-3 text-sm text-foreground hover:bg-accent"
            onClick={() => finishPropertyMigration("backup")}
          >
            {t("infoPanel.databasePropertyMoveBackup")}
          </button>
          <button
            type="button"
            className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
            onClick={() => finishPropertyMigration("database")}
          >
            {t("infoPanel.databasePropertyMoveDatabase")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
  return { handleRenameFile, handleMoveItem, handleMergeFile, propertyMigrationDialog }
}
