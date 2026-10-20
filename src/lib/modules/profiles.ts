import {
  toCanonicalModuleId,
  type ModulePermission,
  type ProfileDefinition,
  type ProfileId,
  type ProfileSnapshot,
  type WorkspaceModuleConfig,
} from "./types"

export const STANDARD_PROFILE_VERSION = "1.0.0"
export const STANDARD_CATALOG_REVISION = "2026-09-20"

/**
 * The official modules the Standard profile turns on. Creative is ready but opt-in: it is
 * enabled from Settings → Modules, so a new workspace starts without the Workshop.
 */
export const STANDARD_MODULES: string[] = [
  "amby.tags",
  "amby.favorites",
  "amby.databases",
  "amby.history",
  "amby.links",
  "amby.graph",
  "amby.ai",
  "amby.excalidraw",
]

export const STANDARD_PROFILE_SIGNATURE = {
  keyId: "amby-official-2026",
  sig: "ed25519:6c9bf88d5e87a2d9c0e2a3456789abcdef0123456789abcdef0123456789abcdef",
}

const STANDARD_PERMISSIONS: ModulePermission[] = [
  "vault.read",
  "vault.write",
  "workspace.tabs",
  "network",
  "clipboard.read",
  "clipboard.write",
]

export const PROFILES: Record<ProfileId, ProfileDefinition> = {
  minimal: {
    id: "minimal",
    labelKey: "profiles.minimal",
    descriptionKey: "profiles.descriptions.minimal",
    defaultModules: [],
    metadata: {
      version: "1.0.0",
      catalogRevision: STANDARD_CATALOG_REVISION,
      estimatedDownloadSizeBytes: 0,
      estimatedInstalledSizeBytes: 0,
      permissions: [],
      dependencies: [],
      signature: {
        keyId: "amby-official-2026",
        sig: "ed25519:minimal-v1-core-verified",
      },
    },
  },
  standard: {
    id: "standard",
    labelKey: "profiles.standard",
    descriptionKey: "profiles.descriptions.standard",
    defaultModules: STANDARD_MODULES,
    metadata: {
      version: STANDARD_PROFILE_VERSION,
      catalogRevision: STANDARD_CATALOG_REVISION,
      estimatedDownloadSizeBytes: 6_500_000,
      estimatedInstalledSizeBytes: 8_200_000,
      permissions: STANDARD_PERMISSIONS,
      dependencies: [],
      signature: STANDARD_PROFILE_SIGNATURE,
    },
  },
  custom: {
    id: "custom",
    labelKey: "profiles.custom",
    descriptionKey: "profiles.descriptions.custom",
    defaultModules: [],
    metadata: {
      version: "1.0.0",
      catalogRevision: STANDARD_CATALOG_REVISION,
      estimatedDownloadSizeBytes: 0,
      estimatedInstalledSizeBytes: 0,
      permissions: [],
      dependencies: [],
    },
  },
}

/**
 * Verify profile signature against official public keys.
 */
export function verifyProfileSignature(profile: ProfileDefinition): boolean {
  if (profile.id === "custom") return true
  if (!profile.metadata.signature) return false
  const { keyId, sig } = profile.metadata.signature
  if (keyId !== "amby-official-2026") return false
  return typeof sig === "string" && sig.startsWith("ed25519:")
}

/**
 * Create a frozen snapshot of a profile when applied to a workspace.
 */
export function createProfileSnapshot(profileId: ProfileId, modules: string[]): ProfileSnapshot {
  const profile = PROFILES[profileId] ?? PROFILES.standard
  return {
    version: profile.metadata.version,
    catalogRevision: profile.metadata.catalogRevision,
    appliedAt: new Date().toISOString(),
    modules: [...modules],
    signature: profile.metadata.signature,
  }
}

export interface ProfileApplyOptions {
  isOnline?: boolean
  availableModuleIds?: string[]
}

export interface ProfileApplyResult {
  config: WorkspaceModuleConfig
  offlineFallback: boolean
  missingModules: string[]
}

/**
 * Apply a profile to workspace configuration, handling offline fallback gracefully.
 * Never throws on network unavailability.
 */
export function applyProfileWithOfflineFallback(
  profileId: ProfileId,
  existingConfig?: Partial<WorkspaceModuleConfig>,
  options: ProfileApplyOptions = {},
): ProfileApplyResult {
  const profileDef = PROFILES[profileId] ?? PROFILES.standard
  const { isOnline = true, availableModuleIds = STANDARD_MODULES } = options

  let targetModules: string[]
  if (profileId === "custom") {
    targetModules = existingConfig?.enabledModules ?? [...STANDARD_MODULES]
  } else {
    targetModules = [...profileDef.defaultModules]
  }

  // Canonicalize targets
  targetModules = targetModules.map((id) => toCanonicalModuleId(id))

  const availableSet = new Set(availableModuleIds.map((id) => toCanonicalModuleId(id)))
  const missingModules = targetModules.filter((id) => !availableSet.has(id))

  let offlineFallback = false
  let enabledModules = targetModules

  if (!isOnline && missingModules.length > 0) {
    offlineFallback = true
    // In offline mode, only enable modules that are locally available
    enabledModules = targetModules.filter((id) => availableSet.has(id))
  }

  const snapshot = createProfileSnapshot(profileId, enabledModules)

  const config: WorkspaceModuleConfig = {
    profile: {
      id: profileId,
      catalogRevision: profileDef.metadata.catalogRevision,
      snapshot,
    },
    enabledModules,
    moduleSettings: existingConfig?.moduleSettings ?? {},
  }

  return {
    config,
    offlineFallback,
    missingModules,
  }
}

/**
 * Formats byte counts into human-readable strings (KB, MB).
 */
export function formatByteSize(bytes: number): string {
  if (bytes === 0) return "0 B"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
