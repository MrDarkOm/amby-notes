import {
  createProfileSnapshot,
  PROFILES,
  STANDARD_CATALOG_REVISION,
  STANDARD_MODULES,
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
