import type { TFunction } from "i18next"
import { validateAndSerializeSketch, defaultSketchJson } from "@/lib/sketch-format"
import type { RecoveryScope } from "@/lib/recovery-drafts"
import { useLayerWorkspace, type LayerWorkspaceConfig } from "./use-layer-workspace"

const SKETCH_CONFIG: LayerWorkspaceConfig = {
  kind: "sketch",
  validate: validateAndSerializeSketch,
  emptyJson: defaultSketchJson,
  migrateLegacyDrafts: false,
}

/** Owns Excalidraw sketch buffers and their recovery/autosave lifecycle. */
export function useSketchWorkspace(
  generation: number,
  _t: TFunction,
  recoveryScope: RecoveryScope,
) {
  const layer = useLayerWorkspace(SKETCH_CONFIG, generation, recoveryScope)
  return {
    autosave: layer.autosave,
    autosaveKey: layer.autosaveKey,
    discardDeleted: layer.discardDeleted,
    fileRevisions: layer.fileRevisions,
    handleSketchSave: layer.handleSave,
    loadSketchBuffer: layer.loadBuffer,
    openSketches: layer.openBuffers,
    reloadExternalSketch: layer.reloadExternal,
    setOpenSketches: layer.setOpenBuffers,
  }
}
