import * as React from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, ArchiveRestore, GitCompare } from "lucide-react"

import { Button } from "@/components/ui/button"
import { errorType, logger } from "@/lib/logger"
import { relativeToVault } from "../editor/document-breadcrumbs-utils"
import { useVaultStore } from "../use-vault-store"
import { restoreRemoteDeleted } from "./restore-remote-deleted"
import { conflictForPath, useSyncNoticesStore } from "./use-sync-notices-store"

const STRIP_CLASS =
  "flex shrink-0 items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-950 dark:text-amber-100"
const STRIP_BUTTON_CLASS =
  "shrink-0 border-amber-500/40 bg-transparent text-amber-950 hover:bg-amber-500/15 dark:text-amber-100"

/**
 * The strips above a note that come from sync: "this note has a second version from another
 * computer" (for the main file and for the copy), and "deleted on another computer" for a note
 * that was open when the deletion arrived (Р7, Р8).
 */
export function SyncDocumentBanners({ path }: { path: string }) {
  const { t } = useTranslation()
  const vault = useVaultStore((state) => state.vault)
  const conflicts = useSyncNoticesStore((state) => state.conflicts)
  const openCompare = useSyncNoticesStore((state) => state.openCompare)
  const deleted = useSyncNoticesStore((state) =>
    Boolean(vault && state.remoteDeleted.includes(relativeToVault(path, vault).normalize("NFC"))),
  )
  const [restoring, setRestoring] = React.useState(false)
  const [restoreFailed, setRestoreFailed] = React.useState(false)

  React.useEffect(() => setRestoreFailed(false), [path])

  if (!vault) return null
  const found = conflictForPath(conflicts, vault, path)

  const restore = async () => {
    if (restoring) return
    setRestoring(true)
    setRestoreFailed(false)
    try {
      await restoreRemoteDeleted(vault, relativeToVault(path, vault).normalize("NFC"))
    } catch (error) {
      logger.warn("sync.restore_remote_deleted_failed", { errorType: errorType(error) })
      setRestoreFailed(true)
    } finally {
      setRestoring(false)
    }
  }

  return (
    <>
      {deleted && (
        <div role="alert" data-testid="sync-remote-deleted-banner" className={STRIP_CLASS}>
          <ArchiveRestore className="size-4 shrink-0 text-amber-600 dark:text-amber-300" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t("sync.notices.remoteDeleted")}</p>
            {restoreFailed && (
              <p className="mt-1 text-xs text-destructive">{t("sync.notices.restoreFailed")}</p>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={restoring}
            onClick={() => void restore()}
            className={STRIP_BUTTON_CLASS}
          >
            {restoring ? t("sync.notices.restoring") : t("sync.notices.restore")}
          </Button>
        </div>
      )}
      {found && (
        <div role="status" data-testid="sync-conflict-banner" className={STRIP_CLASS}>
          <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-300" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t("sync.notices.bannerText")}</p>
            <p className="break-all text-xs text-amber-900/75 dark:text-amber-100/75">
              {found.role === "original"
                ? t("sync.notices.bannerHintOriginal", { other: found.conflict.copyPath })
                : t("sync.notices.bannerHintCopy", { other: found.conflict.originalPath })}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => openCompare(found.conflict.id)}
            className={STRIP_BUTTON_CLASS}
          >
            <GitCompare />
            {t("sync.notices.compare")}
          </Button>
        </div>
      )}
    </>
  )
}
