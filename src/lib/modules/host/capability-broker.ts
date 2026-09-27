import { readFile as storageReadFile, writeFile as storageWriteFile } from "@/lib/storage"
import type { ModuleManifest, ModulePermission } from "../types"
import { SecurityPermissionError, type ModuleHostContext } from "./sdk"

export function validateConfinedRelPath(relPath: string): string {
  const norm = relPath.replace(/\\/g, "/")
  if (
    !norm ||
    norm.startsWith("/") ||
    /^[a-zA-Z]:/.test(norm) ||
    norm.includes("../") ||
    norm === ".."
  ) {
    throw new Error(
      `Invalid vault-relative path: "${relPath}". Path traversal or absolute paths are rejected.`,
    )
  }
  return norm
}

export class CapabilityBroker {
  private readonly permissions: Set<ModulePermission>

  constructor(
    public readonly manifest: ModuleManifest,
    public readonly context: ModuleHostContext,
  ) {
    this.permissions = new Set(manifest.permissions)
  }

  hasPermission(permission: ModulePermission): boolean {
    return this.permissions.has(permission)
  }

  requirePermission(permission: ModulePermission): void {
    if (!this.hasPermission(permission)) {
      throw new SecurityPermissionError(permission, this.manifest.id)
    }
  }

  async readFile(relPath: string): Promise<string> {
    this.requirePermission("vault.read")
    if (!this.context.vault) {
      throw new Error(`Cannot read file "${relPath}": no workspace is currently open.`)
    }
    const cleanRel = validateConfinedRelPath(relPath)
    const fullPath = `${this.context.vault}/${cleanRel}`
    return storageReadFile(fullPath)
  }

  async writeFile(relPath: string, contents: string): Promise<void> {
    this.requirePermission("vault.write")
    if (!this.context.vault) {
      throw new Error(`Cannot write file "${relPath}": no workspace is currently open.`)
    }
    const cleanRel = validateConfinedRelPath(relPath)
    const fullPath = `${this.context.vault}/${cleanRel}`
    return storageWriteFile(fullPath, contents)
  }
}
