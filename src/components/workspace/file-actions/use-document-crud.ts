import * as React from "react"
import i18n from "@/lib/i18n"
import { discardRecoveryDraft, saveRecoveryDraft } from "@/lib/recovery-drafts"
import {
  attachCanvasToNote,
  createCanvasFile,
  createFolder,
  createNote,
  deleteItem,
  readNote,
} from "@/lib/storage"
import { loadWorkspaceConfig, saveWorkspaceConfigPatch } from "../app-config"
import { DeleteConfirmationDialog } from "../delete-confirmation-dialog"
import { useDocStore, type Document } from "../use-doc-store"
import { useTabsStore } from "../use-tabs-store"
import { useViewStateStore } from "../use-view-state-store"
import { findTreeItem, updateInTree, wsPathStem } from "../workspace-tree-utils"
import type { MarkdownAutosaveActions, UseFileActionsParams } from "./types"

type DeleteResolution = "confirm" | "keep_recovery" | "discard" | "cancel"
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
}: Params) {
  const t = i18n.t.bind(i18n)
  const [pendingDelete, setPendingDelete] = React.useState<{
    id: string
    name: string
    isDirtyOrConflicted: boolean
    resolve: (action: DeleteResolution, dontAskAgain?: boolean) => void
  } | null>(null)
  const { setDoc } = useDocStore.getState()
  const { setTabs, openItem } = useTabsStore.getState()
  const { setActiveLayer } = useViewStateStore.getState()
  const requestDeleteConfirmation = React.useCallback(
    async (id: string, name: string, isDirtyOrConflicted: boolean): Promise<DeleteResolution> => {
      if (isDirtyOrConflicted)
        return new Promise((resolve) =>
          setPendingDelete({ id, name, isDirtyOrConflicted: true, resolve }),
        )
      const { confirmations } = await loadWorkspaceConfig()
      if (!confirmations.confirmFileDelete) return "confirm"
      return new Promise((resolve) =>
        setPendingDelete({ id, name, isDirtyOrConflicted: false, resolve }),
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
  const handleDeleteFile = React.useCallback(
    async (id: string) => {
      const item = findTreeItem(treeItems, id)
      const name = item?.name ?? id
      const folder = (item?.path ?? id).replace(/\\/g, "/").replace(/\/+$/, "")
      const affected = Object.values(useDocStore.getState().openDocs).filter(
        (document) =>
          document.id === id || document.path.replace(/\\/g, "/").startsWith(`${folder}/`),
      )
      const resolution = await requestDeleteConfirmation(
        id,
        name,
        affected.some(
          (document) =>
            useDocStore.getState().unsavedFileIds.has(document.id) ||
            Boolean(useDocStore.getState().externalConflicts[document.id]),
        ),
      )
      if (resolution === "cancel") return
      try {
        for (const document of affected) {
          autosave.discard(autosaveKey(document.id))
          useDocStore.getState().clearExternalConflict(document.id)
          if (resolution === "keep_recovery")
            void saveRecoveryDraft(document.id, document.content, "markdown", document.path)
          else {
            void discardRecoveryDraft(document.id)
            void discardRecoveryDraft(document.path)
          }
        }
        handleApplyMutation(await deleteItem(vault ?? "", item?.path ?? id))
        await refreshTree()
      } catch (error) {
        console.error("Failed to delete:", error)
      }
    },
    [
      autosave,
      autosaveKey,
      handleApplyMutation,
      refreshTree,
      requestDeleteConfirmation,
      treeItems,
      vault,
    ],
  )
  const createDocumentIn = React.useCallback(
    async (parentId: string | null, inNewTab = false) => {
      if (!vault) return
      const parent = parentId ? findTreeItem(treeItems, parentId) : null
      const title = t("defaults.untitled")
      try {
        const result = await createNote(vault, parent?.path ?? parentId ?? vault, title)
        handleApplyMutation(result)
        const updatedTree = await refreshTree()
        // The web adapter uses paths as IDs, so promoting a note can change its ID.
        const parentPath = result.pathChanges.find(
          (change) => change.oldPath === parent?.path,
        )?.newPath
        const updatedParent = parent
          ? (findTreeItem(updatedTree, parent.id) ?? findTreeItem(updatedTree, parentPath ?? ""))
          : null
        if (updatedParent) useViewStateStore.getState().expandTreeItem(updatedParent.id)
        const id = result.primaryId ?? result.primaryPath
        if (!id) return
        const note = await readNote(vault, id)
        setDoc(id, {
          id,
          title,
          content: "",
          created: t("time.justNow"),
          modified: t("time.justNow"),
          wordCount: 0,
          path: result.primaryPath ?? id,
          revision: note.revision,
          source: note.source,
        })
        openItem({ kind: "document", fileId: id, title }, inNewTab)
        void releaseUnusedDocumentBuffers()
        setPendingRenameId(id)
        setTimeout(() => setPendingRenameId(null), 500)
      } catch (error) {
        console.error("Failed to create file:", error)
      }
    },
    [
      handleApplyMutation,
      refreshTree,
      openItem,
      releaseUnusedDocumentBuffers,
      setDoc,
      setPendingRenameId,
      t,
      treeItems,
      vault,
    ],
  )
  const handleNewFolderIn = React.useCallback(
    async (parentId: string | null) => {
      if (!vault) return
      const parent = parentId ? findTreeItem(treeItems, parentId) : null
      const title = t("defaults.untitled")
      try {
        const path = await createFolder(parent?.path ?? parentId ?? vault, title)
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
        setTimeout(() => setPendingRenameId(null), 500)
      } catch (error) {
        console.error("Failed to create folder:", error)
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
    handleNewFileIn: createDocumentIn,
    handleNewFolderIn,
    handleNewCanvasIn,
    handleAttachCanvasToNote,
    deleteConfirmationDialog: pendingDelete
      ? React.createElement(DeleteConfirmationDialog, {
          name: pendingDelete.name,
          isDirtyOrConflicted: pendingDelete.isDirtyOrConflicted,
          onCancel: () => settleDeleteConfirmation("cancel"),
          onConfirm: (dontAskAgain: boolean) => settleDeleteConfirmation("confirm", dontAskAgain),
          onKeepRecovery: () => settleDeleteConfirmation("keep_recovery"),
          onDiscard: () => settleDeleteConfirmation("discard"),
        })
      : null,
  }
}
