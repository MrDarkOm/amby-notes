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
import { formatModified, findTreeItem, noteLayerPath } from "../workspace-tree-utils"
import { splitWebFrontmatter, webRevision } from "@/lib/storage/web-frontmatter"
import { findTabTreeItem, treeItemTabTarget } from "../tab-target"
import {
  InFlightDocumentLoads,
  resolveMarkdownRecoveryLoad,
  StaleDocumentLoadError,
} from "../markdown-recovery-load"
import { useDocStore, type Document } from "../use-doc-store"
import { useTabsStore } from "../use-tabs-store"
import { useVaultStore } from "../use-vault-store"
import { useViewStateStore, type EditorLayer } from "../use-view-state-store"
import type { MarkdownAutosaveActions, UseFileActionsParams } from "./types"

type Params = Pick<
  UseFileActionsParams,
  | "vault"
  | "treeItems"
  | "loadCanvas"
  | "loadSketch"
  | "setPendingRenameId"
  | "backendGeneration"
  | "windowLabel"
> &
  MarkdownAutosaveActions

export function useDocumentLoading({
  vault,
  treeItems,
  loadCanvas,
  loadSketch,
  setPendingRenameId,
  backendGeneration,
  windowLabel,
  autosave,
  autosaveKey,
  handleApplyMutation,
  releaseUnusedDocumentBuffers,
  recoveryScope,
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
        const item = findTabTreeItem(treeItems, fileId)
        const isCanvas =
          item?.type === "canvas" || fileId.endsWith(".canvas") || fileId.startsWith("canvas:")
        const isSketch =
          item?.type === "sketch" || fileId.endsWith(".excalidraw") || fileId.startsWith("sketch:")

        if (isCanvas || isSketch) {
          const path = item?.path ?? fileId.replace(/^(canvas|sketch):/u, "")
          if (isCanvas) {
            await loadCanvas(path)
          } else {
            await loadSketch(path)
          }
          let noteContent = ""
          let noteSource = ""
          let noteId: string | undefined
          let revision = ""
          const mdPath = noteLayerPath(path)
          try {
            const source = await readFile(mdPath)
            noteSource = source
            const idMatch = source.match(/^(?:amby-id|id):\s*([^\s]+)/m)
            if (idMatch) noteId = idMatch[1]
            if (noteId && vault) {
              try {
                const note = await readNote(vault, noteId)
                noteContent = note.content
                noteSource = note.source
                revision = note.revision
              } catch {
                // The note layer can exist briefly before the index sees it.
                // Keep it read-only until a stable revision is available.
              }
            }
            if (!revision) {
              const split = splitWebFrontmatter(source)
              noteContent = split ? split.body : source
              if (!noteId) revision = webRevision(noteContent)
            }
          } catch {
            // No markdown layer yet
          }
          const document: Document = {
            id: fileId,
            title: itemName,
            content: noteContent,
            created: item?.created ? formatModified(item.created) : "",
            modified: item?.modified ? formatModified(item.modified) : "",
            wordCount: 0,
            path,
            revision,
            source: noteSource,
            noteId,
          }
          setDoc(fileId, document)
          if (path && path !== fileId) {
            setDoc(path, document)
          }
          const targetLayer: EditorLayer = isCanvas ? "canvas" : "sketch"
          if (!useViewStateStore.getState().activeLayers[fileId]) {
            useViewStateStore.getState().setActiveLayer(fileId, targetLayer)
          }
          if (path && !useViewStateStore.getState().activeLayers[path]) {
            useViewStateStore.getState().setActiveLayer(path, targetLayer)
          }
          return document
        }

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
          readDraft: (id) => readRecoveryDraft(id, recoveryScope),
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
          noteId: fileId,
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
          await Promise.all([
            discardRecoveryDraft(fileId, recoveryScope),
            discardRecoveryDraft(path, recoveryScope),
          ])
        }
        return document
      })
    },
    [
      autosave,
      autosaveKey,
      backendGeneration,
      loadCanvas,
      loadSketch,
      markUnsaved,
      recoveryScope,
      setDoc,
      t,
      treeItems,
      vault,
    ],
  )
  const openTreeItem = React.useCallback(
    async (fileId: string, inNewTab = false, displayTitle?: string) => {
      const item = findTabTreeItem(treeItems, fileId)
      if (!item) return
      const request = ++selectionRequestRef.current
      const initial = useTabsStore.getState()
      const initialTab = initial.tabs.find((tab) => tab.key === initial.activeTabKey)
      const target = { ...treeItemTabTarget(item), title: displayTitle ?? item.name }
      const docExists = Boolean(
        useDocStore.getState().openDocs[target.fileId] ??
        (item.path ? useDocStore.getState().openDocs[item.path] : null),
      )
      // Existing tabs already own their buffers. Activate them immediately if loaded.
      if (
        !inNewTab &&
        initial.tabs.some((tab) => tab.kind === target.kind && tab.fileId === target.fileId) &&
        (target.kind === "database" || docExists)
      ) {
        initial.setTabs((tabs) =>
          tabs.map((tab) =>
            tab.kind === target.kind && tab.fileId === target.fileId
              ? { ...tab, title: target.title }
              : tab,
          ),
        )
        if (target.kind !== "database") {
          useDocStore.getState().patchDoc(fileId, { title: target.title })
        }
        openItem(target)
        return
      }
      try {
        if (item.type === "file") {
          await loadDoc(item.id, target.title)
        } else if (item.type === "canvas" || item.type === "sketch") {
          await loadDoc(target.fileId, target.title)
        }
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
    [backendGeneration, loadDoc, openItem, releaseUnusedDocumentBuffers, treeItems, vault],
  )
  const handleSelect = React.useCallback(
    (fileId: string, displayTitle?: string) => openTreeItem(fileId, false, displayTitle),
    [openTreeItem],
  )
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
        setTimeout(() => setPendingRenameId((current) => (current === id ? null : current)), 500)
      } catch (error) {
        console.error("Failed to clone file:", error)
      }
    },
    [
      backendGeneration,
      handleApplyMutation,
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
        else if (item.type === "canvas" || item.type === "sketch") {
          await loadDoc(item.path, item.name)
        }
      } catch {
        /* navigation is best-effort */
      }
    },
    [loadDoc, treeItems],
  )
  return { loadDoc, handleSelect, handleOpenInNewTab, handleCloneFile, navigateToFile }
}
