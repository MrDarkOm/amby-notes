import type { TFunction } from "i18next"
import { serializeCanvas, validateAndSerializeCanvas } from "@/lib/canvas-format"
import type { RecoveryScope } from "@/lib/recovery-drafts"
import { useLayerWorkspace, type LayerWorkspaceConfig } from "./use-layer-workspace"

const CANVAS_CONFIG: LayerWorkspaceConfig = {
  kind: "canvas",
  validate: validateAndSerializeCanvas,
  emptyJson: () => serializeCanvas({ nodes: [], edges: [] }),
  // The vault-wide legacy recovery drafts are moved once, by the canvas hook.
  migrateLegacyDrafts: true,
}

/** Owns Obsidian .canvas buffers and their recovery/autosave lifecycle. */
export function useCanvasWorkspace(
  generation: number,
  _t: TFunction,
  recoveryScope: RecoveryScope,
) {
  const layer = useLayerWorkspace(CANVAS_CONFIG, generation, recoveryScope)
  return {
    autosave: layer.autosave,
    autosaveKey: layer.autosaveKey,
    discardDeleted: layer.discardDeleted,
    fileRevisions: layer.fileRevisions,
    handleCanvasSave: layer.handleSave,
    loadCanvasBuffer: layer.loadBuffer,
    openCanvases: layer.openBuffers,
    reloadExternalCanvas: layer.reloadExternal,
    setOpenCanvases: layer.setOpenBuffers,
  }
}
