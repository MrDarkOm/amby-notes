import * as React from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, ChevronUp, GitCompare, History } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

import { Button } from "@/components/ui/button"
import { errorType, logger } from "@/lib/logger"
import { flushAutosaveGeneration } from "../autosave/autosave-lifecycle"
import { relativeToVault } from "../editor/document-breadcrumbs-utils"
import { conflictName } from "../sync/conflict-outcome"
import { restoreRemoteDeleted } from "../sync/restore-remote-deleted"
import { requestOpenPanel } from "../panel-navigation"
import { conflictForPath, useSyncNoticesStore } from "../sync/use-sync-notices-store"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { NoticeLevelIcon } from "../notices/notice-level"
import { mostSeriousNoticeLevel, noticeIsUrgent, noticeSeverityRank } from "../notices/notice-look"
import { motionTransitions } from "@/lib/motion-config"
import { Card, type Notice } from "./notice-card"
import { usePropertyNotices } from "./property-notices"
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

/**
 * The notices of a note above its bottom bar (docs/sync-plan.md, stage Э4б К3): a bulb with the number
 * and a stack of cards. Every warning that used to be a strip above the note is a card here, with the
 * same buttons. Urgent cards open the stack by themselves; a card goes away when its question is decided.
 */
export function NoteNotices(props: NoteNoticesProps) {
  return <NoteNoticesOf key={props.document.id} {...props} />
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
  const outcomes = useSyncNoticesStore((state) => state.outcomes)
  const dismissOutcome = useSyncNoticesStore((state) => state.dismissOutcome)
  const conflictOutcomes = outcomes.filter((item) => item.path === relative)
  const externalConflict = useDocStore((state) => state.externalConflicts[document.id])
  const openConflictDialog = useDocStore((state) => state.openConflictDialog)
  const saveFailed = useNoteNoticesStore((state) => Boolean(state.saveFailed[document.id]))
  const propertyFailed = useNoteNoticesStore((state) => Boolean(state.propertyFailed[document.id]))
  const draftOffer = useNoteNoticesStore((state) => state.draftOffers[document.id])
  const restored = useNoteNoticesStore((state) =>
    relative ? state.restored.includes(relative) : false,
  )
  const merged = useNoteNoticesStore((state) =>
    relative ? state.merged.includes(relative) : false,
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
  const propertyNotices = usePropertyNotices(document.id)
  const found = vault ? conflictForPath(conflicts, vault, document.path) : null
  if (found) {
    notices.push({
      id: `sync-conflict:${found.conflict.id}`,
      card: (
        <Card
          key="sync-conflict"
          testId="note-notice-sync-conflict"
          level="decision"
          title={t(
            found.conflict.kind === "bothCreated"
              ? "sync.vault.conflicts.createdTitle"
              : "sync.vault.conflicts.editedTitle",
            { name: conflictName(found.conflict.originalPath) },
          )}
          lines={[t("sync.vault.conflicts.bothSafe")]}
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
  // What was done after a choice in the comparison (docs/notices.md, section 10): news, not a question.
  for (const outcome of conflictOutcomes) {
    notices.push({
      id: `conflict-outcome:${outcome.conflictId}`,
      card: (
        <Card
          key={`conflict-outcome:${outcome.conflictId}`}
          testId="note-notice-conflict-outcome"
          level="info"
          title={t(`sync.notices.outcome.${outcome.choice}`, { name: outcome.name })}
          actions={
            <>
              {(outcome.choice === "keepCopy" || outcome.choice === "assembled") && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => requestOpenPanel("history")}
                >
                  <History />
                  {t("sync.notices.openHistory")}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => dismissOutcome(outcome.conflictId)}
              >
                {t("sync.notices.dismiss")}
              </Button>
            </>
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
      card: (
        <Card
          key="remote-deleted"
          testId="note-notice-remote-deleted"
          level="decision"
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
      card: (
        <Card
          key="external-deleted"
          testId="note-notice-deleted"
          level="danger"
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
      card: (
        <Card
          key="external-change"
          testId="note-notice-external-change"
          level="decision"
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
      card: (
        <Card
          key="save-failed"
          testId="note-notice-save-failed"
          level="danger"
          title={t("noteNotices.saveFailedTitle")}
          lines={[t("noteNotices.saveFailedDescription")]}
          actions={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                // Like the save shortcut: the editor hands over its text, then the queue writes again.
                window.dispatchEvent(new Event("amby:manual-save"))
                void flushAutosaveGeneration(useVaultStore.getState().generation).catch((error) =>
                  logger.warn("note_notice.save_now_failed", { errorType: errorType(error) }),
                )
              }}
            >
              {t("noteNotices.saveNow")}
            </Button>
          }
        />
      ),
    })
  }
  if (propertyFailed) {
    notices.push({
      id: "property-failed",
      card: (
        <Card
          key="property-failed"
          testId="note-notice-property-failed"
          level="danger"
          title={t("noteNotices.properties.saveFailed")}
        />
      ),
    })
  }
  if (draftOffer) {
    notices.push({
      id: "draft",
      card: (
        <Card
          key="draft"
          testId="note-notice-draft"
          level="decision"
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
    // A lost id switches the properties off for good: the person decides what to do. The other
    // warnings about the header only limit what the note can do.
    const warningLevel = warningKey === "workspace.identityReadOnly" ? "decision" : "warning"
    notices.push({
      id: `warning:${warningKey}`,
      card: (
        <Card
          key="warning"
          testId="note-notice-warning"
          level={warningLevel}
          title={t(warningKey)}
        />
      ),
    })
  }
  // The program merged the edits of two computers by itself (docs/notices.md, section 12): it says so,
  // quietly, and shows where the earlier version is.
  if (merged && relative) {
    notices.push({
      id: "merged",
      card: (
        <Card
          key="merged"
          testId="note-notice-merged"
          level="info"
          title={t("noteNotices.mergedTitle")}
          lines={[t("noteNotices.mergedLine")]}
          actions={
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => requestOpenPanel("history")}
              >
                <History />
                {t("sync.notices.openHistory")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => useNoteNoticesStore.getState().clearMerged(relative)}
              >
                {t("sync.notices.dismiss")}
              </Button>
            </>
          }
        />
      ),
    })
  }
  if (restored && relative) {
    const name = (relative.split("/").pop() ?? relative).replace(/\.md$/iu, "")
    notices.push({
      id: "restored",
      card: (
        <Card
          key="restored"
          testId="note-notice-restored"
          level="info"
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

  notices.push(...propertyNotices)
  // The panel reads from the most serious down (docs/notices.md, section 7); inside one level the order
  // in which the cards were collected stays (the sort is stable).
  notices.sort(
    (a, b) => noticeSeverityRank(a.card.props.level) - noticeSeverityRank(b.card.props.level),
  )

  const reducedMotion = useReducedMotion()
  const [open, setOpen] = React.useState(false)
  const seen = React.useRef<Set<string>>(new Set())
  const urgentKey = notices
    .filter((notice) => noticeIsUrgent(notice.card.props.level))
    .map((notice) => notice.id)
    .join("\u0000")
  React.useEffect(() => {
    const urgent = new Set(urgentKey ? urgentKey.split("\u0000") : [])
    if ([...urgent].some((id) => !seen.current.has(id))) setOpen(true)
    seen.current = urgent
  }, [urgentKey])

  // The panel never grows wider than the note's own area (a narrow column beside the side panels): the
  // bar sits 1rem from its right edge, so the room to the left of that edge is the width minus 2rem.
  const [rootEl, setRootEl] = React.useState<HTMLElement | null>(null)
  const [room, setRoom] = React.useState<number | null>(null)
  React.useEffect(() => {
    const area = rootEl?.closest<HTMLElement>("[data-note-area]")
    if (!area) return
    const measure = () => setRoom(Math.max(0, area.clientWidth - 32))
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(area)
    return () => observer.disconnect()
  }, [rootEl])

  if (notices.length === 0) return null
  const topLevel = mostSeriousNoticeLevel(notices.map((notice) => notice.card.props.level))!
  const top = notices.find((notice) => notice.card.props.level === topLevel)!
  const more = notices.length - 1
  const frameStyle = room === null ? undefined : { maxWidth: `min(${room}px, calc(100vw - 3rem))` }
  const Chevron = open ? ChevronDown : ChevronUp
  const toggle = {
    type: "button" as const,
    "data-testid": "note-notices-strip",
    "data-urgent": noticeIsUrgent(topLevel),
    "data-level": topLevel,
    "aria-label": t("noteNotices.stripLabel", { count: notices.length }),
    title: t(open ? "noteNotices.stripCollapse" : "noteNotices.stripExpand"),
    "aria-expanded": open,
    onClick: () => setOpen((value) => !value),
  }
  return (
    <div
      ref={setRootEl}
      data-testid="note-notices"
      className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-end"
    >
      {/* Its own small element at the right edge of the floating bar of the note, a gap above the bar (it
          never covers the bar's buttons). Folded it is a pill that fits its content; open it is a rounded
          panel: a header row, then the cards, which scroll when there are many. */}
      {open ? (
        <div
          data-testid="note-notices-frame"
          style={frameStyle}
          className="note-notices-panel pointer-events-auto flex w-[min(24rem,calc(100vw-3rem))] max-w-[calc(100vw-3rem)] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
        >
          <button
            {...toggle}
            className="flex h-9 w-full items-center gap-2 px-3 text-left text-[12px] font-medium select-none hover:bg-accent/40"
          >
            <NoticeLevelIcon level={topLevel} className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {t("noteNotices.panelTitle", { count: notices.length })}
            </span>
            <Chevron className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
          <motion.div
            data-testid="note-notices-stack"
            className="flex max-h-[min(55vh,24rem)] flex-col gap-2 overflow-y-auto border-t border-border/60 p-2"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            transition={reducedMotion ? motionTransitions.instant : motionTransitions.panel}
          >
            {notices.map((notice) => notice.card)}
          </motion.div>
        </div>
      ) : (
        <div
          data-testid="note-notices-frame"
          style={frameStyle}
          className="note-notices-pill pointer-events-auto w-fit max-w-[min(20rem,calc(100vw-3rem))] shrink-0 overflow-hidden rounded-full border border-border bg-popover text-popover-foreground shadow-md"
        >
          <button
            {...toggle}
            className="flex h-7 w-full items-center gap-1.5 pr-2 pl-2.5 text-left text-[12px] select-none hover:bg-accent/40"
          >
            <NoticeLevelIcon level={topLevel} className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate font-medium">{top.card.props.title}</span>
            {more > 0 && (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {t("noteNotices.stripMore", { count: more })}
              </span>
            )}
            <Chevron className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}
