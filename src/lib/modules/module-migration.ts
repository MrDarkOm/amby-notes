import { loadVaultJSON, saveVaultJSON } from "@/lib/storage"
import { toCanonicalModuleId, type ProfileId, type WorkspaceModuleConfig } from "./types"
import { PROFILES, STANDARD_MODULES, applyProfileToWorkspace } from "./workspace-modules"

export const WORKSPACE_MODULES_MIGRATION_VERSION = 1
export const MIGRATION_JOURNAL_FILE = "migration-journal.json"

export interface MigrationJournalEntry {
  version: number
  timestamp: string
  status: "success" | "failed" | "rolled_back"
  backupPath: string
  error?: string
  details?: Record<string, unknown>
}

export interface MigrationResult {
  migrated: boolean
  backupPath?: string
  config: WorkspaceModuleConfig
}

/**
 * Appends a record to the migration outcome journal in .amby/migration-journal.json.
 */
export async function appendMigrationJournal(entry: MigrationJournalEntry): Promise<void> {
  try {
    const journal = await loadVaultJSON<MigrationJournalEntry[]>(MIGRATION_JOURNAL_FILE, [])
    const updated = Array.isArray(journal) ? [...journal, entry] : [entry]
    await saveVaultJSON(MIGRATION_JOURNAL_FILE, updated)
  } catch (err) {
    console.error("Failed to write migration journal:", err)
  }
}

/**
 * Reads the migration outcome journal.
 */
export async function getMigrationJournal(): Promise<MigrationJournalEntry[]> {
  try {
    const journal = await loadVaultJSON<MigrationJournalEntry[]>(MIGRATION_JOURNAL_FILE, [])
    return Array.isArray(journal) ? journal : []
  } catch {
    return []
  }
}

/**
 * Creates a timestamped backup of the workspace configuration in .amby/backups/
 * before any migration touches it. Throws if writing the backup fails.
 */
export async function backupWorkspaceConfig(rawConfig: unknown): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupRelPath = `backups/workspace-config-${timestamp}.json`
  await saveVaultJSON(backupRelPath, rawConfig)
  return backupRelPath
}

/**
 * Pure function: determines migrated WorkspaceModuleConfig from legacy fields.
 * Idempotent: if enabledModules and profile are already present, returns as-is.
 */
export function determineMigratedModuleConfig(raw: {
  profile?: unknown
  enabledModules?: unknown
  moduleSettings?: unknown
  layout?: {
    activePresetId?: string | null
    activeModules?: string[] | null
  }
}): { config: WorkspaceModuleConfig; needsMigration: boolean } {
  const hasProfile =
    raw.profile &&
    typeof raw.profile === "object" &&
    "id" in raw.profile &&
    typeof (raw.profile as { id: unknown }).id === "string"

  const hasEnabledModules = Array.isArray(raw.enabledModules)

  // Already migrated and valid
  if (hasProfile && hasEnabledModules) {
    const profileId = (raw.profile as { id: ProfileId }).id
    return {
      config: {
        profile: {
          id: PROFILES[profileId] ? profileId : "custom",
          catalogRevision:
            typeof (raw.profile as { catalogRevision?: unknown }).catalogRevision === "string"
              ? (raw.profile as { catalogRevision: string }).catalogRevision
              : "2026-09-20",
        },
        enabledModules: (raw.enabledModules as string[]).map(toCanonicalModuleId),
        moduleSettings:
          raw.moduleSettings && typeof raw.moduleSettings === "object"
            ? (raw.moduleSettings as Record<string, unknown>)
            : {},
      },
      needsMigration: false,
    }
  }

  // Need migration from legacy layout or preset
  const layout = raw.layout ?? {}
  const activePresetId = layout.activePresetId

  let profileId: ProfileId = "standard"
  let enabledModules: string[] = [...STANDARD_MODULES]

  if (activePresetId === "simple") {
    profileId = "minimal"
    enabledModules = []
  } else if (Array.isArray(layout.activeModules)) {
    enabledModules = layout.activeModules.map(toCanonicalModuleId)
    const isStandard =
      enabledModules.length === STANDARD_MODULES.length &&
      enabledModules.every((id) => STANDARD_MODULES.includes(id))
    profileId = isStandard ? "standard" : "custom"
  }

  const config = applyProfileToWorkspace(profileId, {
    enabledModules,
    moduleSettings:
      raw.moduleSettings && typeof raw.moduleSettings === "object"
        ? (raw.moduleSettings as Record<string, unknown>)
        : {},
  })

  return { config, needsMigration: true }
}

/**
 * Migrates workspace configuration to the 0.1.5 modular format.
 * If migration is needed, creates a backup first. Aborts if backup fails!
 */
export async function migrateWorkspaceModules(
  rawConfig: Record<string, unknown>,
): Promise<MigrationResult> {
  const { config, needsMigration } = determineMigratedModuleConfig(rawConfig)

  if (!needsMigration) {
    return { migrated: false, config }
  }

  let backupPath: string
  try {
    backupPath = await backupWorkspaceConfig(rawConfig)
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error("Migration aborted: Failed to create workspace config backup:", errorMsg)
    await appendMigrationJournal({
      version: WORKSPACE_MODULES_MIGRATION_VERSION,
      timestamp: new Date().toISOString(),
      status: "failed",
      backupPath: "",
      error: `Backup failed: ${errorMsg}`,
    })
    const abortedErr = new Error(`Migration aborted: Pre-migration backup failed: ${errorMsg}`)
    if (err && typeof err === "object" && "code" in err) {
      ;(abortedErr as unknown as { code: unknown }).code = (err as { code: unknown }).code
    }
    throw abortedErr
  }

  await appendMigrationJournal({
    version: WORKSPACE_MODULES_MIGRATION_VERSION,
    timestamp: new Date().toISOString(),
    status: "success",
    backupPath,
    details: { profileId: config.profile.id, moduleCount: config.enabledModules.length },
  })

  return {
    migrated: true,
    backupPath,
    config,
  }
}

/**
 * Rolls back a migration by restoring the saved backup configuration.
 */
export async function rollbackWorkspaceModulesMigration(
  backupPath: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const restoredConfig = await loadVaultJSON<Record<string, unknown>>(backupPath, {})
    if (!restoredConfig || Object.keys(restoredConfig).length === 0) {
      throw new Error(`Backup file "${backupPath}" is missing or empty`)
    }
    await saveVaultJSON("workspace.json", restoredConfig)
    await appendMigrationJournal({
      version: WORKSPACE_MODULES_MIGRATION_VERSION,
      timestamp: new Date().toISOString(),
      status: "rolled_back",
      backupPath,
    })
    return { ok: true }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: errorMsg }
  }
}
