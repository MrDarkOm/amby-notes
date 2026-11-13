import * as React from "react"
import { useDatabaseStore } from "../database/database-store"
import i18n from "@/lib/i18n"
import { logger } from "@/lib/logger"
import { operationErrorCode, operationErrorText } from "@/lib/operation-errors"
import { saveRecoveryDraft } from "@/lib/recovery-drafts"
import { confirm } from "@/lib/confirm"
import { confirmations } from "@/lib/confirmations"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  backupCustomProperties,
  deleteItem,
  getDatabaseNoteContext,
  getNoteProperties,
  listDatabases,
  moveItem,
  previewMoveRefactor,
  previewRenameRefactor,
  readNote,
  renameItem,
  type FsMutationResult,
  type DatabaseNoteContext,
  DatabaseOperationError,
} from "@/lib/storage"
import { useDocStore } from "../use-doc-store"
import { useTabsStore } from "../use-tabs-store"
import { useTreeMessageStore } from "../tree/use-tree-message-store"
import { usePropertyMoveRetryStore } from "./property-move-retry-store"
import {
  migratePropertiesToDatabase,
  propertiesToMigrate,
  type MigratingProperty,
} from "./property-migration"
import { findTreeItem } from "../workspace-tree-utils"
import { moveTreeItemsOptimistically } from "../workspace-mutations"
import { concatTreePatches } from "../tree-patch"
import { beginLocalTreeMutation, recordLocalTreePaths } from "../watcher-tree-reconciliation"
import type { MarkdownAutosaveActions, UseFileActionsParams } from "./types"
import type { RenameOutcome } from "./rename-outcome"

type Params = Pick<
  UseFileActionsParams,
  "vault" | "treeItems" | "setTreeItems" | "refreshTree" | "backendGeneration"
> &
  MarkdownAutosaveActions & { handleSelect: (id: string) => Promise<void> }

/**
 * The app's own writes do not reach the open databases (the watcher skips them): after a note went into
 * one, or its fields were made, they read their rows and fields again.
 */
async function refreshOpenDatabases() {
  const store = useDatabaseStore.getState()
  store.invalidateHosts()
  if (store.catalogStatus === "disabled") return
  try {
    useDatabaseStore.getState().setCatalog(await listDatabases())
  } catch (error) {
    logger.debug("file.move_databases_refresh_failed", { failureCode: operationErrorCode(error) })
  }
}

type PropertyMigrationChoice = "database" | "backup"

/**
 * How a move ended, for a caller that has to know before it goes on: `moved` all of it, `skipped`
 * nothing was done (not allowed, or the author declined the link rewrite), `failed` it stopped
 * with an error, so some of the items may already be in their new place.
 */
export type MoveOutcome = "moved" | "skipped" | "failed"

interface PendingPropertyMigration {
  count: number
  database: string
  resolve: (choice: PropertyMigrationChoice) => void
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
  /**
   * After a note went into a database: offer to carry its own properties over, or to save them aside.
   * It never throws and never writes before the answer. Whatever stops it (the properties or the place
   * in the database cannot be read, the writing fails) is said under the tree with a button to try again
   * and as a card of the note; the properties stay in the note then (docs/notices.md, section 8).
   * `known` is what was read before the move; if that failed, it is read again here.
   */
  const offerPropertiesToDatabase = React.useCallback(
    async (noteId: string, name: string, known: MigratingProperty[] | null): Promise<void> => {
      if (!vault) return
      const retry = () => offerPropertiesToDatabase(noteId, name, null)
      const keepInNote = (event: string, error: unknown) => {
        logger.warn(event, { failureCode: operationErrorCode(error) })
        usePropertyMoveRetryStore.getState().set(noteId, { name, retry })
        useTreeMessageStore.getState().show({
          id: `properties-kept:${noteId}`,
          level: "warning",
          titleKey: "notices.tree.propertiesKept",
          params: { name },
          lineKey: "notices.tree.propertiesKeptLine",
          action: { labelKey: "notices.tree.propertiesRetry", run: retry },
        })
      }
      const done = () => {
        usePropertyMoveRetryStore.getState().clear(noteId)
        const { message: shown } = useTreeMessageStore.getState()
        if (shown?.id === `properties-kept:${noteId}`) useTreeMessageStore.getState().dismiss()
      }
      let properties = known
      if (!properties) {
        try {
          properties = propertiesToMigrate(await getNoteProperties(vault, noteId))
        } catch (error) {
          keepInNote("file.move_properties_read_failed", error)
          return
        }
      }
      if (!properties.length) return done()
      let databaseContext: DatabaseNoteContext | null
      try {
        databaseContext = await getDatabaseNoteContext(noteId)
      } catch (error) {
        // The module is off: for the person the note is in no database, so there is nothing to offer.
        if (error instanceof DatabaseOperationError && error.kind === "moduleDisabled")
          return done()
        keepInNote("file.move_database_context_failed", error)
        return
      }
      // Not in a database (it went out of one, or into a plain folder): nothing to carry over.
      if (!databaseContext) return done()
      const choice = await requestPropertyMigration(
        properties.length,
        databaseContext.databaseTitle,
      )
      try {
        if (choice === "database") {
          await migratePropertiesToDatabase(vault, databaseContext, properties)
        } else {
          await backupCustomProperties(vault, noteId)
        }
      } catch (error) {
        keepInNote("file.move_properties_write_failed", error)
        return
      }
      done()
      await refreshOpenDatabases()
      try {
        await refreshTree()
      } catch (error) {
        // The move and the properties are saved; the tree catches up with the next change.
        logger.warn("file.move_refresh_failed", { failureCode: operationErrorCode(error) })
      }
    },
    [refreshTree, requestPropertyMigration, vault],
  )
  const handleRenameFile = React.useCallback(
    async (id: string, newName: string): Promise<RenameOutcome> => {
      const item = findTreeItem(treeItems, id)
      if (!item) return { status: "skipped" }
      let finishLocalMutation: (() => void) | null = null
      try {
        const path = item.path ?? id
        const preview = await previewRenameRefactor(vault ?? "", path, newName)
        if (
          preview.replacements > 0 &&
          !(await confirm(
            confirmations.renameRefactor({
              replacements: preview.replacements,
              notes: preview.notes,
            }),
          ))
        )
          return { status: "skipped" }
        finishLocalMutation = beginLocalTreeMutation()
        const result = await renameItem(vault ?? "", path, newName)
        handleApplyMutation(result)
        // A page that databases list changed its title: their lists read it again.
        useDatabaseStore.getState().invalidateHosts()
        finishLocalMutation()
        patchDoc(id, { title: newName, path: result.primaryPath ?? item.path ?? id })
        setTabs((previous) =>
          previous.map((tab) => (tab.fileId === id ? { ...tab, title: newName } : tab)),
        )
        logger.info("file.rename", { id, oldPath: path, newName, primaryPath: result.primaryPath })
        return { status: "renamed" }
      } catch (error) {
        // The field the name was typed in shows the reason (RenameHint); the log keeps the code.
        logger.error("file.rename_failed", { id, failureCode: operationErrorCode(error), error })
        return { status: "failed", text: operationErrorText(error) }
      } finally {
        finishLocalMutation?.()
      }
    },
    [handleApplyMutation, patchDoc, setTabs, treeItems, vault],
  )
  const handleMoveItem = React.useCallback(
    async (sourceIds: string[], targetId: string | null): Promise<MoveOutcome> => {
      if (!vault) return "skipped"
      const uniqueSourceIds = [...new Set(sourceIds)]
      const selectedSources = uniqueSourceIds
        .map((id) => findTreeItem(treeItems, id))
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
      if (!selectedSources.length) return "skipped"
      const target = targetId ? findTreeItem(treeItems, targetId) : null
      // A standalone database is a folder of its own; moving a page into it adds the page to it.
      if (
        (targetId && !target) ||
        (target && target.type !== "folder" && target.type !== "file" && target.type !== "database")
      )
        return "skipped"
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
      if (!sourceEntries.length) return "skipped"
      if (
        sourceEntries.some(
          ({ sourceRoot }) =>
            normalizedTarget.startsWith(`${sourceRoot}/`) || normalizedTarget === sourceRoot,
        )
      )
        return "skipped"
      if (
        target?.type === "file" &&
        basename(dirname(normalizedTarget)) === stem(normalizedTarget) &&
        sourceEntries.some(
          ({ sourceRoot }) =>
            sourceRoot === dirname(normalizedTarget) ||
            sourceRoot.startsWith(`${dirname(normalizedTarget)}/`),
        )
      )
        return "skipped"
      if (
        !targetId &&
        sourceEntries.some(({ sourceRoot }) => dirname(sourceRoot) === normalize(vault))
      )
        return "skipped"

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
        // Read before the move; if that fails, the offer after the move reads again.
        const previousProperties: MigratingProperty[] | null =
          source?.type === "file"
            ? await getNoteProperties(vault, source.id).then(
                (properties) => propertiesToMigrate(properties),
                (error: unknown) => {
                  logger.debug("file.move_properties_read_failed", {
                    failureCode: operationErrorCode(error),
                  })
                  return null
                },
              )
            : []
        if (sourceEntries.length === 1) {
          const preview = await previewMoveRefactor(vault, sourceEntries[0].sourcePath, targetPath)
          if (
            preview.replacements > 0 &&
            !(await confirm(
              confirmations.moveRefactor({
                replacements: preview.replacements,
                notes: preview.notes,
              }),
            ))
          ) {
            setTreeItems(previousTree)
            return "skipped"
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
          // The moves ran one after another, so their patches apply in the same order.
          treePatch: concatTreePatches(results.map((result) => result.treePatch)),
        })
        recordLocalTreePaths(sourceEntries.map((entry) => entry.sourceRoot))
        finishLocalMutation()
        logger.info("file.move", {
          sources: sourceEntries.map((e) => e.sourcePath),
          targetPath,
          pathChangesCount: pathChanges.length,
        })

        await refreshOpenDatabases()
        // A single note moved: carry its properties over if it is now in a database. Not awaited for
        // the person's answer in the outcome of the move: the move itself is done.
        if (source?.type === "file" && previousProperties?.length !== 0) {
          await offerPropertiesToDatabase(source.id, source.name, previousProperties)
        }
        return "moved"
      } catch (error) {
        logger.error("file.move_failed", {
          sources: sourceEntries.map((e) => e.sourcePath),
          targetPath,
          error,
        })
        if (results.length) {
          await refreshTree()
        } else {
          setTreeItems(previousTree)
        }
        console.error("Failed to move item:", error)
        // Said under the tree, where the note was dragged; the cause stays in the log (docs/notices.md, section 10).
        const moved = results.length > 0
        useTreeMessageStore.getState().show(
          sourceEntries.length === 1
            ? {
                id: "move-failed",
                level: "warning",
                titleKey: "notices.tree.moveFailed",
                params: { name: sourceEntries[0].source.name },
                lineKey: moved ? "notices.tree.movePartial" : "notices.tree.moveKept",
              }
            : {
                id: "move-failed",
                level: "warning",
                titleKey: "notices.tree.moveFailedMany",
                params: { count: sourceEntries.length },
                lineKey: moved ? "notices.tree.movePartial" : "notices.tree.moveKept",
              },
        )
        return "failed"
      } finally {
        finishLocalMutation()
      }
    },
    [handleApplyMutation, offerPropertiesToDatabase, setTreeItems, treeItems, vault],
  )
  const handleMergeFile = React.useCallback(
    async (sourceId: string, targetId: string) => {
      if (!vault || sourceId === targetId) return
      const source = findTreeItem(treeItems, sourceId)
      const target = findTreeItem(treeItems, targetId)
      if (
        source?.type !== "file" ||
        target?.type !== "file" ||
        !(await confirm(confirmations.mergeNotes({ source: source.name, target: target.name })))
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
