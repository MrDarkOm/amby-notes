import {
  createProfileSnapshot,
  NOTE_MODULES,
  NOTE_MODULES_REVISION,
  PROFILES,
  STANDARD_CATALOG_REVISION,
  STANDARD_MODULES,
  SUPERNOTES_REVISION,
} from "./profiles"
import { toCanonicalModuleId, type ProfileId, type WorkspaceModuleConfig } from "./types"

export { PROFILES, STANDARD_MODULES }

export const DEFAULT_WORKSPACE_MODULE_CONFIG: WorkspaceModuleConfig = {
  profile: {
    id: "standard",
    catalogRevision: STANDARD_CATALOG_REVISION,
    snapshot: createProfileSnapshot("standard", STANDARD_MODULES),
  },
  enabledModules: [...STANDARD_MODULES],
  moduleSettings: {},
}

export function isModuleEnabledInWorkspace(
  moduleId: string,
  config: WorkspaceModuleConfig,
): boolean {
  const canonicalId = toCanonicalModuleId(moduleId)
  return config.enabledModules.some((id) => toCanonicalModuleId(id) === canonicalId)
}

export function enableModuleInWorkspace(
  moduleId: string,
  config: WorkspaceModuleConfig,
): WorkspaceModuleConfig {
  const canonicalId = toCanonicalModuleId(moduleId)
  if (isModuleEnabledInWorkspace(canonicalId, config)) {
    return config
  }
  return {
    ...config,
    enabledModules: [...config.enabledModules, canonicalId],
  }
}

export function disableModuleInWorkspace(
  moduleId: string,
  config: WorkspaceModuleConfig,
): WorkspaceModuleConfig {
  const canonicalId = toCanonicalModuleId(moduleId)
  return {
    ...config,
    enabledModules: config.enabledModules.filter((id) => toCanonicalModuleId(id) !== canonicalId),
  }
}

export function applyProfileToWorkspace(
  profileId: ProfileId,
  existingConfig?: Partial<WorkspaceModuleConfig>,
): WorkspaceModuleConfig {
  const profileDef = PROFILES[profileId] ?? PROFILES.standard
  const enabledModules =
    profileId === "custom"
      ? (existingConfig?.enabledModules ?? [...STANDARD_MODULES])
      : [...profileDef.defaultModules]

  return {
    profile: {
      id: profileId,
      catalogRevision: profileDef.metadata.catalogRevision,
      snapshot: createProfileSnapshot(profileId, enabledModules),
    },
    enabledModules,
    moduleSettings: existingConfig?.moduleSettings ?? {},
  }
}

/**
 * Reads the module part of workspace.json. A file without a profile and a module list (the
 * format before profiles, no longer read) gets the standard profile; the file is not rewritten.
 */
export function readWorkspaceModuleConfig(raw: {
  profile?: unknown
  enabledModules?: unknown
  moduleSettings?: unknown
}): WorkspaceModuleConfig {
  const moduleSettings =
    raw.moduleSettings && typeof raw.moduleSettings === "object"
      ? (raw.moduleSettings as Record<string, unknown>)
      : {}
  const profile = raw.profile as { id?: unknown; catalogRevision?: unknown } | null | undefined
  if (profile && typeof profile.id === "string" && Array.isArray(raw.enabledModules)) {
    const profileId = profile.id as ProfileId
    const enabledModules = (raw.enabledModules as string[]).map(toCanonicalModuleId)
    const saved = typeof profile.catalogRevision === "string" ? profile.catalogRevision : null
    // Each built-in added to Standard is inherited once by older non-Minimal workspaces.
    const predates = (revision: string) =>
      profileId !== "minimal" && (saved === null || saved < revision)
    const addSupernotes = predates(SUPERNOTES_REVISION)
    if (predates(NOTE_MODULES_REVISION)) {
      for (const id of NOTE_MODULES) if (!enabledModules.includes(id)) enabledModules.push(id)
    }
    if (addSupernotes && !enabledModules.includes("amby.supernotes")) {
      enabledModules.push("amby.supernotes")
    }
    return {
      profile: {
        id: PROFILES[profileId] ? profileId : "custom",
        catalogRevision: addSupernotes ? SUPERNOTES_REVISION : (saved ?? STANDARD_CATALOG_REVISION),
      },
      enabledModules,
      moduleSettings,
    }
  }
  return applyProfileToWorkspace("standard", { moduleSettings })
}
