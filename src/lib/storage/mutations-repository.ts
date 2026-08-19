import type { StoragePort } from "./port"
import type { FsMutationResult, LayerKind, LayerResult, NoteLayers } from "./types"

export class MutationsRepository {
  constructor(private readonly port: () => StoragePort) {}

  async createFolder(vaultPath: string, name: string): Promise<string> {
    return this.port().createFolder(vaultPath, name)
  }

  async createCanvasFile(
    vaultPath: string,
    parentPath: string | null,
    name: string,
  ): Promise<string> {
    return this.port().createCanvasFile(vaultPath, parentPath, name)
  }

  async attachCanvasToNote(vaultPath: string, canvasPath: string): Promise<FsMutationResult> {
    return this.port().attachCanvasToNote(vaultPath, canvasPath)
  }

  async renameItem(vaultPath: string, path: string, newName: string): Promise<FsMutationResult> {
    return this.port().renameItem(vaultPath, path, newName)
  }

  async moveItem(
    vaultPath: string,
    sourcePath: string,
    targetPath: string,
  ): Promise<FsMutationResult> {
    return this.port().moveItem(vaultPath, sourcePath, targetPath)
  }

  async deleteItem(vaultPath: string, path: string): Promise<FsMutationResult> {
    return this.port().deleteItem(vaultPath, path)
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
