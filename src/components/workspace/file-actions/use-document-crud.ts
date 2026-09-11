import * as React from "react"
import i18n from "@/lib/i18n"
import { discardRecoveryDraft, saveRecoveryDraft } from "@/lib/recovery-drafts"
import {
  attachCanvasToNote,
  archiveItem,
  createCanvasFile,
  createFolder,
  createNote,
  deleteItem,
  readNote,
  showErrorMessage,
} from "@/lib/storage"
import { loadWorkspaceConfig, saveWorkspaceConfigPatch } from "../app-config"
import { DeleteConfirmationDialog } from "../delete-confirmation-dialog"
import { useDocStore, type Document } from "../use-doc-store"
import { useTabsStore } from "../use-tabs-store"
import { useViewStateStore } from "../use-view-state-store"
import {
  findTreeItem,
  nextAvailableNoteName,
  updateInTree,
  wsPathStem,
} from "../workspace-tree-utils"
import { insertTreeItemOptimistically, removeTreeItem } from "../workspace-mutations"
import { beginLocalTreeMutation, recordLocalTreePaths } from "../watcher-tree-reconciliation"
import type { MarkdownAutosaveActions, UseFileActionsParams } from "./types"

type DeleteResolution = "confirm" | "archive" | "keep_recovery" | "discard" | "cancel"
type DeleteMode = "delete" | "archive"

function normalizeFsPath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/\/+$/u, "")
}

function pathName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

function deletionRoot(item: { path: string; type: "folder" | "file" | "canvas" }): string {
  const path = normalizeFsPath(item.path)
  if (item.type !== "file") return path
  const parent = path.slice(0, Math.max(0, path.lastIndexOf("/")))
  const stem = pathName(path).replace(/\.[^.]+$/u, "")
  return pathName(parent) === stem ? parent : path
}

function isPathInside(path: string, root: string): boolean {
  const normalizedPath = normalizeFsPath(path)
  const normalizedRoot = normalizeFsPath(root)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
}

function deleteTargets(
  items: Array<{ id: string; name: string; path: string; type: "folder" | "file" | "canvas" }>,
) {
  const candidates = items.map((item) => ({ ...item, root: deletionRoot(item) }))
  const uniqueCandidates = candidates.filter(
    (candidate, index) => candidates.findIndex((other) => other.root === candidate.root) === index,
  )
  return uniqueCandidates.filter(
    (candidate) =>
      !uniqueCandidates.some(
        (other) => other.root !== candidate.root && isPathInside(candidate.root, other.root),
      ),
  )
}

type Params = Pick<
  UseFileActionsParams,
  "vault" | "treeItems" | "setTreeItems" | "refreshTree" | "setOpenCanvases" | "setPendingRenameId"
> &
  MarkdownAutosaveActions & { loadDoc: (id: string, name: string) => Promise<Document> }

export function useDocumentCrud({
  vault,
  treeItems,
  setTreeItems,
  refreshTree,
  setOpenCanvases,
  setPendingRenameId,
  autosave,
  autosaveKey,
  handleApplyMutation,
  loadDoc,
  releaseUnusedDocumentBuffers,
  recoveryScope,
}: Params) {
  const t = i18n.t.bind(i18n)
  const noteNameReservationsRef = React.useRef(new Map<string, Set<string>>())
  const [pendingDelete, setPendingDelete] = React.useState<{
    ids: string[]
    name: string
    count: number
    isDirtyOrConflicted: boolean
    resolve: (action: DeleteResolution, dontAskAgain?: boolean) => void
  } | null>(null)
  const { setDoc } = useDocStore.getState()
  const { setTabs, openItem } = useTabsStore.getState()
  const { setActiveLayer } = useViewStateStore.getState()
  const requestDeleteConfirmation = React.useCallback(
    async (
      ids: string[],
      names: string[],
      isDirtyOrConflicted: boolean,
    ): Promise<DeleteResolution> => {
      const count = ids.length
      if (isDirtyOrConflicted)
        return new Promise((resolve) =>
          setPendingDelete({
            ids,
            name: names[0] ?? ids[0] ?? "",
            count,
            isDirtyOrConflicted: true,
            resolve,
          }),
        )
      const { confirmations } = await loadWorkspaceConfig()
      if (!confirmations.confirmFileDelete) return "confirm"
      return new Promise((resolve) =>
        setPendingDelete({
          ids,
          name: names[0] ?? ids[0] ?? "",
          count,
          isDirtyOrConflicted: false,
          resolve,
        }),
      )
    },
    [],
  )
  const settleDeleteConfirmation = React.useCallback(
    (action: DeleteResolution, dontAskAgain = false) => {
      if (!pendingDelete) return
      if (dontAskAgain)
        void saveWorkspaceConfigPatch({ confirmations: { confirmFileDelete: false } })
      pendingDelete.resolve(action)
      setPendingDelete(null)
    },
    [pendingDelete],
  )
  const handleDeleteFiles = React.useCallback(
    async (ids: string[], mode: DeleteMode = "delete") => {
      const items = ids
        .map((id) => findTreeItem(treeItems, id))
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
      const targets = deleteTargets(items)
      if (targets.length === 0) return
      const openDocuments = Object.values(useDocStore.getState().openDocs)
      const affected = openDocuments.filter((document) =>
        targets.some(
          (target) => document.id === target.id || isPathInside(document.path, target.root),
        ),
      )
      const docStore = useDocStore.getState()
      const hasDirtyDocuments = affected.some(
        (document) =>
          docStore.unsavedFileIds.has(document.id) ||
          Boolean(docStore.externalConflicts[document.id]),
      )
      const resolution =
        mode === "archive"
          ? "archive"
          : await requestDeleteConfirmation(
              targets.map((target) => target.id),
              targets.map((target) => target.name),
              hasDirtyDocuments,
            )
      if (resolution === "cancel") return
      const finishLocalMutation = beginLocalTreeMutation()
      let failed = 0
      try {
        for (const target of targets) {
          const targetDocuments = affected.filter(
            (document) => document.id === target.id || isPathInside(document.path, target.root),
          )
          try {
            const result =
              resolution === "archive"
                ? await archiveItem(vault ?? "", target.path)
                : await deleteItem(vault ?? "", target.path)
            handleApplyMutation(result)
            if (resolution === "archive") {
              window.dispatchEvent(new Event("amby:archive-changed"))
            }
            for (const document of targetDocuments) {
              autosave.discard(autosaveKey(document.id))
              useDocStore.getState().clearExternalConflict(document.id)
              if (
                resolution === "keep_recovery" ||
                (resolution === "archive" && hasDirtyDocuments)
              ) {
                void saveRecoveryDraft(
                  document.id,
                  document.content,
                  "markdown",
                  document.path,
                  recoveryScope,
                )
              } else {
                void discardRecoveryDraft(document.id, recoveryScope)
                void discardRecoveryDraft(document.path, recoveryScope)
              }
            }
          } catch (error) {
            failed += 1
            console.error("Failed to delete:", error)
          }
        }
        if (failed > 0) {
          void showErrorMessage(t("workspace.deleteManyFailed", { failed, total: targets.length }))
        }
      } finally {
        finishLocalMutation()
      }
    },
    [
      autosave,
      autosaveKey,
      handleApplyMutation,
      recoveryScope,
      requestDeleteConfirmation,
      t,
      treeItems,
      vault,
    ],
  )
  const handleDeleteFile = React.useCallback(
    (id: string, mode: DeleteMode = "delete") => handleDeleteFiles([id], mode),
    [handleDeleteFiles],
  )
  const createDocumentIn = React.useCallback(
    async (parentId: string | null, inNewTab = false) => {
      if (!vault) return
      const parent = parentId ? findTreeItem(treeItems, parentId) : null
      const normalize = (path: string) => path.replace(/\\/gu, "/").replace(/\/+$/u, "")
      const parentPath = normalize(parent?.path ?? parentId ?? vault)
      const parentDirectory = parentPath.slice(0, Math.max(0, parentPath.lastIndexOf("/")))
      const parentName = parentPath.slice(parentPath.lastIndexOf("/") + 1).replace(/\.[^.]+$/u, "")
      const parentIsBundle =
        parent?.type === "file" &&
        parentDirectory.slice(parentDirectory.lastIndexOf("/") + 1) === parentName
      const container =
        parent?.type === "file"
          ? parentIsBundle
            ? parentDirectory
            : `${parentDirectory}/${parentName}`
          : parentPath
      const reservationKey = container.toLocaleLowerCase()
      const reservedNames = noteNameReservationsRef.current.get(reservationKey) ?? new Set<string>()
      noteNameReservationsRef.current.set(reservationKey, reservedNames)
      const title = nextAvailableNoteName(
        treeItems,
        container,
        t("defaults.untitled"),
        reservedNames,
      )
      reservedNames.add(title.toLocaleLowerCase())
      const optimisticId = `pending:create:${Date.now()}:${Math.random().toString(36).slice(2)}`
      if (parent) useViewStateStore.getState().expandTreeItem(parent.id)
      setTreeItems((current) =>
        insertTreeItemOptimistically(current, parentId, {
          id: optimisticId,
          path: `${container}/${title}.md`,
          name: title,
          type: "file",
          icon: "file",
        }),
      )
      const finishLocalMutation = beginLocalTreeMutation()
      try {
        const result = await createNote(vault, parent?.path ?? parentId ?? vault, title)
        handleApplyMutation(result)
        finishLocalMutation()
        setTreeItems((current) => removeTreeItem(current, optimisticId))
        // The mutation result already patches the loaded tree. Avoid a second full vault scan.
        const id = result.primaryId ?? result.primaryPath
        if (!id) return
        const note = await readNote(vault, id)
        const actualTitle = result.primaryPath ? wsPathStem(result.primaryPath) : title
        setDoc(id, {
          id,
          title: actualTitle,
          content: note.content,
          created: t("time.justNow"),
          modified: t("time.justNow"),
          wordCount: 0,
          path: result.primaryPath ?? id,
          revision: note.revision,
          source: note.source,
        })
        openItem({ kind: "document", fileId: id, title: actualTitle }, inNewTab)
        // Trigger this after the document/tab state is ready. The sidebar
        // otherwise receives the trigger and then immediately loses its edit
        // row when opening the new document updates the selected item.
        setPendingRenameId(id)
        void releaseUnusedDocumentBuffers()
      } catch (error) {
        setTreeItems((current) => removeTreeItem(current, optimisticId))
        console.error("Failed to create file:", error)
      } finally {
        reservedNames.delete(title.toLocaleLowerCase())
        if (reservedNames.size === 0) noteNameReservationsRef.current.delete(reservationKey)
        finishLocalMutation()
      }
    },
    [
      handleApplyMutation,
      openItem,
      releaseUnusedDocumentBuffers,
      setDoc,
      setPendingRenameId,
      setTreeItems,
      t,
      treeItems,
      vault,
    ],
  )
  const handleNewFolderIn = React.useCallback(
    async (parentId: string | null, requestedName?: string) => {
      if (!vault) return
      const parent = parentId ? findTreeItem(treeItems, parentId) : null
      const title = requestedName?.trim() || t("defaults.untitled")
      if (!title || title === "." || title === ".." || /[\\/]/u.test(title)) return
      const finishLocalMutation = beginLocalTreeMutation()
      try {
        const path = await createFolder(parent?.path ?? parentId ?? vault, title)
        recordLocalTreePaths([path])
        finishLocalMutation()
        const item = {
          id: `folder:${path}`,
          path,
          name: title,
          type: "folder" as const,
          icon: "folder",
          children: [],
        }
        if (parentId)
          setTreeItems((previous) =>
            updateInTree(previous, parentId, (folder) => ({
              ...folder,
              children: [...(folder.children ?? []), item],
            })),
          )
        else setTreeItems((previous) => [...previous, item])
        setPendingRenameId(item.id)
        setTimeout(
          () => setPendingRenameId((current) => (current === item.id ? null : current)),
          500,
        )
      } catch (error) {
        console.error("Failed to create folder:", error)
      } finally {
        finishLocalMutation()
      }
    },
    [setPendingRenameId, setTreeItems, t, treeItems, vault],
  )
  const handleNewCanvasIn = React.useCallback(
    async (parentId: string | null) => {
      if (!vault) return
      try {
        const path = await createCanvasFile(
          vault,
          findTreeItem(treeItems, parentId ?? "")?.path ?? parentId ?? null,
          t("defaults.untitled"),
        )
        await refreshTree()
        setOpenCanvases((previous) => ({ ...previous, [path]: "{}\n" }))
        const title = wsPathStem(path)
        openItem({ kind: "canvas", fileId: path, title })
        void releaseUnusedDocumentBuffers()
      } catch (error) {
        console.error("Failed to create canvas:", error)
      }
    },
    [refreshTree, openItem, releaseUnusedDocumentBuffers, setOpenCanvases, t, treeItems, vault],
  )
  const handleAttachCanvasToNote = React.useCallback(
    async (canvasId: string) => {
      if (!vault) return
      const canvasPath =
        findTreeItem(treeItems, canvasId)?.path ?? canvasId.replace(/^canvas:/u, "")
      try {
        const result = await attachCanvasToNote(vault, canvasPath)
        handleApplyMutation(result)
        await refreshTree()
        setTabs((previous) =>
          previous.filter((tab) => !(tab.kind === "canvas" && tab.fileId === canvasPath)),
        )
        const path = result.primaryPath
        if (!path) return
        const id = result.primaryId ?? path
        const title = wsPathStem(path)
        try {
          await loadDoc(id, title)
        } catch {
          /* best effort */
        }
        setActiveLayer(id, "canvas")
        openItem({ kind: "document", fileId: id, title })
        void releaseUnusedDocumentBuffers()
      } catch (error) {
        console.error("Failed to attach canvas to note:", error)
      }
    },
    [
      handleApplyMutation,
      loadDoc,
      refreshTree,
      setActiveLayer,
      openItem,
      releaseUnusedDocumentBuffers,
      setTabs,
      treeItems,
      vault,
    ],
  )
  return {
    handleDeleteFile,
    handleDeleteFiles,
    handleNewFileIn: createDocumentIn,
    handleNewFolderIn,
    handleNewCanvasIn,
    handleAttachCanvasToNote,
    deleteConfirmationDialog: pendingDelete
      ? React.createElement(DeleteConfirmationDialog, {
          name: pendingDelete.name,
          count: pendingDelete.count,
          isDirtyOrConflicted: pendingDelete.isDirtyOrConflicted,
          onCancel: () => settleDeleteConfirmation("cancel"),
          onConfirm: (dontAskAgain: boolean) => settleDeleteConfirmation("confirm", dontAskAgain),
          onArchive: () => settleDeleteConfirmation("archive"),
          onKeepRecovery: () => settleDeleteConfirmation("keep_recovery"),
          onDiscard: () => settleDeleteConfirmation("discard"),
        })
      : null,
  }
}
