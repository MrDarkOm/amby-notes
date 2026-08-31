import * as React from "react"
import type { TFunction } from "i18next"
import { validateAndSerializeCanvas } from "@/lib/canvas-format"
import {
  discardRecoveryDraft,
  migrateLegacyRecoveryDrafts,
  readRecoveryDraft,
  saveRecoveryDraft,
} from "@/lib/recovery-drafts"
import { confirmAction, readFile, writeFile } from "@/lib/storage"
import { AutosaveCoordinator, type AutosaveKey } from "../autosave/autosave-coordinator"
import { registerAutosaveLifecycle } from "../autosave/autosave-lifecycle"
import { recoveryNeedsConfirmation, resolveRecoveryContent } from "../recovery-restore"
import { CanvasLoadDeduplicator } from "./canvas-load-dedup"

type CanvasAutosavePayload = { path: string; json: string }

/** Owns Canvas buffers and their recovery/autosave lifecycle. */
export function useCanvasWorkspace(generation: number, t: TFunction) {
  const [openCanvases, setOpenCanvases] = React.useState<Record<string, string>>({})
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
            void discardRecoveryDraft(value.path)
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
        const recovery = (await readRecoveryDraft(path))?.content
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
        if (resolved.discardDraft) void discardRecoveryDraft(path)
        if (resolved.restored) {
          void saveRecoveryDraft(path, resolved.content, "canvas", path)
          autosave.enqueueImmediate(autosaveKey(path), { path, json: resolved.content })
        }
        return resolved.content
      }),
    [autosave, autosaveKey, generation, t],
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
      setOpenCanvases((previous) => ({ ...previous, [path]: normalized }))
      void saveRecoveryDraft(path, normalized, "canvas", path)
      autosave.schedule(autosaveKey(path), { path, json: normalized })
    },
    [autosave, autosaveKey],
  )

  React.useEffect(
    () =>
      registerAutosaveLifecycle({
        generation,
        flush: () => autosave.flushAll(),
        cancel: () => autosave.cancelGeneration(generation),
        hasDirtyBuffers: () =>
          autosave.inspectAll().some((state) => state.key.generation === generation && state.dirty),
      }),
    [autosave, generation],
  )
  React.useEffect(() => setOpenCanvases({}), [generation])
  React.useEffect(() => {
    void migrateLegacyRecoveryDrafts()
  }, [])

  return {
    autosave,
    autosaveKey,
    handleCanvasSave,
    loadCanvasBuffer,
    openCanvases,
    setOpenCanvases,
  }
}
