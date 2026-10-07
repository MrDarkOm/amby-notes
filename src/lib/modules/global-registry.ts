import { globalFileMissing, loadGlobalJSON, saveGlobalJSON } from "@/lib/storage"
import {
  MODULES_REGISTRY_FILE,
  MODULES_REGISTRY_VERSION,
  toCanonicalModuleId,
  type GlobalModulesRegistry,
  type InstalledModule,
} from "./types"

const BUILTIN_MODULES: InstalledModule[] = [
  {
    id: "amby.tags",
    version: "1.0.0",
    activeVersion: "1.0.0",
    signatureStatus: "signed",
    source: "builtin",
    installedAt: 0,
  },
  {
    id: "amby.favorites",
    version: "1.0.0",
    activeVersion: "1.0.0",
    signatureStatus: "signed",
    source: "builtin",
    installedAt: 0,
  },
  {
    id: "amby.databases",
    version: "1.0.0",
    activeVersion: "1.0.0",
    signatureStatus: "signed",
    source: "builtin",
    installedAt: 0,
  },
  {
    id: "amby.history",
    version: "1.0.0",
    activeVersion: "1.0.0",
    signatureStatus: "signed",
    source: "builtin",
    installedAt: 0,
  },
  {
    id: "amby.links",
    version: "1.0.0",
    activeVersion: "1.0.0",
    signatureStatus: "signed",
    source: "builtin",
    installedAt: 0,
  },
  {
    id: "amby.graph",
    version: "1.0.0",
    activeVersion: "1.0.0",
    signatureStatus: "signed",
    source: "builtin",
    installedAt: 0,
  },
  {
    id: "amby.sync",
    version: "1.0.0",
    activeVersion: "1.0.0",
    signatureStatus: "signed",
    source: "builtin",
    installedAt: 0,
  },
  {
    id: "amby.ai",
    version: "1.0.0",
    activeVersion: "1.0.0",
    signatureStatus: "signed",
    source: "builtin",
    installedAt: 0,
  },
  {
    id: "amby.excalidraw",
    version: "1.0.0",
    activeVersion: "1.0.0",
    signatureStatus: "signed",
    source: "builtin",
    installedAt: 0,
  },
  {
    id: "amby.canvas",
    version: "1.0.0",
    activeVersion: "1.0.0",
    signatureStatus: "signed",
    source: "builtin",
    installedAt: 0,
  },
  {
    id: "amby.creative",
    version: "1.0.0",
    activeVersion: "1.0.0",
    signatureStatus: "signed",
    source: "builtin",
    installedAt: 0,
  },
]

export function createDefaultGlobalRegistry(): GlobalModulesRegistry {
  const installed: Record<string, InstalledModule> = {}
  for (const m of BUILTIN_MODULES) {
    installed[m.id] = { ...m, installedAt: Date.now() }
  }
  return {
    schemaVersion: MODULES_REGISTRY_VERSION,
    installed,
    uninstalled: [],
  }
}

let registryWriteChain: Promise<void> = Promise.resolve()

export async function loadGlobalModulesRegistry(): Promise<GlobalModulesRegistry> {
  if (await globalFileMissing(MODULES_REGISTRY_FILE)) {
    const defaultRegistry = createDefaultGlobalRegistry()
    await saveGlobalModulesRegistry(defaultRegistry)
    return defaultRegistry
  }

  const raw = await loadGlobalJSON<Partial<GlobalModulesRegistry>>(MODULES_REGISTRY_FILE, {})
  const installed: Record<string, InstalledModule> = {}

  if (raw && typeof raw.installed === "object" && raw.installed !== null) {
    for (const [id, mod] of Object.entries(raw.installed)) {
      if (mod && typeof mod === "object") {
        const canonicalId = toCanonicalModuleId(id)
        installed[canonicalId] = {
          id: canonicalId,
          version: typeof mod.version === "string" ? mod.version : "1.0.0",
          activeVersion: typeof mod.activeVersion === "string" ? mod.activeVersion : "1.0.0",
          signatureStatus:
            mod.signatureStatus === "signed" ||
            mod.signatureStatus === "unsigned" ||
            mod.signatureStatus === "invalid"
              ? mod.signatureStatus
              : "signed",
          source:
            mod.source === "builtin" || mod.source === "catalog" || mod.source === "sideload"
              ? mod.source
              : "builtin",
          installedAt: typeof mod.installedAt === "number" ? mod.installedAt : Date.now(),
          lastUsedAt: typeof mod.lastUsedAt === "number" ? mod.lastUsedAt : undefined,
        }
      }
    }
  }

  const uninstalled = Array.isArray(raw?.uninstalled)
    ? raw.uninstalled.map(toCanonicalModuleId)
    : []
  const uninstalledSet = new Set(uninstalled)

  // Ensure built-in modules are registered unless explicitly uninstalled
  let missingBuiltinAdded = false
  for (const builtin of BUILTIN_MODULES) {
    if (!installed[builtin.id] && !uninstalledSet.has(builtin.id)) {
      installed[builtin.id] = { ...builtin, installedAt: Date.now() }
      missingBuiltinAdded = true
    }
  }

  const registry: GlobalModulesRegistry = {
    schemaVersion:
      typeof raw?.schemaVersion === "number" ? raw.schemaVersion : MODULES_REGISTRY_VERSION,
    installed,
    uninstalled,
  }

  if (missingBuiltinAdded) {
    void saveGlobalModulesRegistry(registry).catch(() => {})
  }

  return registry
}

export function saveGlobalModulesRegistry(registry: GlobalModulesRegistry): Promise<void> {
  const write = async () => {
    await saveGlobalJSON(MODULES_REGISTRY_FILE, {
      schemaVersion: MODULES_REGISTRY_VERSION,
      installed: registry.installed,
      uninstalled: registry.uninstalled ?? [],
    })
  }
  const next = registryWriteChain.then(write, write)
  registryWriteChain = next.catch((err) => {
    console.error("Failed to save global modules registry:", err)
  })
  return next
}

export async function isModuleInstalled(id: string): Promise<boolean> {
  const registry = await loadGlobalModulesRegistry()
  const canonicalId = toCanonicalModuleId(id)
  return !!registry.installed[canonicalId]
}

export async function getInstalledModuleIds(): Promise<Set<string>> {
  const registry = await loadGlobalModulesRegistry()
  return new Set(Object.keys(registry.installed))
}
