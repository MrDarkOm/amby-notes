import type { StoragePort } from "./port"
import type { ImportedAsset, PageInfo } from "./types"

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

  async openAttachment(notePath: string, attachmentPath: string): Promise<void> {
    return this.port().openAttachment(notePath, attachmentPath)
  }

  async saveAttachmentCopy(notePath: string, attachmentPath: string): Promise<string | null> {
    return this.port().saveAttachmentCopy(notePath, attachmentPath)
  }

  async openWebAddress(address: string): Promise<void> {
    return this.port().openWebAddress(address)
  }

  async fetchPageInfo(address: string): Promise<PageInfo> {
    return this.port().fetchPageInfo(address)
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
