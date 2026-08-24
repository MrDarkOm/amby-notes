import * as React from "react"
import { errorType, logger } from "@/lib/logger"
import {
  discardRecoveryDraft,
  readRecoveryDraft,
  remapRecoveryDraft,
  saveRecoveryDraft,
} from "@/lib/recovery-drafts"
import {
  NoteRevisionConflictError,
  readNote,
  writeFile,
  writeNote,
  type FsMutationResult,
} from "@/lib/storage"
import { AutosaveCoordinator, type AutosaveKey } from "../autosave/autosave-coordinator"
import { registerAutosaveLifecycle } from "../autosave/autosave-lifecycle"
import {
  AUTOSAVE_CONFLICT_RESOLVED_EVENT,
  type AutosaveConflictResolution,
} from "../autosave/conflict-events"
import { selectEvictableDocumentIds } from "../document-buffer-lifecycle"
import { useDocStore } from "../use-doc-store"
import { useSettingsStore } from "../use-settings-store"
import { useTabsStore } from "../use-tabs-store"
import { planMutation } from "../workspace-mutations"
import type {
  MarkdownAutosaveActions,
  MarkdownAutosavePayload,
  UseFileActionsParams,
} from "./types"

class AutosaveConflictPausedError extends Error {}

export function useMarkdownAutosave({
  vault,
  autosaveGeneration,
  backendGeneration,
  windowLabel,
  applyMutationResult,
}: Pick<
  UseFileActionsParams,
  "vault" | "autosaveGeneration" | "backendGeneration" | "windowLabel" | "applyMutationResult"
>): MarkdownAutosaveActions {
  const vaultRef = React.useRef(vault)
  vaultRef.current = vault
  const generationRef = React.useRef(autosaveGeneration)
  const autosaveRef = React.useRef<AutosaveCoordinator<MarkdownAutosavePayload> | null>(null)
  if (generationRef.current !== autosaveGeneration) {
    autosaveRef.current?.cancelGeneration(generationRef.current)
    generationRef.current = autosaveGeneration
  }
  if (!autosaveRef.current) {
    autosaveRef.current = new AutosaveCoordinator<MarkdownAutosavePayload>({
      delayMs: useSettingsStore.getState().prefs.editor.autosaveMs,
      save: async (snapshot) => {
        if (snapshot.key.generation !== generationRef.current) return
        if (useDocStore.getState().externalConflicts[snapshot.value.fileId]) {
          autosaveRef.current?.pause(snapshot.key)
          throw new AutosaveConflictPausedError()
        }
        const activeVault = vaultRef.current
        if (!activeVault) return writeFile(snapshot.value.path, snapshot.value.content)
        if (!snapshot.value.expectedRevision) throw new Error("Missing note revision for autosave")
        try {
          const outcome = await writeNote(
            activeVault,
            snapshot.value.fileId,
            snapshot.value.content,
            snapshot.value.backendGeneration,
            snapshot.value.expectedRevision,
            windowLabel,
          )
          useDocStore.getState().patchDoc(snapshot.value.fileId, { revision: outcome.revision })
        } catch (error) {
          if (!(error instanceof NoteRevisionConflictError)) throw error
          const external = await readNote(activeVault, snapshot.value.fileId)
          const current = useDocStore.getState().openDocs[snapshot.value.fileId]
          if (current)
            useDocStore.getState().setExternalConflict({
              fileId: current.id,
              path: current.path,
              localContent: current.content,
              externalContent: external.content,
              externalRevision: external.revision,
            })
          autosaveRef.current?.pause(snapshot.key)
          throw new AutosaveConflictPausedError()
        }
      },
      onSaveSuccess: (snapshot) => {
        if (snapshot.key.generation !== generationRef.current) return
        const current = useDocStore.getState().openDocs[snapshot.value.fileId]
        if (
          !current ||
          current.content !== snapshot.value.content ||
          useDocStore.getState().externalConflicts[snapshot.value.fileId]
        )
          return
        void discardRecoveryDraft(snapshot.value.fileId)
        void discardRecoveryDraft(current.path)
        useDocStore.getState().markSaved(snapshot.value.fileId)
      },
      onSaveFailure: (snapshot, error) => {
        if (
          snapshot.key.generation !== generationRef.current ||
          error instanceof AutosaveConflictPausedError
        )
          return
        logger.error("autosave.failed", { errorType: errorType(error) })
      },
    })
  }
  const autosave = autosaveRef.current
  const autosaveKey = React.useCallback(
    (fileId: string): AutosaveKey => ({
      generation: autosaveGeneration,
      kind: "markdown",
      documentId: fileId,
    }),
    [autosaveGeneration],
  )
  React.useEffect(
    () =>
      registerAutosaveLifecycle({
        generation: autosaveGeneration,
        flush: () => autosave.flushAll(),
        cancel: () => autosave.cancelGeneration(autosaveGeneration),
        hasDirtyBuffers: () =>
          autosave
            .inspectAll()
            .some((state) => state.key.generation === autosaveGeneration && state.dirty),
      }),
    [autosave, autosaveGeneration],
  )
  const externalConflicts = useDocStore((state) => state.externalConflicts)
  React.useEffect(() => {
    for (const fileId of Object.keys(externalConflicts)) autosave.pause(autosaveKey(fileId))
  }, [autosave, autosaveKey, externalConflicts])
  React.useEffect(() => {
    const onConflictResolved = (event: Event) => {
      const detail = (
        event as CustomEvent<{ fileId: string; resolution: AutosaveConflictResolution }>
      ).detail
      if (!detail) return
      const key = autosaveKey(detail.fileId)
      if (detail.resolution === "discard") return autosave.discard(key)
      const document = useDocStore.getState().openDocs[detail.fileId]
      if (!document) return
      autosave.resume(key)
      autosave.enqueueImmediate(key, {
        fileId: detail.fileId,
        path: document.path,
        content: document.content,
        backendGeneration,
        expectedRevision: document.revision,
      })
    }
    window.addEventListener(AUTOSAVE_CONFLICT_RESOLVED_EVENT, onConflictResolved)
    return () => window.removeEventListener(AUTOSAVE_CONFLICT_RESOLVED_EVENT, onConflictResolved)
  }, [autosave, autosaveKey, backendGeneration])
  const handleApplyMutation = React.useCallback(
    (result: FsMutationResult) => {
      const { deletedIds, remapFn } = planMutation(result)
      for (const id of deletedIds) autosave.discard(autosaveKey(id))
      for (const [id, doc] of Object.entries(useDocStore.getState().openDocs)) {
        if (deletedIds.includes(id)) continue
        const path = remapFn(doc.path)
        if (path !== doc.path) {
          autosave.remapKey(autosaveKey(id), autosaveKey(id), (payload) => ({ ...payload, path }))
          void remapRecoveryDraft(id, id, "markdown", path)
          void remapRecoveryDraft(doc.path, path, "markdown", path)
        }
      }
      applyMutationResult(result)
    },
    [applyMutationResult, autosave, autosaveKey],
  )
  const handleContentChange = React.useCallback(
    (fileId: string, content: string) => {
      const document = useDocStore.getState().openDocs[fileId]
      if (!document || document.id !== fileId)
        return logger.error("autosave.rejected_document_mismatch", { fileId })
      useDocStore.getState().patchDoc(fileId, { content })
      useDocStore.getState().markUnsaved(fileId)
      if (document.path) void saveRecoveryDraft(fileId, content, "markdown", document.path)
      const key = autosaveKey(fileId)
      if (useDocStore.getState().externalConflicts[fileId]) return autosave.pause(key)
      autosave.resume(key)
      autosave.schedule(
        key,
        {
          fileId,
          path: document.path,
          content,
          backendGeneration,
          expectedRevision: document.revision,
        },
        useSettingsStore.getState().prefs.editor.autosaveMs,
      )
    },
    [autosave, autosaveKey, backendGeneration],
  )
  const releaseUnusedDocumentBuffers = React.useCallback(async () => {
    const hasPendingAutosave = (fileId: string) => {
      const pending = autosave.inspect(autosaveKey(fileId))
      return Boolean(
        pending && (pending.dirty || pending.scheduled || pending.inFlight || pending.paused),
      )
    }
    const snapshot = useDocStore.getState()
    const initiallyEligible = selectEvictableDocumentIds({
      ...snapshot,
      ...useTabsStore.getState(),
      hasPendingAutosave,
      hasRecoveryDraft: () => false,
    })
    if (!initiallyEligible.length) return
    const recoveryIds = new Set(
      (
        await Promise.all(
          initiallyEligible.map(async (fileId) => {
            const document = snapshot.openDocs[fileId]
            if (!document) return null
            const [byId, byPath] = await Promise.all([
              readRecoveryDraft(fileId),
              readRecoveryDraft(document.path),
            ])
            return byId || byPath ? fileId : null
          }),
        )
      ).filter((fileId): fileId is string => fileId !== null),
    )
    useDocStore.getState().evictCleanDocs(
      selectEvictableDocumentIds({
        ...useDocStore.getState(),
        ...useTabsStore.getState(),
        hasPendingAutosave,
        hasRecoveryDraft: (fileId) => recoveryIds.has(fileId),
      }),
    )
  }, [autosave, autosaveKey])
  return {
    autosave,
    autosaveKey,
    handleApplyMutation,
    handleContentChange,
    releaseUnusedDocumentBuffers,
  }
}
