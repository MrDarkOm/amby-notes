import i18n from "@/lib/i18n"
import type { HistoryCleanupPreview, HistoryStats } from "./types"

export const webHistoryStats = (): HistoryStats => ({
  snapshotCount: 0,
  noteCount: 0,
  sizeBytes: 0,
})

export const webHistoryPreview = (): HistoryCleanupPreview => ({
  removedCount: 0,
  freedBytes: 0,
  remaining: webHistoryStats(),
})

export function webHistoryUnavailable(): never {
  throw new Error(i18n.t("errors.localHistoryDesktopOnly"))
}

export function webTrashUnavailable(): never {
  throw new Error(i18n.t("errors.trashDesktopOnly"))
}
