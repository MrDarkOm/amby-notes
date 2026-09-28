import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater"
import { getCurrentWindow } from "@tauri-apps/api/window"
import packageJson from "../../package.json"
import { errorType, logger } from "@/lib/logger"
import { isTauri } from "@/lib/storage"

const CHECK_TIMEOUT_MS = 30_000
const STARTUP_CHECK_TIMEOUT_MS = 5_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

export type StartupUpdateResult = "ready" | "restarting"

export type UpdateInstallProgress =
  | { phase: "downloading"; percent: number | null }
  | { phase: "installing" }
  | { phase: "restarting" }

export interface AvailableAppUpdate {
  currentVersion: string
  version: string
  notes: string | null
  install: (onProgress?: (progress: UpdateInstallProgress) => void) => Promise<void>
  close: () => Promise<void>
}

export function isAppUpdaterAvailable(): boolean {
  // Manual checks are useful in Tauri dev builds too. Automatic installation
  // remains disabled below while Vite is running in development mode.
  return isTauri()
}

export async function getCurrentAppVersion(): Promise<string> {
  if (!isTauri()) return packageJson.version
  try {
    const { getVersion } = await import("@tauri-apps/api/app")
    return await getVersion()
  } catch (error) {
    logger.warn("updater.version_read_failed", { errorType: errorType(error) })
    return packageJson.version
  }
}

export function calculateDownloadPercent(downloaded: number, total?: number): number | null {
  if (!total || total <= 0) return null
  return Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)))
}

function wrapUpdate(update: Update): AvailableAppUpdate {
  return {
    currentVersion: update.currentVersion,
    version: update.version,
    notes: update.body ?? null,
    install: async (onProgress) => {
      let downloaded = 0
      let total: number | undefined
      const report = (event: DownloadEvent) => {
        if (event.event === "Started") {
          downloaded = 0
          total = event.data.contentLength
          onProgress?.({ phase: "downloading", percent: calculateDownloadPercent(0, total) })
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength
          onProgress?.({
            phase: "downloading",
            percent: calculateDownloadPercent(downloaded, total),
          })
        } else {
          onProgress?.({ phase: "installing" })
        }
      }

      await update.downloadAndInstall(report, {
        timeout: DOWNLOAD_TIMEOUT_MS,
        restartAfterInstall: true,
      })
      onProgress?.({ phase: "restarting" })
      const { relaunch } = await import("@tauri-apps/plugin-process")
      await relaunch()
    },
    close: () => update.close(),
  }
}

export async function checkForAppUpdate(
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<AvailableAppUpdate | null> {
  if (!isAppUpdaterAvailable()) return null
  const { check } = await import("@tauri-apps/plugin-updater")
  const update = await check({ timeout: timeoutMs })
  return update ? wrapUpdate(update) : null
}

let automaticUpdateTask: Promise<StartupUpdateResult> | null = null

/**
 * Shared startup task: StrictMode and repeated subscriptions must await the
 * same check/install rather than opening the workspace while it is running.
 * The update endpoint request itself checks connectivity (including DNS/TLS);
 * no unrelated ping service or unreliable navigator.onLine hint is needed.
 */
export function runAutomaticAppUpdate(): Promise<StartupUpdateResult> {
  if (import.meta.env.DEV || !isAppUpdaterAvailable()) return Promise.resolve("ready")
  automaticUpdateTask ??= installStartupUpdate()
  return automaticUpdateTask
}

async function installStartupUpdate(): Promise<StartupUpdateResult> {
  let update: AvailableAppUpdate | null = null
  try {
    if (getCurrentWindow().label !== "main") return "ready"
    const { getBundleType } = await import("@tauri-apps/api/app")
    const bundleType = await getBundleType()
    // Linux package installs invoke pkexec/GUI sudo inside the native updater.
    // Keep those explicit in settings; portable AppImage updates stay silent.
    if (bundleType === "deb" || bundleType === "rpm") return "ready"
    update = await checkForAppUpdate(STARTUP_CHECK_TIMEOUT_MS)
    if (!update) return "ready"

    await update.install()
    // Keep the old workspace unopened while the process is being replaced.
    return "restarting"
  } catch (error) {
    logger.warn("updater.automatic_update_failed", { errorType: errorType(error) })
    return "ready"
  } finally {
    await update?.close().catch(() => {})
  }
}
