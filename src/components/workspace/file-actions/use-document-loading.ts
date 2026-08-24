import * as React from "react"
import i18n from "@/lib/i18n"
import { discardRecoveryDraft, readRecoveryDraft } from "@/lib/recovery-drafts"
import {
  confirmAction,
  createNote,
  getNoteMetadata,
  getNoteProperties,
  readFile,
  readNote,
  writeNote,
} from "@/lib/storage"
import { formatModified, findTreeItem, newTabKey } from "../workspace-tree-utils"
import { recoveryNeedsConfirmation, resolveRecoveryContent } from "../recovery-restore"
import { useDocStore, type Document } from "../use-doc-store"
import { useTabsStore } from "../use-tabs-store"
import type { MarkdownAutosaveActions, UseFileActionsParams } from "./types"

type Params = Pick<
  UseFileActionsParams,
  | "vault"
  | "treeItems"
  | "refreshTree"
  | "openCanvasTab"
  | "setPendingRenameId"
  | "backendGeneration"
  | "windowLabel"
> &
  MarkdownAutosaveActions

export function useDocumentLoading({
  vault,
  treeItems,
  refreshTree,
  openCanvasTab,
  setPendingRenameId,
  backendGeneration,
  windowLabel,
  autosave,
  autosaveKey,
  handleApplyMutation,
  releaseUnusedDocumentBuffers,
}: Params) {
  const t = i18n.t.bind(i18n)
  const tabs = useTabsStore((state) => state.tabs)
  const activeTabKey = useTabsStore((state) => state.activeTabKey)
  const { setTabs, setActiveTabKey } = useTabsStore.getState()
  const { setDoc, markUnsaved } = useDocStore.getState()
  const loadDoc = React.useCallback(
    async (fileId: string, itemName: string): Promise<Document> => {
      const existing = useDocStore.getState().openDocs[fileId]
      if (existing) return existing
      const item = findTreeItem(treeItems, fileId)
      const [note, meta, noteProperties] = vault
        ? await Promise.all([
            readNote(vault, fileId),
            getNoteMetadata(vault, fileId),
            getNoteProperties(vault, fileId),
          ])
        : await Promise.all([
            readFile(item?.path ?? fileId).then((content) => ({ content, revision: "" })),
            getNoteMetadata("", fileId),
            getNoteProperties("", fileId),
          ])
      const path = item?.path ?? fileId
      const recovered = (await readRecoveryDraft(fileId)) ?? (await readRecoveryDraft(path))
      const recovery = resolveRecoveryContent(
        note.content,
        recovered?.content,
        recoveryNeedsConfirmation(note.content, recovered?.content)
          ? await confirmAction(t("recovery.restorePrompt"))
          : false,
      )
      const document: Document = {
        id: fileId,
        title: itemName,
        content: recovery.content,
        created: formatModified(meta.created),
        modified: formatModified(meta.modified),
        wordCount: meta.word_count,
        path,
        revision: note.revision,
        noteProperties,
      }
      setDoc(fileId, document)
      if (recovery.restored) {
        markUnsaved(fileId)
        autosave.enqueueImmediate(autosaveKey(fileId), {
          fileId,
          path,
          content: recovery.content,
          backendGeneration,
          expectedRevision: note.revision,
        })
      } else if (recovery.discardDraft) {
        void discardRecoveryDraft(fileId)
        void discardRecoveryDraft(path)
      }
      return document
    },
    [autosave, autosaveKey, backendGeneration, markUnsaved, setDoc, t, treeItems, vault],
  )
  const handleSelect = React.useCallback(
    async (fileId: string) => {
      const item = findTreeItem(treeItems, fileId)
      if (item?.type === "folder") {
        const active = tabs.find((tab) => tab.key === activeTabKey)
        if (active?.kind === "folder")
          setTabs((previous) =>
            previous.map((tab) =>
              tab.key === activeTabKey
                ? {
                    ...tab,
                    fileId,
                    title: item.name,
                    history: [...tab.history.slice(0, tab.historyIndex + 1), fileId],
                    historyIndex: tab.historyIndex + 1,
                  }
                : tab,
            ),
          )
        else {
          const existing = tabs.find((tab) => tab.kind === "folder" && tab.fileId === fileId)
          if (existing) setActiveTabKey(existing.key)
          else {
            const key = newTabKey()
            setTabs((previous) => [
              ...previous,
              { key, kind: "folder", fileId, title: item.name, history: [fileId], historyIndex: 0 },
            ])
            setActiveTabKey(key)
          }
        }
        return
      }
      if (item?.type === "canvas") return openCanvasTab(item.path, item.name)
      if (!item || item.type !== "file") return
      try {
        await loadDoc(fileId, item.name)
      } catch (error) {
        console.error("Failed to load file:", error)
        return
      }
      const active = tabs.find((tab) => tab.key === activeTabKey)
      if (active?.kind === "document")
        setTabs((previous) =>
          previous.map((tab) =>
            tab.key !== activeTabKey
              ? tab
              : {
                  ...tab,
                  fileId,
                  title: item.name,
                  history: [...tab.history.slice(0, tab.historyIndex + 1), fileId],
                  historyIndex: tab.historyIndex + 1,
                },
          ),
        )
      else {
        const key = newTabKey()
        setTabs((previous) => [
          ...previous,
          { key, kind: "document", fileId, title: item.name, history: [fileId], historyIndex: 0 },
        ])
        setActiveTabKey(key)
      }
      void releaseUnusedDocumentBuffers()
    },
    [
      activeTabKey,
      loadDoc,
      openCanvasTab,
      releaseUnusedDocumentBuffers,
      setActiveTabKey,
      setTabs,
      tabs,
      treeItems,
    ],
  )
  const handleOpenInNewTab = React.useCallback(
    async (fileId: string) => {
      const item = findTreeItem(treeItems, fileId)
      if (item?.type === "folder") {
        const key = newTabKey()
        setTabs((previous) => [
          ...previous,
          { key, kind: "folder", fileId, title: item.name, history: [fileId], historyIndex: 0 },
        ])
        setActiveTabKey(key)
        return
      }
      if (item?.type === "canvas") return openCanvasTab(item.path, item.name)
      if (!item || item.type !== "file") return
      try {
        await loadDoc(fileId, item.name)
      } catch (error) {
        console.error("Failed to load file:", error)
        return
      }
      const key = newTabKey()
      setTabs((previous) => [
        ...previous,
        { key, kind: "document", fileId, title: item.name, history: [fileId], historyIndex: 0 },
      ])
      setActiveTabKey(key)
    },
    [loadDoc, openCanvasTab, setActiveTabKey, setTabs, treeItems],
  )
  const handleCloneFile = React.useCallback(
    async (fileId: string) => {
      if (!vault) return
      const item = findTreeItem(treeItems, fileId)
      if (!item || item.type !== "file") return
      try {
        const source = await readNote(vault, fileId)
        const path = item.path.replace(/\\/gu, "/")
        const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : vault
        const title = t("tree.cloneName", { name: item.name })
        const result = await createNote(vault, parent, title)
        const id = result.primaryId ?? result.primaryPath
        if (!id) return
        const target = await readNote(vault, id)
        const outcome = await writeNote(
          vault,
          id,
          source.content,
          backendGeneration,
          target.revision,
          windowLabel,
        )
        handleApplyMutation(result)
        await refreshTree()
        setDoc(id, {
          id,
          title,
          content: source.content,
          created: t("time.justNow"),
          modified: t("time.justNow"),
          wordCount: source.content.trim() ? source.content.trim().split(/\s+/u).length : 0,
          path: result.primaryPath ?? id,
          revision: outcome.revision,
        })
        const key = newTabKey()
        setTabs((previous) => [
          ...previous,
          { key, kind: "document", fileId: id, title, history: [id], historyIndex: 0 },
        ])
        setActiveTabKey(key)
        setPendingRenameId(id)
        setTimeout(() => setPendingRenameId(null), 500)
      } catch (error) {
        console.error("Failed to clone file:", error)
      }
    },
    [
      backendGeneration,
      handleApplyMutation,
      refreshTree,
      setActiveTabKey,
      setDoc,
      setPendingRenameId,
      setTabs,
      t,
      treeItems,
      vault,
      windowLabel,
    ],
  )
  const navigateToFile = React.useCallback(
    async (fileId: string) => {
      const item = findTreeItem(treeItems, fileId)
      if (!item) return
      try {
        await loadDoc(fileId, item.name)
      } catch {
        /* navigation is best-effort */
      }
    },
    [loadDoc, treeItems],
  )
  return { loadDoc, handleSelect, handleOpenInNewTab, handleCloneFile, navigateToFile }
}
