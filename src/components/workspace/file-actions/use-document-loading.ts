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
import { formatModified, findTreeItem } from "../workspace-tree-utils"
import { findTabTreeItem, treeItemTabTarget } from "../tab-target"
import {
  InFlightDocumentLoads,
  resolveMarkdownRecoveryLoad,
  StaleDocumentLoadError,
} from "../markdown-recovery-load"
import { useDocStore, type Document } from "../use-doc-store"
import { useTabsStore } from "../use-tabs-store"
import { useVaultStore } from "../use-vault-store"
import type { MarkdownAutosaveActions, UseFileActionsParams } from "./types"

type Params = Pick<
  UseFileActionsParams,
  | "vault"
  | "treeItems"
  | "refreshTree"
  | "loadCanvas"
  | "setPendingRenameId"
  | "backendGeneration"
  | "windowLabel"
> &
  MarkdownAutosaveActions

export function useDocumentLoading({
  vault,
  treeItems,
  refreshTree,
  loadCanvas,
  setPendingRenameId,
  backendGeneration,
  windowLabel,
  autosave,
  autosaveKey,
  handleApplyMutation,
  releaseUnusedDocumentBuffers,
}: Params) {
  const t = i18n.t.bind(i18n)
  const { openItem } = useTabsStore.getState()
  const selectionRequestRef = React.useRef(0)
  const { setDoc, markUnsaved } = useDocStore.getState()
  const loadRegistryRef = React.useRef<InFlightDocumentLoads<Document> | null>(null)
  if (!loadRegistryRef.current) loadRegistryRef.current = new InFlightDocumentLoads<Document>()
  const loadDoc = React.useCallback(
    (fileId: string, itemName: string): Promise<Document> => {
      const existing = useDocStore.getState().openDocs[fileId]
      if (existing) return Promise.resolve(existing)
      const scope = JSON.stringify([vault, backendGeneration])
      return loadRegistryRef.current!.run(scope, fileId, async () => {
        const alreadyLoaded = useDocStore.getState().openDocs[fileId]
        if (alreadyLoaded) return alreadyLoaded

        const expectedVault = vault
        const expectedBackendGeneration = backendGeneration
        const isCurrent = () => {
          const current = useVaultStore.getState()
          return (
            current.vault === expectedVault &&
            current.backendGeneration === expectedBackendGeneration
          )
        }
        const item = findTreeItem(treeItems, fileId)
        const [note, meta, noteProperties] = vault
          ? await Promise.all([
              readNote(vault, fileId),
              getNoteMetadata(vault, fileId),
              getNoteProperties(vault, fileId),
            ])
          : await Promise.all([
              readFile(item?.path ?? fileId).then((content) => ({
                content,
                revision: "",
                source: content,
              })),
              getNoteMetadata("", fileId),
              getNoteProperties("", fileId),
            ])
        if (!isCurrent()) throw new StaleDocumentLoadError()

        const path = item?.path ?? fileId
        const recovery = await resolveMarkdownRecoveryLoad({
          fileId,
          path,
          diskContent: note.content,
          readDraft: readRecoveryDraft,
          confirmRestore: () => confirmAction(t("recovery.restorePrompt")),
          isCurrent,
        })
        if (recovery.status === "stale") throw new StaleDocumentLoadError()

        const document: Document = {
          id: fileId,
          title: itemName,
          content: recovery.content,
          created: formatModified(meta.created),
          modified: formatModified(meta.modified),
          wordCount: meta.word_count,
          path,
          revision: note.revision,
          source: note.source,
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
          await Promise.all([discardRecoveryDraft(fileId), discardRecoveryDraft(path)])
        }
        return document
      })
    },
    [autosave, autosaveKey, backendGeneration, markUnsaved, setDoc, t, treeItems, vault],
  )
  const openTreeItem = React.useCallback(
    async (fileId: string, inNewTab = false) => {
      const item = findTabTreeItem(treeItems, fileId)
      if (!item) return
      const request = ++selectionRequestRef.current
      const initial = useTabsStore.getState()
      const initialTab = initial.tabs.find((tab) => tab.key === initial.activeTabKey)
      const target = treeItemTabTarget(item)
      // Existing tabs already own their buffers. Activate them immediately.
      if (
        !inNewTab &&
        initial.tabs.some((tab) => tab.kind === target.kind && tab.fileId === target.fileId)
      ) {
        openItem(target)
        return
      }
      try {
        if (item.type === "file") await loadDoc(item.id, item.name)
        else if (item.type === "canvas") await loadCanvas(item.path)
      } catch (error) {
        console.error("Failed to load file:", error)
        return
      }
      const currentVault = useVaultStore.getState()
      if (currentVault.vault !== vault || currentVault.backendGeneration !== backendGeneration)
        return
      const current = useTabsStore.getState()
      if (
        !inNewTab &&
        (request !== selectionRequestRef.current ||
          current.activeTabKey !== initial.activeTabKey ||
          current.tabs.find((tab) => tab.key === current.activeTabKey) !== initialTab)
      )
        return
      openItem(target, inNewTab)
      void releaseUnusedDocumentBuffers()
    },
    [
      backendGeneration,
      loadCanvas,
      loadDoc,
      openItem,
      releaseUnusedDocumentBuffers,
      treeItems,
      vault,
    ],
  )
  const handleSelect = React.useCallback((fileId: string) => openTreeItem(fileId), [openTreeItem])
  const handleOpenInNewTab = React.useCallback(
    (fileId: string) => openTreeItem(fileId, true),
    [openTreeItem],
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
          source: target.source,
        })
        openItem({ kind: "document", fileId: id, title })
        void releaseUnusedDocumentBuffers()
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
      openItem,
      releaseUnusedDocumentBuffers,
      setDoc,
      setPendingRenameId,
      t,
      treeItems,
      vault,
      windowLabel,
    ],
  )
  const navigateToFile = React.useCallback(
    async (fileId: string) => {
      const item = findTabTreeItem(treeItems, fileId)
      if (!item) return
      try {
        if (item.type === "file") await loadDoc(item.id, item.name)
        else if (item.type === "canvas") await loadCanvas(item.path)
      } catch {
        /* navigation is best-effort */
      }
    },
    [loadCanvas, loadDoc, treeItems],
  )
  return { loadDoc, handleSelect, handleOpenInNewTab, handleCloneFile, navigateToFile }
}
