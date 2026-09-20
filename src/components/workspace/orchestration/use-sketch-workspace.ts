import * as React from "react"
import type { TFunction } from "i18next"
import { validateAndSerializeSketch, defaultSketchJson } from "@/lib/sketch-format"
import {
  discardRecoveryDraft,
  readRecoveryDraft,
  scheduleRecoveryDraft,
  type RecoveryScope,
} from "@/lib/recovery-drafts"
import { confirmAction, readFile, writeFile } from "@/lib/storage"
import { useDocStore } from "../use-doc-store"
import { sketchLayerPath } from "../workspace-tree-utils"
import { AutosaveCoordinator, type AutosaveKey } from "../autosave/autosave-coordinator"
import { registerAutosaveLifecycle } from "../autosave/autosave-lifecycle"
import { recoveryNeedsConfirmation, resolveRecoveryContent } from "../recovery-restore"
import { CanvasLoadDeduplicator } from "./canvas-load-dedup"

type SketchAutosavePayload = { path: string; json: string }

/** Owns Excalidraw sketch buffers and their recovery/autosave lifecycle. */
export function useSketchWorkspace(generation: number, t: TFunction, recoveryScope: RecoveryScope) {
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
        save: ({ value }) => writeFile(value.path, value.json),
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
            for (const [docId, doc] of Object.entries(docStore.openDocs)) {
              if (
                doc.path === value.path ||
                sketchLayerPath(doc.path) === value.path ||
                doc.id === value.path
              ) {
                docStore.markSaved(docId)
              }
            }
          }
        },
        onSaveFailure: (_snapshot, error) => console.error("Failed to save sketch:", error),
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
        let diskContent: string
        try {
          diskContent = validateAndSerializeSketch(await readFile(path))
        } catch {
          diskContent = defaultSketchJson()
        }
        const recovery = (await readRecoveryDraft(path, recoveryScope))?.content
        let recoveredContent: string | undefined
        if (recovery !== undefined) {
          try {
            recoveredContent = validateAndSerializeSketch(recovery)
          } catch (error) {
            console.error("Ignoring invalid sketch recovery draft:", error)
          }
        }
        const restoreConfirmed = recoveryNeedsConfirmation(diskContent, recoveredContent)
          ? await confirmAction(t("recovery.restorePrompt"))
          : false
        const resolved = resolveRecoveryContent(diskContent, recoveredContent, restoreConfirmed)
        if (resolved.discardDraft) void discardRecoveryDraft(path, recoveryScope)
        if (resolved.restored) {
          scheduleRecoveryDraft(path, resolved.content, "sketch", path, recoveryScope)
          autosave.enqueueImmediate(autosaveKey(path), { path, json: resolved.content })
        }
        return resolved.content
      }),
    [autosave, autosaveKey, generation, recoveryScope, t],
  )

  const handleSketchSave = React.useCallback(
    (path: string, json: string) => {
      let normalized: string
      try {
        normalized = validateAndSerializeSketch(json)
      } catch (error) {
        console.error("Refusing to save invalid sketch:", error)
        return
      }
      openSketchesRef.current = { ...openSketchesRef.current, [path]: normalized }
      scheduleRecoveryDraft(path, normalized, "sketch", path, recoveryScope)
      autosave.schedule(autosaveKey(path), { path, json: normalized })
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
        const diskContent = await readFile(path)
        const normalized = validateAndSerializeSketch(diskContent)
        if (openSketchesRef.current[path] === normalized) return false
        openSketchesRef.current = { ...openSketchesRef.current, [path]: normalized }
        setSketchRevision((revision) => revision + 1)
        void discardRecoveryDraft(path, recoveryScope)
        return true
      } catch (error) {
        console.error("Failed to reload external sketch:", error)
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
      }),
    [autosave, generation, recoveryScope],
  )

  React.useEffect(() => setOpenSketches({}), [generation, setOpenSketches])

  return {
    autosave,
    autosaveKey,
    handleSketchSave,
    loadSketchBuffer,
    openSketches,
    reloadExternalSketch,
    setOpenSketches,
  }
}
