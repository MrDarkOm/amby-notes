import { catalogDownloadUrl, getCatalogModule } from "./catalog"
import { installFromRemoteUrl } from "./installer"
import type { InstallResult } from "./types"

/**
 * Downloads and installs the latest catalog version of a module (the one path every "download and
 * enable" button takes). A failure comes back as the result; the caller shows it with
 * `reportInstallFailure`.
 */
export async function installCatalogModule(
  canonicalId: string,
): Promise<{ result: InstallResult; targetVersion: string }> {
  const catalogEntry = await getCatalogModule(canonicalId)
  const targetVersion = catalogEntry?.latestVersion ?? "1.0.0"
  const result = await installFromRemoteUrl(
    catalogDownloadUrl(canonicalId, targetVersion, catalogEntry),
  )
  return { result, targetVersion }
}
