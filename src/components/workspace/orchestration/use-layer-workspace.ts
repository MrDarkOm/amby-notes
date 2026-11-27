import * as React from "react"
import {
  discardRecoveryDraft,
  migrateLegacyRecoveryDrafts,
  scheduleRecoveryDraft,
  type RecoveryScope,
} from "@/lib/recovery-drafts"
import { readFile } from "@/lib/storage"
import { recordAutosaveDiagnostic } from "@/lib/debug/autosave"
import { logger, errorType } from "@/lib/logger"
import { useDocStore } from "../use-doc-store"
import { useNoteNoticesStore } from "../note-notices/use-note-notices-store"
import { operationErrorCode } from "@/lib/operation-errors"
import { LayerUnreadableError, layerDocIds } from "./layer-draft"
import { FileConflictPausedError, FileRevisionTracker } from "../autosave/file-revision-tracker"
import { AutosaveCoordinator, type AutosaveKey } from "../autosave/autosave-coordinator"
import { registerAutosaveLifecycle } from "../autosave/autosave-lifecycle"
import { DeletedPaths } from "../autosave/deleted-paths"
import { isPathInside } from "../workspace-mutations"
import { settleLayerDraft } from "./layer-draft"
import { CanvasLoadDeduplicator } from "./canvas-load-dedup"

type LayerAutosavePayload = { path: string; json: string }

/** What differs between the layer kinds; pass one stable (module-level) object per kind. */
export type LayerWorkspaceConfig = {
  /** Autosave key kind, recovery-draft kind and the prefix of the logged event names. */
  kind: "canvas" | "sketch"
  /** Parses and re-serializes layer JSON; throws when it is not a valid layer. */
  validate: (json: string) => string
  /** The content of a layer that does not exist yet. */
  emptyJson: () => string
  /** Whether this hook moves the legacy vault-wide recovery drafts once (one owner for both kinds). */
  migrateLegacyDrafts: boolean
}

/**
 * Owns the buffers of one layer kind (Obsidian .canvas, Excalidraw sketch) and their
 * recovery/autosave lifecycle. use-canvas-workspace.ts and use-sketch-workspace.ts are thin
 * wrappers that fix the kind and rename the members (SAVE-12).
 */
export function useLayerWorkspace(
  config: LayerWorkspaceConfig,
  generation: number,
  recoveryScope: RecoveryScope,
) {
  const { kind, validate, emptyJson, migrateLegacyDrafts } = config
  // Layer editing already owns an editor buffer (React Flow, Excalidraw). Keep the latest
  // serialized values in a ref so each drag/text checkpoint does not re-render
  // WorkspaceOrchestration and every cached document editor. Explicit buffer
  // lifecycle operations still bump a tiny revision for load/remap changes.
  const openBuffersRef = React.useRef<Record<string, string>>({})
  const [, setBufferRevision] = React.useState(0)
  const setOpenBuffers = React.useCallback(
    (
      update:
        Record<string, string> | ((previous: Record<string, string>) => Record<string, string>),
    ) => {
      const previous = openBuffersRef.current
      openBuffersRef.current = typeof update === "function" ? update(previous) : update
      setBufferRevision((revision) => revision + 1)
    },
    [],
  )
  const openBuffers = openBuffersRef.current
  const loadsRef = React.useRef(new CanvasLoadDeduplicator())
  const revisionsRef = React.useRef(new FileRevisionTracker())
  const deletedRef = React.useRef(new DeletedPaths())
  const unreadableRef = React.useRef(new Set<string>())
  const vaultGenerationRef = React.useRef({ generation })
  vaultGenerationRef.current.generation = generation

  const autosaveRef = React.useRef<{
    generation: number
    coordinator: AutosaveCoordinator<LayerAutosavePayload>
  } | null>(null)
  if (autosaveRef.current?.generation !== generation) {
    autosaveRef.current?.coordinator.cancelGeneration(autosaveRef.current.generation)
    autosaveRef.current = {
      generation,
      coordinator: new AutosaveCoordinator<LayerAutosavePayload>({
        delayMs: 500,
        onDiagnostic: recordAutosaveDiagnostic,
        save: ({ key, value, operationId }) =>
          revisionsRef.current.save(value.path, value.json, operationId, () =>
            autosaveRef.current?.coordinator.pause(key),
          ),
        onSaveSuccess: ({ key, value }) => {
          const pending = autosaveRef.current?.coordinator.inspect(key)
          if (
            vaultGenerationRef.current.generation === key.generation &&
            pending &&
            !pending.dirty
          ) {
            void discardRecoveryDraft(value.path, recoveryScope)
            const docStore = useDocStore.getState()
            docStore.markSaved(value.path)
            for (const docId of layerDocIds(value.path)) {
              docStore.markSaved(docId)
              useNoteNoticesStore.getState().setSaveFailed(docId, false)
            }
          }
        },
        onSaveFailure: ({ key, value }, error) => {
          if (error instanceof FileConflictPausedError) return
          logger.error(`${kind}.save_failed`, { errorType: errorType(error) })
          // Said on the note the layer belongs to, like a failed note save (SAVE-05). The draft
          // stays, and the note keeps its unsaved mark until a save succeeds.
          if (vaultGenerationRef.current.generation !== key.generation) return
          for (const docId of layerDocIds(value.path))
            useNoteNoticesStore.getState().setSaveFailed(docId, true)
        },
      }),
    }
  }
  const autosave = autosaveRef.current.coordinator
  const autosaveKey = React.useCallback(
    (path: string): AutosaveKey => ({ generation, kind, documentId: path }),
    [generation, kind],
  )

  const loadBuffer = React.useCallback(
    (path: string): Promise<string> =>
      loadsRef.current.run(generation, path, async () => {
        deletedRef.current.lift(path)
        let diskContent: string
        try {
          await revisionsRef.current.baseline(path)
          diskContent = validate(await readFile(path))
          unreadableRef.current.delete(path)
        } catch (error) {
          // A file that is not there yet opens empty. A file that is there but cannot be read or
          // parsed must never become an empty editable buffer: its first edit would replace the
          // file (SAVE-01). The open fails, and saves for the path are refused until it reads.
          if (operationErrorCode(error) !== "notFound") {
            unreadableRef.current.add(path)
            logger.warn(`${kind}.load_failed`, { failureCode: operationErrorCode(error) })
            throw new LayerUnreadableError(path)
          }
          diskContent = emptyJson()
        }
        return settleLayerDraft({
          path,
          recoveryScope,
          disk: diskContent,
          validate: validate,
          onRestored: (content) => {
            scheduleRecoveryDraft(path, content, kind, path, recoveryScope)
            autosave.enqueueImmediate(autosaveKey(path), { path, json: content })
          },
          readDisk: async () => {
            try {
              return validate(await readFile(path))
            } catch (error) {
              // Never an empty buffer in place of a file that is there (SAVE-01).
              if (operationErrorCode(error) === "notFound") return emptyJson()
              unreadableRef.current.add(path)
              throw new LayerUnreadableError(path)
            }
          },
          setBuffer: (content) => setOpenBuffers((prev) => ({ ...prev, [path]: content })),
        }).then((content) => {
          setOpenBuffers((prev) => ({ ...prev, [path]: content }))
          return content
        })
      }),
    [autosave, autosaveKey, emptyJson, generation, kind, recoveryScope, setOpenBuffers, validate],
  )

  const handleSave = React.useCallback(
    (path: string, json: string) => {
      let normalized: string
      try {
        normalized = validate(json)
      } catch {
        // Editor output is always valid; this guards the file against a broken serializer.
        logger.error(`${kind}.invalid_serialization`)
        return
      }
      // The file could not be read: an empty board shown in its place must not replace it (SAVE-01).
      if (unreadableRef.current.has(path)) return
      // Deleted by Amby: a closing editor must not queue a write (docs/notices.md, section 9).
      if (deletedRef.current.covers(path)) return
      if (openBuffersRef.current[path] === normalized) return
      openBuffersRef.current = { ...openBuffersRef.current, [path]: normalized }
      scheduleRecoveryDraft(path, normalized, kind, path, recoveryScope)
      for (const docId of layerDocIds(path)) useDocStore.getState().markUnsaved(docId)
      autosave.schedule(autosaveKey(path), { path, json: normalized })
    },
    [autosave, autosaveKey, kind, recoveryScope, validate],
  )

  /**
   * Amby deleted these paths (or folders): forget every layer buffer under them, with its queued
   * save, recovery draft and file baseline, and drop later saves for them until the path is opened again.
   */
  const discardDeleted = React.useCallback(
    (deletedPaths: readonly string[]) => {
      const inside = (path: string) => deletedPaths.some((root) => isPathInside(path, root))
      const known = new Set<string>(deletedPaths)
      for (const path of Object.keys(openBuffersRef.current)) if (inside(path)) known.add(path)
      for (const state of autosave.inspectAll()) {
        if (state.key.kind === kind && inside(state.key.documentId)) known.add(state.key.documentId)
      }
      for (const root of deletedPaths) deletedRef.current.add(root)
      for (const path of known) {
        autosave.discard(autosaveKey(path))
        revisionsRef.current.forget(path)
        void discardRecoveryDraft(path, recoveryScope)
      }
      if (Object.keys(openBuffersRef.current).some(inside)) {
        openBuffersRef.current = Object.fromEntries(
          Object.entries(openBuffersRef.current).filter(([path]) => !inside(path)),
        )
        setBufferRevision((revision) => revision + 1)
      }
    },
    [autosave, autosaveKey, kind, recoveryScope],
  )

  const reloadExternal = React.useCallback(
    async (path: string): Promise<boolean> => {
      if (openBuffersRef.current[path] === undefined) return false
      const pending = autosave.inspect(autosaveKey(path))
      if (pending?.dirty) {
        return false
      }
      try {
        // Capture first, commit only for an accepted reload: a file that fails
        // validation, or a buffer edited during the awaits, must keep its old
        // baseline so the next save conflicts instead of overwriting.
        const revision = await revisionsRef.current.capture(path)
        const diskContent = await readFile(path)
        const normalized = validate(diskContent)
        if (autosave.inspect(autosaveKey(path))?.dirty) return false
        revisionsRef.current.commit(path, revision)
        if (openBuffersRef.current[path] === normalized) return false
        openBuffersRef.current = { ...openBuffersRef.current, [path]: normalized }
        setBufferRevision((revision) => revision + 1)
        void discardRecoveryDraft(path, recoveryScope)
        return true
      } catch (error) {
        logger.warn(`${kind}.reload_failed`, { failureCode: operationErrorCode(error) })
        return false
      }
    },
    [autosave, autosaveKey, kind, recoveryScope, validate],
  )

  React.useEffect(
    () =>
      registerAutosaveLifecycle({
        generation,
        recoveryScope,
        flush: () => autosave.flushAll(),
        cancel: () => autosave.cancelGeneration(generation),
        hasDirtyBuffers: () =>
          autosave.inspectAll().some((state) => state.key.generation === generation && state.dirty),
        inspect: () => autosave.inspectAll(),
        waitForInFlight: (key) => autosave.waitForInFlight(key),
        pause: (key) => autosave.pause(key),
        resume: (key) => autosave.resume(key),
      }),
    [autosave, generation, recoveryScope],
  )
  React.useEffect(() => setOpenBuffers({}), [generation, setOpenBuffers])
  React.useEffect(() => {
    if (migrateLegacyDrafts) void migrateLegacyRecoveryDrafts(recoveryScope)
  }, [migrateLegacyDrafts, recoveryScope])

  return {
    autosave,
    autosaveKey,
    discardDeleted,
    fileRevisions: revisionsRef.current,
    handleSave,
    loadBuffer,
    openBuffers,
    reloadExternal,
    setOpenBuffers,
  }
}
