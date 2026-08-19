import type { StoragePort } from "./port"
import type { ImportedAsset } from "./types"

export class AssetsRepository {
  constructor(private readonly port: () => StoragePort) {}

  async pickAssetFile(imagesOnly: boolean): Promise<string | null> {
    return this.port().pickAssetFile(imagesOnly)
  }

  async importAsset(
    vaultPath: string,
    notePath: string,
    sourcePath: string,
  ): Promise<ImportedAsset | null> {
    return this.port().importAsset(vaultPath, notePath, sourcePath)
  }

  async importAssetBytes(
    vaultPath: string,
    notePath: string,
    bytes: Uint8Array,
    suggestedExt: string,
  ): Promise<ImportedAsset | null> {
    return this.port().importAssetBytes(vaultPath, notePath, bytes, suggestedExt)
  }

  async toAssetUrl(absPath: string): Promise<string> {
    return this.port().toAssetUrl(absPath)
  }

  async exportTextFile(contents: string, defaultName: string): Promise<string | null> {
    return this.port().exportTextFile(contents, defaultName)
  }

  async importTextFile(): Promise<string | null> {
    return this.port().importTextFile()
  }

  async openInExplorer(path: string): Promise<void> {
    return this.port().openInExplorer(path)
  }

  async confirmAction(message: string): Promise<boolean> {
    return this.port().confirmAction(message)
  }

  async showErrorMessage(message: string): Promise<void> {
    return this.port().showErrorMessage(message)
  }
}
