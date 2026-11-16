import * as React from "react"
import type { TFunction } from "i18next"
import { validateAndSerializeSketch, defaultSketchJson } from "@/lib/sketch-format"
import {
  discardRecoveryDraft,
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

type SketchAutosavePayload = { path: string; json: string }

/** Owns Excalidraw sketch buffers and their recovery/autosave lifecycle. */
export function useSketchWorkspace(
  generation: number,
  _t: TFunction,
  recoveryScope: RecoveryScope,
) {
  const openSketchesRef = React.useRef<Record<string, string>>({})
  const [, setSketchRevision] = React.useState(0)
  const setOpenSketches = React.useCallback(
    (
      update:
        Record<string, string> | ((previous: Record<string, string>) => Record<string, string>),
    ) => {
      const previous = openSketchesRef.current
      openSketchesRef.current = typeof update === "function" ? update(previous) : update
      setSketchRevision((revision) => revision + 1)
    },
    [],
  )
  const openSketches = openSketchesRef.current
  const sketchLoadsRef = React.useRef(new CanvasLoadDeduplicator())
  const revisionsRef = React.useRef(new FileRevisionTracker())
  const deletedRef = React.useRef(new DeletedPaths())
  const unreadableRef = React.useRef(new Set<string>())
  const vaultGenerationRef = React.useRef({ generation })
  vaultGenerationRef.current.generation = generation

  const autosaveRef = React.useRef<{
    generation: number
    coordinator: AutosaveCoordinator<SketchAutosavePayload>
  } | null>(null)

  if (autosaveRef.current?.generation !== generation) {
    autosaveRef.current?.coordinator.cancelGeneration(autosaveRef.current.generation)
    autosaveRef.current = {
      generation,
      coordinator: new AutosaveCoordinator<SketchAutosavePayload>({
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
          logger.error("sketch.save_failed", { errorType: errorType(error) })
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
    (path: string): AutosaveKey => ({ generation, kind: "sketch", documentId: path }),
    [generation],
  )

  const loadSketchBuffer = React.useCallback(
    (path: string): Promise<string> =>
      sketchLoadsRef.current.run(generation, path, async () => {
        deletedRef.current.lift(path)
        let diskContent: string
        try {
          await revisionsRef.current.baseline(path)
          diskContent = validateAndSerializeSketch(await readFile(path))
          unreadableRef.current.delete(path)
        } catch (error) {
          // A file that is not there yet opens empty. A file that is there but cannot be read or
          // parsed must never become an empty editable buffer: its first edit would replace the
          // file (SAVE-01). The open fails, and saves for the path are refused until it reads.
          if (operationErrorCode(error) !== "notFound") {
            unreadableRef.current.add(path)
            logger.warn("sketch.load_failed", { failureCode: operationErrorCode(error) })
            throw new LayerUnreadableError(path)
          }
          diskContent = defaultSketchJson()
        }
        return settleLayerDraft({
          path,
          recoveryScope,
          disk: diskContent,
          validate: validateAndSerializeSketch,
          onRestored: (content) => {
            scheduleRecoveryDraft(path, content, "sketch", path, recoveryScope)
            autosave.enqueueImmediate(autosaveKey(path), { path, json: content })
          },
          readDisk: async () => {
            try {
              return validateAndSerializeSketch(await readFile(path))
            } catch (error) {
              // Never an empty buffer in place of a file that is there (SAVE-01).
              if (operationErrorCode(error) === "notFound") return defaultSketchJson()
              unreadableRef.current.add(path)
              throw new LayerUnreadableError(path)
            }
          },
          setBuffer: (content) => setOpenSketches((prev) => ({ ...prev, [path]: content })),
        }).then((content) => {
          setOpenSketches((prev) => ({ ...prev, [path]: content }))
          return content
        })
      }),
    [autosave, autosaveKey, generation, recoveryScope, setOpenSketches],
  )

  const handleSketchSave = React.useCallback(
    (path: string, json: string) => {
      let normalized: string
      try {
        normalized = validateAndSerializeSketch(json)
      } catch {
        // Editor output is always valid; this guards the file against a broken serializer.
        logger.error("sketch.invalid_serialization")
        return
      }
      // The file could not be read: an empty board shown in its place must not replace it (SAVE-01).
      if (unreadableRef.current.has(path)) return
      // Deleted by Amby: a closing editor must not queue a write (docs/notices.md, section 9).
      if (deletedRef.current.covers(path)) return
      if (openSketchesRef.current[path] === normalized) return
      openSketchesRef.current = { ...openSketchesRef.current, [path]: normalized }
      scheduleRecoveryDraft(path, normalized, "sketch", path, recoveryScope)
      for (const docId of layerDocIds(path)) useDocStore.getState().markUnsaved(docId)
      autosave.schedule(autosaveKey(path), { path, json: normalized })
    },
    [autosave, autosaveKey, recoveryScope],
  )

  /**
   * Amby deleted these paths (or folders): forget every sketch buffer under them, with its queued
   * save, recovery draft and file baseline, and drop later saves for them until the path is opened again.
   */
  const discardDeleted = React.useCallback(
    (deletedPaths: readonly string[]) => {
      const inside = (path: string) => deletedPaths.some((root) => isPathInside(path, root))
      const known = new Set<string>(deletedPaths)
      for (const path of Object.keys(openSketchesRef.current)) if (inside(path)) known.add(path)
      for (const state of autosave.inspectAll()) {
        if (state.key.kind === "sketch" && inside(state.key.documentId))
          known.add(state.key.documentId)
      }
      for (const root of deletedPaths) deletedRef.current.add(root)
      for (const path of known) {
        autosave.discard(autosaveKey(path))
        revisionsRef.current.forget(path)
        void discardRecoveryDraft(path, recoveryScope)
      }
      if (Object.keys(openSketchesRef.current).some(inside)) {
        openSketchesRef.current = Object.fromEntries(
          Object.entries(openSketchesRef.current).filter(([path]) => !inside(path)),
        )
        setSketchRevision((revision) => revision + 1)
      }
    },
    [autosave, autosaveKey, recoveryScope],
  )

  const reloadExternalSketch = React.useCallback(
    async (path: string): Promise<boolean> => {
      if (openSketchesRef.current[path] === undefined) return false
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
        const normalized = validateAndSerializeSketch(diskContent)
        if (autosave.inspect(autosaveKey(path))?.dirty) return false
        revisionsRef.current.commit(path, revision)
        if (openSketchesRef.current[path] === normalized) return false
        openSketchesRef.current = { ...openSketchesRef.current, [path]: normalized }
        setSketchRevision((revision) => revision + 1)
        void discardRecoveryDraft(path, recoveryScope)
        return true
      } catch (error) {
        logger.warn("sketch.reload_failed", { failureCode: operationErrorCode(error) })
        return false
      }
    },
    [autosave, autosaveKey, recoveryScope],
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

  React.useEffect(() => setOpenSketches({}), [generation, setOpenSketches])

  return {
    autosave,
    autosaveKey,
    discardDeleted,
    fileRevisions: revisionsRef.current,
    handleSketchSave,
    loadSketchBuffer,
    openSketches,
    reloadExternalSketch,
    setOpenSketches,
  }
}
