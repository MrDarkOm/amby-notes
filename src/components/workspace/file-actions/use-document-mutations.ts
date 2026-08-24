import * as React from "react"
import i18n from "@/lib/i18n"
import { saveRecoveryDraft } from "@/lib/recovery-drafts"
import {
  confirmAction,
  deleteItem,
  moveItem,
  previewMoveRefactor,
  previewRenameRefactor,
  readNote,
  renameItem,
} from "@/lib/storage"
import { useDocStore } from "../use-doc-store"
import { useTabsStore } from "../use-tabs-store"
import { findTreeItem } from "../workspace-tree-utils"
import type { MarkdownAutosaveActions, UseFileActionsParams } from "./types"

type Params = Pick<
  UseFileActionsParams,
  "vault" | "treeItems" | "refreshTree" | "backendGeneration"
> &
  MarkdownAutosaveActions & { handleSelect: (id: string) => Promise<void> }

export function useDocumentMutations({
  vault,
  treeItems,
  refreshTree,
  backendGeneration,
  autosave,
  autosaveKey,
  handleApplyMutation,
  handleSelect,
}: Params) {
  const t = i18n.t.bind(i18n)
  const { patchDoc, markUnsaved } = useDocStore.getState()
  const { setTabs } = useTabsStore.getState()
  const handleRenameFile = React.useCallback(
    async (id: string, newName: string) => {
      const item = findTreeItem(treeItems, id)
      if (!item) return
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
        const result = await renameItem(vault ?? "", path, newName)
        handleApplyMutation(result)
        patchDoc(id, { title: newName, path: result.primaryPath ?? item.path ?? id })
        setTabs((previous) =>
          previous.map((tab) => (tab.fileId === id ? { ...tab, title: newName } : tab)),
        )
        await refreshTree()
      } catch (error) {
        console.error("Failed to rename:", error)
      }
    },
    [handleApplyMutation, patchDoc, refreshTree, setTabs, t, treeItems, vault],
  )
  const handleMoveItem = React.useCallback(
    async (sourceId: string, targetFolderId: string | null) => {
      const source = findTreeItem(treeItems, sourceId)
      if (!source || !vault) return
      const target = targetFolderId ? findTreeItem(treeItems, targetFolderId) : null
      if ((targetFolderId && !target) || (target && target.type !== "folder")) return
      const normalize = (path: string) => path.replace(/\\/g, "/")
      const dirname = (path: string) => {
        const value = normalize(path).replace(/\/+$/, "")
        const index = value.lastIndexOf("/")
        return index === -1 ? "" : value.slice(0, index)
      }
      const basename = (path: string) => normalize(path).replace(/\/+$/, "").split("/").pop() ?? ""
      const stem = (path: string) => basename(path).replace(/\.[^.]+$/, "")
      const sourcePath = source.path ?? sourceId
      const targetPath = target?.path ?? vault
      const normalizedSource = normalize(sourcePath)
      const sourceRoot =
        source.type === "file" && basename(dirname(normalizedSource)) === stem(normalizedSource)
          ? dirname(normalizedSource)
          : normalizedSource
      const normalizedTarget = normalize(targetPath)
      if (normalizedTarget.startsWith(`${sourceRoot}/`) || normalizedTarget === sourceRoot) return
      if (!targetFolderId && dirname(sourceRoot) === normalize(vault)) return
      try {
        const preview = await previewMoveRefactor(vault, sourcePath, targetPath)
        if (
          preview.replacements > 0 &&
          !(await confirmAction(
            t("workspace.moveRefactorConfirm", {
              replacements: preview.replacements,
              notes: preview.notes,
            }),
          ))
        )
          return
        handleApplyMutation(await moveItem(vault, sourcePath, targetPath))
        await refreshTree()
      } catch (error) {
        console.error("Failed to move item:", error)
      }
    },
    [handleApplyMutation, refreshTree, t, treeItems, vault],
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
        void saveRecoveryDraft(targetId, content, "markdown", path)
        autosave.enqueueImmediate(autosaveKey(targetId), {
          fileId: targetId,
          path,
          content,
          backendGeneration,
          expectedRevision: targetDocument?.revision ?? targetRead!.revision,
        })
        await autosave.flush(autosaveKey(targetId))
        handleApplyMutation(await deleteItem(vault, source.path))
        await refreshTree()
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
      refreshTree,
      t,
      treeItems,
      vault,
    ],
  )
  return { handleRenameFile, handleMoveItem, handleMergeFile }
}
