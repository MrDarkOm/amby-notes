import { globalFileMissing, loadGlobalJSON, saveGlobalJSON } from "@/lib/storage"
import { toCanonicalModuleId } from "../types"
import type { CatalogModuleEntry, ModuleCatalog } from "./types"

export const MODULE_CATALOG_FILE = "module-catalog.json"
export const CATALOG_REVISION = "2026-09-24"

function createOfficialEntry(
  id: string,
  name: string,
  version: string,
  downloadSize: number,
  installedSize: number,
  permissions: (
    | "vault.read"
    | "vault.write"
    | "workspace.tabs"
    | "network"
    | "clipboard.read"
    | "clipboard.write"
  )[],
  entry = "index.js",
): CatalogModuleEntry {
  return {
    id,
    name,
    publisher: "Amby",
    kind: "official",
    latestVersion: version,
    versions: {
      [version]: {
        version,
        downloadUrl: `https://github.com/MrDarkOm/amby-notes/releases/download/v0.1.4/${id}-${version}.amby-pkg`,
        downloadSize,
        installedSize,
        checksum: "sha256:official-verified",
        minAppVersion: "0.1.4",
      },
    },
    manifest: {
      formatVersion: 1,
      id,
      name,
      version,
      publisher: "Amby",
      kind: "official",
      minAppVersion: "0.1.4",
      entry,
      permissions,
      data: {
        namespace: `.amby/modules/${id}`,
        uninstallPolicy: "preserve",
      },
      checksums: {
        [entry]: "sha256:entry-checksum-placeholder",
      },
      signature: {
        keyId: "amby-official-2026",
        sig: `ed25519:${id}-sig`,
      },
    },
  }
}

export const OFFICIAL_BUILTIN_CATALOG: ModuleCatalog = {
  catalogRevision: CATALOG_REVISION,
  lastUpdated: "2026-09-20T00:00:00.000Z",
  modules: {
    "amby.tags": createOfficialEntry("amby.tags", "Tags", "1.0.0", 45_000, 60_000, [
      "vault.read",
      "vault.write",
    ]),
    "amby.favorites": createOfficialEntry("amby.favorites", "Favorites", "1.0.0", 30_000, 40_000, [
      "vault.read",
      "vault.write",
    ]),
    "amby.databases": createOfficialEntry(
      "amby.databases",
      "Databases",
      "1.0.0",
      350_000,
      450_000,
      ["vault.read", "vault.write"],
    ),
    "amby.history": createOfficialEntry("amby.history", "History", "1.0.0", 120_000, 160_000, [
      "vault.read",
      "vault.write",
    ]),
    "amby.links": createOfficialEntry("amby.links", "Links", "1.0.0", 60_000, 80_000, [
      "vault.read",
    ]),
    "amby.graph": createOfficialEntry("amby.graph", "Graph", "1.0.0", 250_000, 320_000, [
      "vault.read",
    ]),
    "amby.ai": createOfficialEntry("amby.ai", "AI Assistant", "1.0.0", 180_000, 240_000, [
      "vault.read",
      "network",
    ]),
    "amby.excalidraw": createOfficialEntry(
      "amby.excalidraw",
      "Excalidraw",
      "1.0.0",
      4_100_000,
      5_200_000,
      ["vault.read", "vault.write", "clipboard.read", "clipboard.write"],
    ),
    "amby.canvas": createOfficialEntry("amby.canvas", "Canvas", "1.0.0", 1_200_000, 1_600_000, [
      "vault.read",
      "vault.write",
      "workspace.tabs",
    ]),
  },
}

let catalogWriteChain: Promise<void> = Promise.resolve()

/**
 * Loads the module catalog from global app data, seeding it with the official catalog if missing.
 */
export async function loadModuleCatalog(): Promise<ModuleCatalog> {
  if (await globalFileMissing(MODULE_CATALOG_FILE)) {
    await saveModuleCatalog(OFFICIAL_BUILTIN_CATALOG)
    return OFFICIAL_BUILTIN_CATALOG
  }

  const raw = await loadGlobalJSON<Partial<ModuleCatalog>>(MODULE_CATALOG_FILE, {})
  if (!raw || !raw.modules || raw.catalogRevision !== CATALOG_REVISION) {
    await saveModuleCatalog(OFFICIAL_BUILTIN_CATALOG)
    return OFFICIAL_BUILTIN_CATALOG
  }

  return {
    catalogRevision: CATALOG_REVISION,
    lastUpdated: typeof raw.lastUpdated === "string" ? raw.lastUpdated : new Date().toISOString(),
    modules: {
      ...raw.modules,
      ...OFFICIAL_BUILTIN_CATALOG.modules,
    },
  }
}

/**
 * Persists the module catalog to global storage.
 */
export function saveModuleCatalog(catalog: ModuleCatalog): Promise<void> {
  const write = async () => {
    await saveGlobalJSON(MODULE_CATALOG_FILE, catalog)
  }
  const next = catalogWriteChain.then(write, write)
  catalogWriteChain = next.catch((err) => {
    console.error("Failed to save module catalog:", err)
  })
  return next
}

/**
 * Retrieves a catalog entry by module id (short or canonical).
 */
export async function getCatalogModule(moduleId: string): Promise<CatalogModuleEntry | null> {
  const catalog = await loadModuleCatalog()
  const canonicalId = toCanonicalModuleId(moduleId)
  return catalog.modules[canonicalId] ?? null
}
