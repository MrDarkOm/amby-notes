import i18n from "@/lib/i18n"
import { errorType, logger } from "@/lib/logger"
import { openInExplorer } from "@/lib/storage"
import { useAppNoticesStore } from "./notices/use-app-notices-store"

/** The name of this system's file manager for "Show in {{place}}" strings. */
export function fileManagerPlace(
  platform = typeof navigator !== "undefined" ? navigator.platform : "",
): string {
  const key = /Mac/i.test(platform) ? "mac" : /Win/i.test(platform) ? "windows" : "other"
  return i18n.t(`common.fileManagerPlace.${key}`)
}

/**
 * "Show in the file manager" for a file or folder of the vault. The answer is awaited. When the system could not
 * be asked, nothing changed in the vault, and the menu that was clicked has already closed, so the answer is a
 * warning in the notification centre, in words (docs/notices.md, sections 3 and 10); the code goes to the log.
 */
export async function showInFileManager(path: string): Promise<void> {
  try {
    await openInExplorer(path)
  } catch (error) {
    logger.warn("file.reveal_failed", { errorType: errorType(error) })
    useAppNoticesStore.getState().post({
      id: "file-reveal-failed",
      level: "warning",
      titleKey: "externalOpen.revealFailed",
      params: { place: fileManagerPlace() },
      lineKey: "notices.app.nothingChanged",
    })
  }
}
