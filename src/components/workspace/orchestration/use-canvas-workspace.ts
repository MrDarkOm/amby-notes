import * as React from "react"
import type { TFunction } from "i18next"
import { validateAndSerializeCanvas } from "@/lib/canvas-format"
import {
  discardRecoveryDraft,
  migrateLegacyRecoveryDrafts,
  readRecoveryDraft,
  scheduleRecoveryDraft,
  type RecoveryScope,
} from "@/lib/recovery-drafts"
import { confirmAction, readFile, writeFile } from "@/lib/storage"
import { AutosaveCoordinator, type AutosaveKey } from "../autosave/autosave-coordinator"
import { registerAutosaveLifecycle } from "../autosave/autosave-lifecycle"
import { recoveryNeedsConfirmation, resolveRecoveryContent } from "../recovery-restore"
import { CanvasLoadDeduplicator } from "./canvas-load-dedup"

type CanvasAutosavePayload = { path: string; json: string }

/** Owns Canvas buffers and their recovery/autosave lifecycle. */
export function useCanvasWorkspace(generation: number, t: TFunction, recoveryScope: RecoveryScope) {
  // Canvas editing already owns a React Flow buffer below. Keep the latest
  // serialized values in a ref so each drag/text checkpoint does not re-render
  // WorkspaceOrchestration and every cached document editor. Explicit buffer
  // lifecycle operations still bump a tiny revision for load/remap changes.
  const openCanvasesRef = React.useRef<Record<string, string>>({})
  const [, setCanvasRevision] = React.useState(0)
  const setOpenCanvases = React.useCallback(
    (
      update:
        Record<string, string> | ((previous: Record<string, string>) => Record<string, string>),
    ) => {
      const previous = openCanvasesRef.current
      openCanvasesRef.current = typeof update === "function" ? update(previous) : update
      setCanvasRevision((revision) => revision + 1)
    },
    [],
  )
  const openCanvases = openCanvasesRef.current
  const canvasLoadsRef = React.useRef(new CanvasLoadDeduplicator())
  const vaultGenerationRef = React.useRef({ generation })
  vaultGenerationRef.current.generation = generation

  const autosaveRef = React.useRef<{
    generation: number
    coordinator: AutosaveCoordinator<CanvasAutosavePayload>
  } | null>(null)
  if (autosaveRef.current?.generation !== generation) {
    autosaveRef.current?.coordinator.cancelGeneration(autosaveRef.current.generation)
    autosaveRef.current = {
      generation,
      coordinator: new AutosaveCoordinator<CanvasAutosavePayload>({
        delayMs: 500,
        save: ({ value }) => writeFile(value.path, value.json),
        onSaveSuccess: ({ key, value }) => {
          const pending = autosaveRef.current?.coordinator.inspect(key)
          if (
            vaultGenerationRef.current.generation === key.generation &&
            pending &&
            !pending.dirty
          ) {
            void discardRecoveryDraft(value.path, recoveryScope)
          }
        },
        onSaveFailure: (_snapshot, error) => console.error("Failed to save canvas:", error),
      }),
    }
  }
  const autosave = autosaveRef.current.coordinator
  const autosaveKey = React.useCallback(
    (path: string): AutosaveKey => ({ generation, kind: "canvas", documentId: path }),
    [generation],
  )

  const loadCanvasBuffer = React.useCallback(
    (path: string): Promise<string> =>
      canvasLoadsRef.current.run(generation, path, async () => {
        let diskContent: string
        try {
          diskContent = validateAndSerializeCanvas(await readFile(path))
        } catch {
          diskContent = "{}"
        }
        const recovery = (await readRecoveryDraft(path, recoveryScope))?.content
        let recoveredContent: string | undefined
        if (recovery !== undefined) {
          try {
            recoveredContent = validateAndSerializeCanvas(recovery)
          } catch (error) {
            console.error("Ignoring invalid canvas recovery draft:", error)
          }
        }
        const restoreConfirmed = recoveryNeedsConfirmation(diskContent, recoveredContent)
          ? await confirmAction(t("recovery.restorePrompt"))
          : false
        const resolved = resolveRecoveryContent(diskContent, recoveredContent, restoreConfirmed)
        if (resolved.discardDraft) void discardRecoveryDraft(path, recoveryScope)
        if (resolved.restored) {
          scheduleRecoveryDraft(path, resolved.content, "canvas", path, recoveryScope)
          autosave.enqueueImmediate(autosaveKey(path), { path, json: resolved.content })
        }
        return resolved.content
      }),
    [autosave, autosaveKey, generation, recoveryScope, t],
  )

  const handleCanvasSave = React.useCallback(
    (path: string, json: string) => {
      let normalized: string
      try {
        normalized = validateAndSerializeCanvas(json)
      } catch (error) {
        console.error("Refusing to save invalid canvas:", error)
        return
      }
      openCanvasesRef.current = { ...openCanvasesRef.current, [path]: normalized }
      scheduleRecoveryDraft(path, normalized, "canvas", path, recoveryScope)
      autosave.schedule(autosaveKey(path), { path, json: normalized })
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
      }),
    [autosave, generation, recoveryScope],
  )
  React.useEffect(() => setOpenCanvases({}), [generation, setOpenCanvases])
  React.useEffect(() => {
    void migrateLegacyRecoveryDrafts(recoveryScope)
  }, [recoveryScope])

  return {
    autosave,
    autosaveKey,
    handleCanvasSave,
    loadCanvasBuffer,
    openCanvases,
    setOpenCanvases,
  }
}
