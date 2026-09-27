import type { RevocationEntry } from "./types"

export class RevocationRegistry {
  private entries = new Map<string, RevocationEntry[]>()

  registerRevocation(entry: RevocationEntry): void {
    const list = this.entries.get(entry.moduleId) ?? []
    list.push(entry)
    this.entries.set(entry.moduleId, list)
  }

  isRevoked(moduleId: string, version: string): boolean {
    const list = this.entries.get(moduleId)
    if (!list || list.length === 0) return false

    for (const entry of list) {
      if (entry.versionPattern === "*" || entry.versionPattern === version) {
        return true
      }
    }
    return false
  }

  getRevocationReason(moduleId: string, version: string): string | undefined {
    const list = this.entries.get(moduleId)
    if (!list) return undefined

    for (const entry of list) {
      if (entry.versionPattern === "*" || entry.versionPattern === version) {
        return entry.reason
      }
    }
    return undefined
  }

  clear(): void {
    this.entries.clear()
  }
}

export const revocationRegistry = new RevocationRegistry()
