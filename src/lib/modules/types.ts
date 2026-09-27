/**
 * Core types for Amby's Modular Architecture (0.1.5+).
 * See docs/Road/modular-architecture-0.1.5-plan.md for architectural specifications.
 */

export type ModuleKind = "official" | "community"
export type ModuleStatus = "ready" | "beta" | "preview"

export type ModulePermission =
  | "vault.read"
  | "vault.write"
  | "vault.watch"
  | "workspace.tabs"
  | "workspace.commands"
  | "network"
  | "clipboard.read"
  | "clipboard.write"
  | "external.open"
  | "secrets.use"
  | "background.run"
  | "ui-panel"
  | "ui-action"
  | "read-notes"
  | "write-notes"
  | "read-vault-meta"
  | "read-databases"
  | "write-databases"

export interface ModuleManifest {
  formatVersion: number
  id: string
  name: string
  version: string
  publisher: string
  kind: ModuleKind
  minAppVersion: string
  entry?: string
  style?: string
  permissions: ModulePermission[]
  dependencies?: Record<string, string>
  contributions?: {
    fileHandlers?: string[]
    commands?: string[]
    panels?: string[]
    settings?: boolean
    translations?: string[]
  }
  data?: {
    namespace: string
    uninstallPolicy: "preserve" | "purge"
  }
}

export type SignatureStatus = "signed" | "unsigned" | "invalid"

export interface InstalledModule {
  id: string
  version: string
  activeVersion: string
  signatureStatus: SignatureStatus
  source: "builtin" | "catalog" | "sideload"
  installedAt: number
  lastUsedAt?: number
}

export const MODULES_REGISTRY_FILE = "modules.json"
export const MODULES_REGISTRY_VERSION = 1

export interface GlobalModulesRegistry {
  schemaVersion: number
  installed: Record<string, InstalledModule>
  uninstalled?: string[]
}

export type ProfileId = "minimal" | "standard" | "custom"

export interface ProfileSnapshot {
  version: string
  catalogRevision: string
  appliedAt: string
  modules: string[]
  signature?: {
    keyId: string
    sig: string
  }
}

export interface ProfileMetadata {
  version: string
  catalogRevision: string
  estimatedDownloadSizeBytes: number
  estimatedInstalledSizeBytes: number
  permissions: ModulePermission[]
  dependencies: string[]
  signature?: {
    keyId: string
    sig: string
  }
}

export interface ProfileDefinition {
  id: ProfileId
  labelKey: string
  descriptionKey: string
  defaultModules: string[]
  metadata: ProfileMetadata
}

export interface WorkspaceProfileState {
  id: ProfileId
  catalogRevision?: string
  snapshot?: ProfileSnapshot
}

export interface WorkspaceModuleConfig {
  profile: WorkspaceProfileState
  enabledModules: string[]
  moduleSettings: Record<string, unknown>
}

/** Mapping between short IDs and canonical official IDs. */
export const MODULE_ID_MAP: Record<string, string> = {
  tags: "amby.tags",
  favorites: "amby.favorites",
  databases: "amby.databases",
  history: "amby.history",
  links: "amby.links",
  graph: "amby.graph",
  sync: "amby.sync",
  ai: "amby.ai",
  excalidraw: "amby.excalidraw",
  canvas: "amby.canvas",
}

export const REVERSE_MODULE_ID_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(MODULE_ID_MAP).map(([shortId, fullId]) => [fullId, shortId]),
)

export function toCanonicalModuleId(id: string): string {
  return MODULE_ID_MAP[id] ?? id
}

export function toShortModuleId(id: string): string {
  return REVERSE_MODULE_ID_MAP[id] ?? id
}
