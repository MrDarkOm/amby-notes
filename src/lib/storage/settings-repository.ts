import type { StoragePort } from "./port"
import type { CredentialInfo, SettingsReadResult } from "./types"

export class SettingsRepository {
  constructor(private readonly port: () => StoragePort) {}

  async readGlobalRaw(file: string): Promise<string | null> {
    return this.port().readGlobalRaw(file)
  }

  async writeGlobalRaw(file: string, contents: string): Promise<void> {
    return this.port().writeGlobalRaw(file, contents)
  }

  async readVaultRaw(rel: string): Promise<string | null> {
    return this.port().readVaultRaw(rel)
  }

  async writeVaultRaw(rel: string, contents: string): Promise<void> {
    return this.port().writeVaultRaw(rel, contents)
  }

  async deleteVaultMeta(rel: string): Promise<void> {
    return this.port().deleteVaultMeta(rel)
  }

  async readGlobalSettingsResult<T>(file: string): Promise<SettingsReadResult<T>> {
    let raw: string | null
    try {
      raw = await this.readGlobalRaw(file)
    } catch (err) {
      return { status: "unavailable", error: String(err) }
    }
    if (raw === null) return { status: "missing" }
    try {
      const data = JSON.parse(raw) as T
      return { status: "found", data }
    } catch (err) {
      return { status: "corrupt", raw, error: String(err) }
    }
  }

  async readVaultSettingsResult<T>(rel: string): Promise<SettingsReadResult<T>> {
    let raw: string | null
    try {
      raw = await this.readVaultRaw(rel)
    } catch (err) {
      return { status: "unavailable", error: String(err) }
    }
    if (raw === null) return { status: "missing" }
    try {
      const data = JSON.parse(raw) as T
      return { status: "found", data }
    } catch (err) {
      return { status: "corrupt", raw, error: String(err) }
    }
  }

  async backupCorruptSettings(file: string, raw: string, scope: "global" | "vault"): Promise<void> {
    const timestamp = Date.now()
    const backupName = `${file}.corrupt-${timestamp}.json`
    try {
      if (scope === "global") {
        await this.writeGlobalRaw(backupName, raw)
      } else {
        await this.writeVaultRaw(backupName, raw)
      }
    } catch {
      // Best-effort backup
    }
  }

  async loadGlobalJSON<T>(file: string, fallback: T): Promise<T> {
    const res = await this.readGlobalSettingsResult<T>(file)
    if (res.status === "found") return res.data
    if (res.status === "missing") return fallback
    if (res.status === "corrupt") {
      await this.backupCorruptSettings(file, res.raw, "global")
      return fallback
    }
    throw new Error(`Failed to load global settings file ${file}: ${res.error}`)
  }

  async saveGlobalJSON(file: string, data: unknown): Promise<void> {
    await this.writeGlobalRaw(file, JSON.stringify(data, null, 2))
  }

  async loadVaultJSON<T>(rel: string, fallback: T): Promise<T> {
    const res = await this.readVaultSettingsResult<T>(rel)
    if (res.status === "found") return res.data
    if (res.status === "missing") return fallback
    if (res.status === "corrupt") {
      await this.backupCorruptSettings(rel, res.raw, "vault")
      return fallback
    }
    throw new Error(`Failed to load vault settings file ${rel}: ${res.error}`)
  }

  async saveVaultJSON(rel: string, data: unknown): Promise<void> {
    await this.writeVaultRaw(rel, JSON.stringify(data, null, 2))
  }

  async globalFileMissing(file: string): Promise<boolean> {
    return (await this.readGlobalRaw(file)) === null
  }

  async vaultFileMissing(rel: string): Promise<boolean> {
    return (await this.readVaultRaw(rel)) === null
  }

  async storeAiCredential(credentialId: string, secret: string): Promise<void> {
    return this.port().storeAiCredential(credentialId, secret)
  }

  async deleteAiCredential(credentialId: string): Promise<void> {
    return this.port().deleteAiCredential(credentialId)
  }

  async inspectAiCredential(credentialId: string): Promise<CredentialInfo> {
    return this.port().inspectAiCredential(credentialId)
  }
}
