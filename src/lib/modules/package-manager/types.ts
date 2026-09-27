import type { ModuleKind, ModulePermission } from "../types"

export const PACKAGE_FORMAT_VERSION = 1

export interface PackageManifest {
  formatVersion: number
  id: string
  name: string
  version: string
  publisher: string
  kind: ModuleKind
  minAppVersion: string
  maxAppVersion?: string
  entry: string
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
  checksums: Record<string, string>
  signature: {
    keyId: string
    sig: string
  }
}

export interface CatalogModuleVersion {
  version: string
  downloadUrl: string
  downloadSize: number
  installedSize: number
  checksum: string
  minAppVersion: string
  maxAppVersion?: string
}

export interface CatalogModuleEntry {
  id: string
  name: string
  descriptionKey?: string
  publisher: string
  kind: ModuleKind
  latestVersion: string
  versions: Record<string, CatalogModuleVersion>
  manifest: PackageManifest
}

export interface ModuleCatalog {
  catalogRevision: string
  lastUpdated: string
  modules: Record<string, CatalogModuleEntry>
}

export interface StagedPackage {
  stagingId: string
  manifest: PackageManifest
  stagedFiles: Record<string, string>
  stagedAt: number
}

export type InstallErrorCode =
  | "CATALOG_ERROR"
  | "INCOMPATIBLE_VERSION"
  | "UNSATISFIED_DEPENDENCIES"
  | "PATH_TRAVERSAL"
  | "CHECKSUM_MISMATCH"
  | "INVALID_SIGNATURE"
  | "STAGING_FAILED"
  | "PUBLISH_FAILED"

export interface InstallResult {
  success: boolean
  moduleId: string
  installedVersion?: string
  previousVersion?: string
  installPath?: string
  error?: string
  errorCode?: InstallErrorCode
}

export interface ModuleUsageInfo {
  moduleId: string
  installedSize: number
  activeVersion: string
  installedVersions: string[]
  enabledInWorkspaces: string[]
}
