import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  AlertTriangle,
  ArchiveRestore,
  FileWarning,
  GitCompare,
  Lightbulb,
  NotebookPen,
  Save,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { errorType, logger } from "@/lib/logger"
import { relativeToVault } from "../editor/document-breadcrumbs-utils"
import { restoreRemoteDeleted } from "../sync/restore-remote-deleted"
import { conflictForPath, useSyncNoticesStore } from "../sync/use-sync-notices-store"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { useNoteNoticesStore } from "./use-note-notices-store"

export interface NoteNoticesProps {
  document: { id: string; path: string; externallyDeleted?: boolean }
  /** The key of the warning about the note's properties or Live admission, if any. */
  warningKey: string | null
  /** Whether the open text can be written back after the file was deleted. */
  canRestoreDeleted?: boolean
  onRestoreDeleted?: () => void | Promise<void>
  onCloseTab?: () => void
}

interface Notice {
  /** Stable while the same thing is being said; a new one opens the stack when it is urgent. */
  id: string
  /** The text of the note is in danger, or the person must decide: opens the stack by itself. */
  urgent: boolean
  card: React.ReactNode
}

/**
 * The notices of a note above its bottom bar (docs/sync-plan.md, stage Э4б К3): a bulb with the number
 * and a stack of cards. Every warning that used to be a strip above the note is a card here, with the
 * same buttons. Urgent cards open the stack by themselves; a card goes away when its question is decided.
 */
export function NoteNotices(props: NoteNoticesProps) {
  return <NoteNoticesOf key={props.document.id} {...props} />
}

function Card({
  testId,
  urgent,
  icon,
  title,
  lines = [],
  error,
  actions,
}: {
  testId: string
  urgent: boolean
  icon: React.ReactNode
  title: string
  lines?: string[]
  error?: string | null
  actions?: React.ReactNode
}) {
  return (
    <div
      data-testid={testId}
      data-urgent={urgent}
      className="note-notice-card pointer-events-auto flex items-start gap-3 rounded-xl px-3 py-2.5"
    >
      <span className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300">{icon}</span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-[13px] font-medium">{title}</p>
        {lines.map((line) => (
          <p key={line} className="break-all text-[11px] text-muted-foreground">
            {line}
          </p>
        ))}
        {error && (
          <p role="alert" className="text-[11px] text-destructive">
            {error}
          </p>
        )}
        {actions && <div className="flex flex-wrap gap-2 pt-1">{actions}</div>}
      </div>
    </div>
  )
}

function NoteNoticesOf({
  document,
  warningKey,
  canRestoreDeleted = false,
  onRestoreDeleted,
  onCloseTab,
}: NoteNoticesProps) {
  const { t } = useTranslation()
  const vault = useVaultStore((state) => state.vault)
  const conflicts = useSyncNoticesStore((state) => state.conflicts)
  const openCompare = useSyncNoticesStore((state) => state.openCompare)
  const relative = vault ? relativeToVault(document.path, vault).normalize("NFC") : null
  const remoteDeleted = useSyncNoticesStore((state) =>
    relative ? state.remoteDeleted.includes(relative) : false,
  )
  const remoteRestoreFailed = useSyncNoticesStore((state) =>
    relative ? state.restoreFailed.includes(relative) : false,
  )
  const externalConflict = useDocStore((state) => state.externalConflicts[document.id])
  const openConflictDialog = useDocStore((state) => state.openConflictDialog)
  const saveFailed = useNoteNoticesStore((state) => Boolean(state.saveFailed[document.id]))
  const draftOffer = useNoteNoticesStore((state) => state.draftOffers[document.id])
  const restored = useNoteNoticesStore((state) =>
    relative ? state.restored.includes(relative) : false,
  )

  const [restoringRemote, setRestoringRemote] = React.useState(false)
  const [remoteRestoreError, setRemoteRestoreError] = React.useState(false)
  const [restoringDeleted, setRestoringDeleted] = React.useState(false)
  const [deletedRestoreError, setDeletedRestoreError] = React.useState(false)
  React.useEffect(() => {
    setDeletedRestoreError(false)
    setRestoringDeleted(false)
  }, [document.externallyDeleted])

  const restoreRemote = async () => {
    if (restoringRemote || !relative || !vault) return
    setRestoringRemote(true)
    setRemoteRestoreError(false)
    try {
      await restoreRemoteDeleted(vault, relative)
    } catch (error) {
      logger.warn("sync.restore_remote_deleted_failed", { errorType: errorType(error) })
      setRemoteRestoreError(true)
    } finally {
      setRestoringRemote(false)
    }
  }
  const restoreDeleted = async () => {
    if (!onRestoreDeleted || restoringDeleted) return
    setRestoringDeleted(true)
    setDeletedRestoreError(false)
    try {
      await onRestoreDeleted()
    } catch {
      setDeletedRestoreError(true)
    } finally {
      setRestoringDeleted(false)
    }
  }

  const notices: Notice[] = []
  const found = vault ? conflictForPath(conflicts, vault, document.path) : null
  if (found) {
    notices.push({
      id: `sync-conflict:${found.conflict.id}`,
      urgent: true,
      card: (
        <Card
          key="sync-conflict"
          testId="note-notice-sync-conflict"
          urgent
          icon={<AlertTriangle className="size-4" />}
          title={t("noteNotices.syncConflict")}
          lines={[
            found.role === "original"
              ? t("sync.notices.bannerHintOriginal", { other: found.conflict.copyPath })
              : t("sync.notices.bannerHintCopy", { other: found.conflict.originalPath }),
          ]}
          actions={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => openCompare(found.conflict.id)}
            >
              <GitCompare />
              {t("sync.notices.compare")}
            </Button>
          }
        />
      ),
    })
  }
  // The strip for a note deleted on another computer steps in front of the general "deleted" one,
  // until the way back from the archive has failed.
  const remoteActive = remoteDeleted && !remoteRestoreFailed
  if (remoteDeleted) {
    notices.push({
      id: "remote-deleted",
      urgent: true,
      card: (
        <Card
          key="remote-deleted"
          testId="note-notice-remote-deleted"
          urgent
          icon={<ArchiveRestore className="size-4" />}
          title={t("sync.notices.remoteDeleted")}
          error={remoteRestoreError ? t("sync.notices.restoreFailed") : null}
          actions={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={restoringRemote}
              onClick={() => void restoreRemote()}
            >
              {restoringRemote ? t("sync.notices.restoring") : t("sync.notices.restore")}
            </Button>
          }
        />
      ),
    })
  }
  if (document.externallyDeleted && !remoteActive) {
    notices.push({
      id: "external-deleted",
      urgent: true,
      card: (
        <Card
          key="external-deleted"
          testId="note-notice-deleted"
          urgent
          icon={<AlertTriangle className="size-4" />}
          title={t("conflict.deletedBannerTitle")}
          lines={[t("conflict.deletedBannerDescription")]}
          error={deletedRestoreError ? t("conflict.restoreFailed") : null}
          actions={
            canRestoreDeleted && onRestoreDeleted ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={restoringDeleted}
                onClick={() => void restoreDeleted()}
              >
                {restoringDeleted ? t("conflict.saving") : t("conflict.restoreDeleted")}
              </Button>
            ) : onCloseTab ? (
              <Button type="button" size="sm" variant="outline" onClick={onCloseTab}>
                {t("common.close")}
              </Button>
            ) : undefined
          }
        />
      ),
    })
  }
  if (externalConflict && !document.externallyDeleted) {
    notices.push({
      id: "external-change",
      urgent: true,
      card: (
        <Card
          key="external-change"
          testId="note-notice-external-change"
          urgent
          icon={<AlertTriangle className="size-4" />}
          title={t("conflict.pausedAutosaveBannerTitle")}
          lines={[t("conflict.pausedAutosaveBannerDescription")]}
          actions={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => openConflictDialog(document.id)}
            >
              {t("conflict.resolveConflict")}
            </Button>
          }
        />
      ),
    })
  }
  if (saveFailed) {
    notices.push({
      id: "save-failed",
      urgent: true,
      card: (
        <Card
          key="save-failed"
          testId="note-notice-save-failed"
          urgent
          icon={<Save className="size-4" />}
          title={t("noteNotices.saveFailedTitle")}
          lines={[t("noteNotices.saveFailedDescription")]}
          actions={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => window.dispatchEvent(new Event("amby:manual-save"))}
            >
              {t("noteNotices.saveNow")}
            </Button>
          }
        />
      ),
    })
  }
  if (draftOffer) {
    notices.push({
      id: "draft",
      urgent: true,
      card: (
        <Card
          key="draft"
          testId="note-notice-draft"
          urgent
          icon={<NotebookPen className="size-4" />}
          title={t("noteNotices.draftTitle")}
          lines={[t("noteNotices.draftDescription")]}
          actions={
            <>
              <Button type="button" size="sm" onClick={draftOffer.accept}>
                {t("noteNotices.draftRestore")}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={draftOffer.reject}>
                {t("noteNotices.draftDiscard")}
              </Button>
            </>
          }
        />
      ),
    })
  }
  if (warningKey) {
    notices.push({
      id: `warning:${warningKey}`,
      urgent: false,
      card: (
        <Card
          key="warning"
          testId="note-notice-warning"
          urgent={false}
          icon={<FileWarning className="size-4" />}
          title={t(warningKey)}
        />
      ),
    })
  }
  if (restored && relative) {
    const name = (relative.split("/").pop() ?? relative).replace(/\.md$/iu, "")
    notices.push({
      id: "restored",
      urgent: false,
      card: (
        <Card
          key="restored"
          testId="note-notice-restored"
          urgent={false}
          icon={<ArchiveRestore className="size-4" />}
          title={t("sync.notices.restoredAfterDeletion", { name })}
          actions={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => useNoteNoticesStore.getState().clearRestored(relative)}
            >
              {t("sync.notices.dismiss")}
            </Button>
          }
        />
      ),
    })
  }

  const [open, setOpen] = React.useState(false)
  const seen = React.useRef<Set<string>>(new Set())
  const urgentKey = notices
    .filter((notice) => notice.urgent)
    .map((notice) => notice.id)
    .join("\u0000")
  React.useEffect(() => {
    const urgent = new Set(urgentKey ? urgentKey.split("\u0000") : [])
    if ([...urgent].some((id) => !seen.current.has(id))) setOpen(true)
    seen.current = urgent
  }, [urgentKey])

  if (notices.length === 0) return null
  const anyUrgent = notices.some((notice) => notice.urgent)
  return (
    <div
      data-testid="note-notices"
      className="pointer-events-none absolute bottom-14 right-4 z-20 flex max-w-[calc(100%-2rem)] flex-col items-end gap-2"
    >
      {open && (
        <div
          data-testid="note-notices-stack"
          className="flex max-h-[60vh] w-[min(26rem,calc(100vw-2rem))] flex-col gap-2 overflow-y-auto"
        >
          {notices.map((notice) => notice.card)}
        </div>
      )}
      <button
        type="button"
        data-testid="note-notices-bulb"
        data-urgent={anyUrgent}
        aria-label={t("noteNotices.bulbLabel", { count: notices.length })}
        title={t("noteNotices.bulbTitle")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="note-notices-bulb pointer-events-auto flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold select-none"
      >
        <Lightbulb className="size-3.5" aria-hidden="true" />
        <span>{notices.length}</span>
        {open && <X className="size-3" aria-hidden="true" />}
      </button>
    </div>
  )
}
