import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater"
import packageJson from "../../package.json"
import i18n from "@/lib/i18n"
import { errorType, logger } from "@/lib/logger"
import { confirmAction, isTauri } from "@/lib/storage"

const CHECK_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

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
  return isTauri() && !import.meta.env.DEV
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

export async function checkForAppUpdate(): Promise<AvailableAppUpdate | null> {
  if (!isAppUpdaterAvailable()) return null
  const { check } = await import("@tauri-apps/plugin-updater")
  const update = await check({ timeout: CHECK_TIMEOUT_MS })
  return update ? wrapUpdate(update) : null
}

let automaticCheckStarted = false

/**
 * Checks once per main-window launch. Installation always requires a user
 * confirmation because the Windows updater exits the app during installation.
 */
export async function runAutomaticAppUpdate(): Promise<void> {
  if (automaticCheckStarted || !isAppUpdaterAvailable()) return
  automaticCheckStarted = true

  let update: AvailableAppUpdate | null = null
  try {
    update = await checkForAppUpdate()
    if (!update) return

    const accepted = await confirmAction(
      i18n.t("settings.updates.autoInstallPrompt", { version: update.version }),
    )
    if (!accepted) return

    await update.install()
  } catch (error) {
    logger.warn("updater.automatic_update_failed", { errorType: errorType(error) })
  } finally {
    await update?.close().catch(() => {})
  }
}
