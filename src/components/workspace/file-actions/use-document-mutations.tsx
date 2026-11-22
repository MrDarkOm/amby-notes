import * as React from "react"
import { useDatabaseStore } from "../database/database-store"
import i18n from "@/lib/i18n"
import { logger } from "@/lib/logger"
import { operationErrorCode, operationErrorText } from "@/lib/operation-errors"
import { saveRecoveryDraft } from "@/lib/recovery-drafts"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useNoticeJournalStore } from "@/lib/notices/use-notice-journal-store"
import {
  backupCustomProperties,
  beginMerge,
  deleteItem,
  finishMerge,
  getDatabaseNoteContext,
  getNoteProperties,
  listDatabases,
  moveItem,
  readNote,
  renameItem,
  undoMutation,
  type UndoRecord,
  type FsMutationResult,
  type DatabaseNoteContext,
  type TreeItem,
  DatabaseOperationError,
} from "@/lib/storage"
import { flushAutosaveGeneration, holdLayerAutosavesInside } from "../autosave/autosave-lifecycle"
import { useVaultStore } from "../use-vault-store"
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
import { announceUndoable, registerUndoApplier, type UndoOutcome } from "./undo-operation"

type Params = Pick<
  UseFileActionsParams,
  "vault" | "treeItems" | "setTreeItems" | "refreshTree" | "backendGeneration"
> &
  MarkdownAutosaveActions & { handleSelect: (id: string) => Promise<void> }

/** Where a path ended up after a mutation: a moved path, or one under a moved folder. */
function pathAfterMutation(result: FsMutationResult, path: string): string {
  for (const { oldPath, newPath } of result.pathChanges) {
    if (!oldPath || !newPath) continue
    if (path === oldPath) return newPath
    if (path.startsWith(`${oldPath}/`)) return `${newPath}${path.slice(oldPath.length)}`
  }
  return path
}

/** A name without its folder and extension, as the person sees it. */
function displayName(path: string): string {
  const base = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? ""
  return base.replace(/\.[^.]+$/, "")
}

/** The notes an undo writes back: open ones must have nothing unsaved first. */
function undoTouchedPaths(record: UndoRecord): string[] {
  return record.kind === "merge" ? [record.target.path] : record.rewritten.map((note) => note.path)
}

const UNDO_REFUSALS = new Set(["undoItemMoved", "undoNoteChanged", "undoUnavailable"])

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
          // A backup the person asked for: the journal says it is there (docs/notices.md, section 5).
          useNoticeJournalStore.getState().record({
            kind: "backupReady",
            level: "success",
            subject: `properties:${noteId}`,
            params: { name, what: "properties" },
          })
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
      if (!item || item.bundleMember) return { status: "skipped" }
      let finishLocalMutation: (() => void) | null = null
      let releaseLayerSaves: ((newPathOf: (oldPath: string) => string) => void) | null = null
      let newPathOf = (oldPath: string) => oldPath
      try {
        const path = item.path ?? id
        // Links in other notes are rewritten without a question: the line under the tree undoes it
        // exactly (docs/notices.md, section 9).
        finishLocalMutation = beginLocalTreeMutation()
        // A queued save of a canvas or sketch must not meet the old path gone (SAVE-10).
        releaseLayerSaves = await holdLayerAutosavesInside(
          useVaultStore.getState().generation,
          path,
        )
        const result = await renameItem(vault ?? "", path, newName)
        newPathOf = (oldPath) => pathAfterMutation(result, oldPath)
        handleApplyMutation(result)
        // A page that databases list changed its title: their lists read it again.
        useDatabaseStore.getState().invalidateHosts()
        finishLocalMutation()
        patchDoc(id, { title: newName, path: result.primaryPath ?? item.path ?? id })
        const renamedFolderId =
          id.startsWith("folder:") && result.primaryPath ? `folder:${result.primaryPath}` : null
        setTabs((previous) =>
          previous.map((tab) =>
            tab.fileId === id || tab.fileId === renamedFolderId ? { ...tab, title: newName } : tab,
          ),
        )
        logger.info("file.rename", { id, oldPath: path, newName, primaryPath: result.primaryPath })
        announceUndoable(result, {
          kind: "renamedWithLinks",
          params: { name: newName },
          titleKey: "notices.tree.renamed",
          lineKey: "notices.tree.linksUpdated",
          ...(result.primaryPath ? { target: result.primaryPath } : {}),
        })
        return { status: "renamed" }
      } catch (error) {
        // The field the name was typed in shows the reason (RenameHint); the log keeps the code.
        logger.error("file.rename_failed", { id, failureCode: operationErrorCode(error), error })
        return { status: "failed", text: operationErrorText(error) }
      } finally {
        finishLocalMutation?.()
        releaseLayerSaves?.(newPathOf)
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
        .filter((item): item is NonNullable<typeof item> => Boolean(item && !item.bundleMember))
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

      // The rollback needs the raw tree the setter holds, not `treeItems`: that one is the displayed
      // tree, with icons and types of the primary layer mixed in, and would stick to the raw one.
      let previousTree: TreeItem[] | null = null
      setTreeItems((current) => {
        previousTree = current
        return moveTreeItemsOptimistically(
          current,
          sourceEntries.map(({ source }) => source.id),
          targetId,
        )
      })
      const restoreTree = () => {
        if (previousTree) setTreeItems(previousTree)
        else void refreshTree()
      }

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

        // Each move that rewrote links can be undone exactly from the journal; the line under the tree
        // offers it for the last one (docs/notices.md, section 9).
        results.forEach((result, index) => {
          const entry = sourceEntries[index]
          if (!entry) return
          announceUndoable(result, {
            kind: "movedWithLinks",
            params: { name: entry.source.name, target: target?.name ?? displayName(vault) },
            titleKey: "notices.tree.moved",
            lineKey: "notices.tree.linksUpdated",
            ...(result.primaryPath ? { target: result.primaryPath } : {}),
          })
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
          restoreTree()
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
    [handleApplyMutation, offerPropertiesToDatabase, refreshTree, setTreeItems, treeItems, vault],
  )
  const handleMergeFile = React.useCallback(
    async (sourceId: string, targetId: string) => {
      if (!vault || sourceId === targetId) return
      const source = findTreeItem(treeItems, sourceId)
      const target = findTreeItem(treeItems, targetId)
      if (
        source?.type !== "file" ||
        source.bundleMember ||
        target?.bundleMember ||
        target?.type !== "file"
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
        // The target's text is kept as a version first, so the merge is undone exactly and is not asked
        // about (docs/notices.md, section 9). `null` where it cannot be kept (the browser).
        const snapshotId = await beginMerge(path)
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
        // The merged text did not reach the disk: the source stays where it is.
        if (useDocStore.getState().unsavedFileIds.has(targetId)) {
          logger.warn("file.merge_kept_source", { sourceId, targetId })
          return
        }
        const finishLocalMutation = beginLocalTreeMutation()
        try {
          const result = snapshotId
            ? await finishMerge(vault, source.path, path, snapshotId)
            : await deleteItem(vault, source.path)
          handleApplyMutation(result)
          finishLocalMutation()
          announceUndoable(result, {
            kind: "notesMerged",
            params: { source: source.name, target: target.name },
            titleKey: "notices.tree.merged",
            lineKey: "notices.tree.mergedLine",
            target: path,
          })
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
  /**
   * «Вернуть» of a rename, a move or a merge (undo-operation.ts). Unsaved text is saved first, and an open
   * note the undo would write back must have nothing unsaved and no outside change; the backend refuses
   * when anything changed since, and then nothing is touched.
   */
  const applyUndo = React.useCallback(
    async (record: UndoRecord): Promise<UndoOutcome> => {
      const saveFirst = { outcome: "refused", key: "notices.journal.undoSaveFirst" } as const
      if (!vault) return { outcome: "refused", key: "notices.journal.undoFailed" }
      const flushed = await flushAutosaveGeneration(useVaultStore.getState().generation)
      if (!flushed.flushed) return saveFirst
      const state = useDocStore.getState()
      const touched = new Set(undoTouchedPaths(record).map((path) => path.normalize("NFC")))
      const blocked = Object.values(state.openDocs).some(
        (doc) =>
          touched.has(doc.path.normalize("NFC")) &&
          (state.unsavedFileIds.has(doc.id) || Boolean(state.externalConflicts[doc.id])),
      )
      if (blocked) return saveFirst
      const finishLocalMutation = beginLocalTreeMutation()
      try {
        const result = await undoMutation(record)
        handleApplyMutation(result)
        finishLocalMutation()
        useDatabaseStore.getState().invalidateHosts()
        if (record.kind === "rename" && result.primaryPath) {
          const name = displayName(result.primaryPath)
          const docs = useDocStore.getState().openDocs
          const renamed = Object.values(docs).find((doc) => doc.path === result.primaryPath)
          if (renamed) {
            patchDoc(renamed.id, { title: name })
            setTabs((previous) =>
              previous.map((tab) => (tab.fileId === renamed.id ? { ...tab, title: name } : tab)),
            )
          }
        }
        logger.info("file.undo", { kind: record.kind })
        try {
          await refreshTree()
        } catch (error) {
          // The undo is done; the tree catches up with the next change.
          logger.warn("file.undo_refresh_failed", { failureCode: operationErrorCode(error) })
        }
        return { outcome: "restored" }
      } catch (error) {
        const code = operationErrorCode(error)
        logger.warn("file.undo_failed", { kind: record.kind, failureCode: code })
        return {
          outcome: "refused",
          key: UNDO_REFUSALS.has(code) ? `operationErrors.${code}` : "notices.journal.undoFailed",
        }
      } finally {
        finishLocalMutation()
      }
    },
    [handleApplyMutation, patchDoc, refreshTree, setTabs, vault],
  )
  React.useEffect(() => registerUndoApplier(applyUndo), [applyUndo])
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
