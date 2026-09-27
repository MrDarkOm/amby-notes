import { logger } from "../logger"
import type { StoragePort } from "./port"
import type { FsMutationResult, LayerKind, LayerResult, NoteLayers } from "./types"

export class MutationsRepository {
  constructor(private readonly port: () => StoragePort) {}

  async createFolder(vaultPath: string, name: string): Promise<string> {
    logger.info("storage.create_folder", { vaultPath, name })
    return this.port().createFolder(vaultPath, name)
  }

  async createCanvasFile(
    vaultPath: string,
    parentPath: string | null,
    name: string,
  ): Promise<string> {
    logger.info("storage.create_canvas", { vaultPath, parentPath: parentPath ?? undefined, name })
    return this.port().createCanvasFile(vaultPath, parentPath, name)
  }

  async attachCanvasToNote(vaultPath: string, canvasPath: string): Promise<FsMutationResult> {
    logger.info("storage.attach_canvas", { vaultPath, canvasPath })
    return this.port().attachCanvasToNote(vaultPath, canvasPath)
  }

  async createSketchFile(
    vaultPath: string,
    parentPath: string | null,
    name: string,
  ): Promise<string> {
    logger.info("storage.create_sketch", { vaultPath, parentPath: parentPath ?? undefined, name })
    return this.port().createSketchFile(vaultPath, parentPath, name)
  }

  async attachSketchToNote(vaultPath: string, sketchPath: string): Promise<FsMutationResult> {
    logger.info("storage.attach_sketch", { vaultPath, sketchPath })
    return this.port().attachSketchToNote(vaultPath, sketchPath)
  }

  async renameItem(vaultPath: string, path: string, newName: string): Promise<FsMutationResult> {
    logger.info("storage.rename_item", { vaultPath, path, newName })
    return this.port().renameItem(vaultPath, path, newName)
  }

  async moveItem(
    vaultPath: string,
    sourcePath: string,
    targetPath: string,
  ): Promise<FsMutationResult> {
    logger.info("storage.move_item", { vaultPath, sourcePath, targetPath })
    return this.port().moveItem(vaultPath, sourcePath, targetPath)
  }

  async deleteItem(vaultPath: string, path: string): Promise<FsMutationResult> {
    logger.info("storage.delete_item", { vaultPath, path })
    return this.port().deleteItem(vaultPath, path)
  }

  async archiveItem(vaultPath: string, path: string): Promise<FsMutationResult> {
    logger.info("storage.archive_item", { vaultPath, path })
    return this.port().archiveItem(vaultPath, path)
  }

  async noteLayers(notePath: string): Promise<NoteLayers> {
    return this.port().noteLayers(notePath)
  }

  async createLayer(notePath: string, kind: LayerKind): Promise<LayerResult> {
    return this.port().createLayer(notePath, kind)
  }

  async unlinkLayer(
    vaultPath: string,
    notePath: string,
    kind: LayerKind,
  ): Promise<FsMutationResult> {
    return this.port().unlinkLayer(vaultPath, notePath, kind)
  }

  async deleteLayer(
    vaultPath: string,
    notePath: string,
    kind: LayerKind,
  ): Promise<FsMutationResult> {
    return this.port().deleteLayer(vaultPath, notePath, kind)
  }
}
