import { getCurrentAppVersion } from "@/lib/app-updater"
import { isTauri } from "@/lib/storage"
import { commands, type ModuleManifest as BindingModuleManifest } from "@/lib/bindings"
import { loadGlobalModulesRegistry, saveGlobalModulesRegistry } from "../global-registry"
import { toCanonicalModuleId, type InstalledModule } from "../types"
import { getCatalogModule } from "./catalog"
import type {
  InstallErrorCode,
  InstallResult,
  ModuleUsageInfo,
  PackageManifest,
  StagedPackage,
} from "./types"
import {
  validateApiCompatibility,
  validateChecksums,
  validateDependencies,
  validateManifest,
  validatePathConfinement,
  validateSignature,
} from "./validator"

// Persistent registry of version history for rollback support
export function loadVersionHistory(): Record<string, string[]> {
  try {
    const raw =
      typeof localStorage !== "undefined"
        ? localStorage.getItem("amby:module-version-history")
        : null
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function saveVersionHistory(history: Record<string, string[]>): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("amby:module-version-history", JSON.stringify(history))
    }
  } catch {
    // Ignore storage errors in restricted envs
  }
}

/**
 * Stages a package for atomic publishing after strict pre-flight validation.
 */
export async function stagePackage(
  manifest: unknown,
  files: Record<string, string>,
): Promise<{
  staged: StagedPackage | null
  error?: string
  errorCode?: InstallErrorCode
}> {
  // 1. Validate manifest structure
  const manifestValidation = validateManifest(manifest)
  if (!manifestValidation.valid || !manifestValidation.manifest) {
    return {
      staged: null,
      error: manifestValidation.error ?? "Invalid manifest",
      errorCode: "STAGING_FAILED",
    }
  }

  const validManifest = manifestValidation.manifest

  // 2. Validate path confinement (reject .., absolute paths, symlink tricks)
  const pathValidation = validatePathConfinement(Object.keys(files))
  if (!pathValidation.safe) {
    return {
      staged: null,
      error: `Path traversal or invalid path detected: ${pathValidation.offendingPath}`,
      errorCode: "PATH_TRAVERSAL",
    }
  }

  // 3. Validate file checksums
  const checksumValidation = await validateChecksums(files, validManifest.checksums)
  if (!checksumValidation.valid) {
    return {
      staged: null,
      error: `Checksum mismatch for file: ${checksumValidation.mismatchedFile}`,
      errorCode: "CHECKSUM_MISMATCH",
    }
  }

  // 4. Validate signature with real Ed25519
  const isSigValid = await validateSignature(validManifest)
  if (!isSigValid) {
    return {
      staged: null,
      error: "Invalid or untrusted package signature",
      errorCode: "INVALID_SIGNATURE",
    }
  }

  const stagingId = `staging-${validManifest.id}-${Date.now()}`

  // 5. If running in Tauri desktop, stage on disk via Rust backend
  if (isTauri()) {
    const res = await commands.stageModulePackage(
      stagingId,
      validManifest as unknown as BindingModuleManifest,
      files,
    )
    if (res.status === "error") {
      return {
        staged: null,
        error: res.error,
        errorCode: "STAGING_FAILED",
      }
    }
  }

  return {
    staged: {
      stagingId,
      manifest: validManifest,
      stagedFiles: files,
      stagedAt: Date.now(),
    },
  }
}

/**
 * Atomically publishes a verified staged package into the global registry.
 */
export async function publishStagedPackage(
  staged: StagedPackage,
  currentAppVersion?: string,
): Promise<InstallResult> {
  const manifest = staged.manifest
  const canonicalId = toCanonicalModuleId(manifest.id)
  const appVer = currentAppVersion ?? (await getCurrentAppVersion())

  // 1. API compatibility check
  const compat = validateApiCompatibility(manifest, appVer)
  if (!compat.compatible) {
    return {
      success: false,
      moduleId: canonicalId,
      error: compat.reason,
      errorCode: "INCOMPATIBLE_VERSION",
    }
  }

  // 2. Load global registry to check dependencies and current installed state
  const registry = await loadGlobalModulesRegistry()
  const depCheck = validateDependencies(manifest, registry.installed)
  if (!depCheck.satisfied) {
    return {
      success: false,
      moduleId: canonicalId,
      error: `Missing or incompatible dependencies: ${depCheck.missing.join(", ")}`,
      errorCode: "UNSATISFIED_DEPENDENCIES",
    }
  }

  const existing = registry.installed[canonicalId]
  const previousVersion = existing?.activeVersion

  let installPath: string | undefined
  if (isTauri()) {
    const res = await commands.publishStagedModule(staged.stagingId, canonicalId, manifest.version)
    if (res.status === "error") {
      return {
        success: false,
        moduleId: canonicalId,
        error: res.error,
        errorCode: "PUBLISH_FAILED",
      }
    }
    installPath = res.data.installPath
  }

  // Persistent version history for rollback
  const historyMap = loadVersionHistory()
  if (!historyMap[canonicalId]) {
    historyMap[canonicalId] = []
  }
  if (previousVersion && !historyMap[canonicalId].includes(previousVersion)) {
    historyMap[canonicalId].push(previousVersion)
  }
  saveVersionHistory(historyMap)

  const newInstalled: InstalledModule = {
    id: canonicalId,
    version: manifest.version,
    activeVersion: manifest.version,
    signatureStatus: manifest.kind === "official" ? "signed" : "unsigned",
    source: manifest.kind === "official" ? "catalog" : "sideload",
    installedAt: Date.now(),
    lastUsedAt: Date.now(),
  }

  // Atomic update: stage changes in memory then commit
  registry.installed[canonicalId] = newInstalled
  if (registry.uninstalled) {
    registry.uninstalled = registry.uninstalled.filter((id) => id !== canonicalId)
  }
  await saveGlobalModulesRegistry(registry)

  try {
    const { moduleHost } = await import("../host/module-host")
    if (moduleHost.isModuleActive(canonicalId)) {
      const currentVault = moduleHost.getCurrentVault()
      await moduleHost.disposeModule(canonicalId)
      await moduleHost.activateModule(canonicalId, currentVault)
    } else {
      await moduleHost.loadInstalledModule(canonicalId)
    }
  } catch (err) {
    console.error(`Failed to refresh moduleHost for ${canonicalId}:`, err)
  }

  return {
    success: true,
    moduleId: canonicalId,
    installedVersion: manifest.version,
    previousVersion,
    installPath,
  }
}

/**
 * High-level install workflow: stages, verifies, and publishes a package.
 */
export async function installPackage(
  manifest: unknown,
  files: Record<string, string>,
  currentAppVersion?: string,
): Promise<InstallResult> {
  const stageResult = await stagePackage(manifest, files)
  if (!stageResult.staged) {
    return {
      success: false,
      moduleId:
        manifest && typeof manifest === "object" && "id" in manifest
          ? String((manifest as { id: unknown }).id)
          : "unknown",
      error: stageResult.error,
      errorCode: stageResult.errorCode,
    }
  }

  return publishStagedPackage(stageResult.staged, currentAppVersion)
}

/**
 * Rollback a module to its previously installed version.
 */
export async function rollbackModule(moduleId: string): Promise<InstallResult> {
  const canonicalId = toCanonicalModuleId(moduleId)
  const registry = await loadGlobalModulesRegistry()
  const installed = registry.installed[canonicalId]

  if (!installed) {
    return {
      success: false,
      moduleId: canonicalId,
      error: `Module ${canonicalId} is not installed`,
      errorCode: "CATALOG_ERROR",
    }
  }

  if (isTauri()) {
    const res = await commands.rollbackModule(canonicalId)
    if (res.status === "error") {
      return {
        success: false,
        moduleId: canonicalId,
        error: res.error,
        errorCode: "CATALOG_ERROR",
      }
    }
    installed.activeVersion = res.data.rolledBackToVersion
    installed.version = res.data.rolledBackToVersion
    await saveGlobalModulesRegistry(registry)

    try {
      const { moduleHost } = await import("../host/module-host")
      if (moduleHost.isModuleActive(canonicalId)) {
        const currentVault = moduleHost.getCurrentVault()
        await moduleHost.disposeModule(canonicalId)
        await moduleHost.activateModule(canonicalId, currentVault)
      } else {
        await moduleHost.disposeModule(canonicalId)
        await moduleHost.loadInstalledModule(canonicalId)
      }
    } catch (err) {
      console.error(`Failed to reload moduleHost after rollback of ${canonicalId}:`, err)
    }

    return {
      success: true,
      moduleId: canonicalId,
      installedVersion: res.data.rolledBackToVersion,
      previousVersion: res.data.previousVersion,
      installPath: res.data.activeInstallPath,
    }
  }

  const historyMap = loadVersionHistory()
  const history = historyMap[canonicalId] ?? []
  if (history.length === 0) {
    return {
      success: false,
      moduleId: canonicalId,
      error: `No previous version available for rollback of ${canonicalId}`,
      errorCode: "CATALOG_ERROR",
    }
  }

  const previousVersion = history.pop()!
  historyMap[canonicalId] = history
  saveVersionHistory(historyMap)

  const currentVersion = installed.activeVersion

  installed.activeVersion = previousVersion
  installed.version = previousVersion
  await saveGlobalModulesRegistry(registry)

  try {
    const { moduleHost } = await import("../host/module-host")
    if (moduleHost.isModuleActive(canonicalId)) {
      const currentVault = moduleHost.getCurrentVault()
      await moduleHost.disposeModule(canonicalId)
      await moduleHost.activateModule(canonicalId, currentVault)
    } else {
      await moduleHost.disposeModule(canonicalId)
      await moduleHost.loadInstalledModule(canonicalId)
    }
  } catch (err) {
    console.error(`Failed to reload moduleHost after rollback of ${canonicalId}:`, err)
  }

  return {
    success: true,
    moduleId: canonicalId,
    installedVersion: previousVersion,
    previousVersion: currentVersion,
  }
}

/**
 * Uninstalls a module from the global registry.
 * GUARANTEE: Preserves user documents and .amby/modules/<id>/ data.
 */
export async function uninstallModule(
  moduleId: string,
): Promise<{ success: boolean; error?: string }> {
  const canonicalId = toCanonicalModuleId(moduleId)
  const registry = await loadGlobalModulesRegistry()

  if (!registry.installed[canonicalId]) {
    return { success: false, error: `Module ${canonicalId} is not installed` }
  }

  if (isTauri()) {
    const res = await commands.uninstallModulePackage(canonicalId)
    if (res.status === "error") {
      return { success: false, error: res.error }
    }
  }

  try {
    const { moduleHost } = await import("../host/module-host")
    await moduleHost.disposeModule(canonicalId)
  } catch (err) {
    console.error(`Failed to dispose moduleHost after uninstall of ${canonicalId}:`, err)
  }

  // Remove from global installation registry and record in uninstalled
  delete registry.installed[canonicalId]
  const uninstalledSet = new Set(registry.uninstalled ?? [])
  uninstalledSet.add(canonicalId)
  registry.uninstalled = Array.from(uninstalledSet)
  await saveGlobalModulesRegistry(registry)

  return { success: true }
}

/**
 * Inspects installed size and workspace usage for a module.
 */
export async function getModuleUsage(
  moduleId: string,
  knownWorkspaces: { path: string; enabledModules: string[] }[] = [],
): Promise<ModuleUsageInfo> {
  const canonicalId = toCanonicalModuleId(moduleId)
  const registry = await loadGlobalModulesRegistry()
  const installed = registry.installed[canonicalId]

  let installedSize = 0
  let installedVersions: string[] = []

  if (isTauri()) {
    const listRes = await commands.listInstalledModulePackages()
    if (listRes.status === "ok") {
      const match = listRes.data.find((m) => m.moduleId === canonicalId)
      if (match) {
        installedSize = match.sizeBytes
        installedVersions = match.installedVersions
      }
    }
  }

  const activeVersion = installed?.activeVersion ?? "none"

  if (installedVersions.length === 0) {
    const historyMap = loadVersionHistory()
    const history = historyMap[canonicalId] ?? []
    installedVersions = installed ? [installed.activeVersion, ...history] : []
  }

  if (installedSize === 0 && activeVersion !== "none") {
    const catalogEntry = await getCatalogModule(canonicalId)
    const versionEntry = catalogEntry?.versions[activeVersion]
    installedSize = versionEntry?.installedSize ?? 0
  }

  const enabledInWorkspaces = knownWorkspaces
    .filter((ws) => ws.enabledModules.some((id) => toCanonicalModuleId(id) === canonicalId))
    .map((ws) => ws.path)

  return {
    moduleId: canonicalId,
    installedSize,
    activeVersion,
    installedVersions,
    enabledInWorkspaces,
  }
}

/**
 * Downloads, verifies, and installs a package from a remote URL.
 */
export async function installFromRemoteUrl(
  url: string,
  currentAppVersion?: string,
): Promise<InstallResult> {
  if (!isTauri()) {
    try {
      const resp = await fetch(url)
      if (!resp.ok) {
        return {
          success: false,
          moduleId: "unknown",
          error: `HTTP error ${resp.status}`,
          errorCode: "STAGING_FAILED",
        }
      }
      const parsed = (await resp.json()) as { manifest: unknown; files: Record<string, string> }
      return installPackage(parsed.manifest, parsed.files, currentAppVersion)
    } catch (err) {
      return {
        success: false,
        moduleId: "unknown",
        error: String(err),
        errorCode: "STAGING_FAILED",
      }
    }
  }

  const res = await commands.downloadAndStageModulePackage(url)
  if (res.status === "error") {
    return {
      success: false,
      moduleId: "unknown",
      error: res.error,
      errorCode: "STAGING_FAILED",
    }
  }

  const staged: StagedPackage = {
    stagingId: res.data.stagingId,
    manifest: res.data.manifest as unknown as PackageManifest,
    stagedFiles: {},
    stagedAt: Date.now(),
  }

  return publishStagedPackage(staged, currentAppVersion)
}
