import * as React from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, X } from "lucide-react"

import { syncErrorMessage } from "@/lib/sync/sync-errors"
import { resolveSyncPort, type ConflictChoice, type SyncPort } from "@/lib/sync/sync-port"
import { relativeToVault } from "../editor/document-breadcrumbs-utils"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { SyncCompareDialog } from "./sync-compare-dialog"
import { ConflictList } from "./sync-vault-parts"
import { useSyncNoticesStore, type SyncConflict } from "./use-sync-notices-store"

/** How long the notice about a new conflict stays, in milliseconds. */
const NOTICE_MS = 10_000

interface Notice {
  key: number
  conflicts: SyncConflict[]
}

function noteName(path: string): string {
  const file = path.split("/").pop() ?? path
  return file.replace(/\.md$/iu, "")
}

/**
 * Keeps the rest of the application informed about the sync of the open vault (Р7, Р8): the badge
 * with the number of conflicts and their list, the notice about a new conflict, the comparison, and
 * the mark for a note that another computer deleted while it was open. The strips in the notes are
 * [`SyncDocumentBanners`](./sync-document-banners.tsx); both read the same store.
 */
export function SyncNoticesHost({ port: given }: { port?: SyncPort }) {
  const { t } = useTranslation()
  const port = React.useMemo(() => given ?? resolveSyncPort(), [given])
  const vault = useVaultStore((state) => state.vault)
  const conflicts = useSyncNoticesStore((state) => state.conflicts)
  const compareId = useSyncNoticesStore((state) => state.compareId)
  const openCompare = useSyncNoticesStore((state) => state.openCompare)
  const closeCompare = useSyncNoticesStore((state) => state.closeCompare)
  const [listOpen, setListOpen] = React.useState(false)
  const [notices, setNotices] = React.useState<Notice[]>([])
  const [resolving, setResolving] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const seen = React.useRef<Set<string> | null>(null)
  const counter = React.useRef(0)

  React.useEffect(() => {
    // A new vault (or window) starts from its own status.
    seen.current = null
    useSyncNoticesStore.setState({ conflicts: [], remoteDeleted: [], compareId: null })
    let alive = true
    const unlisten: Array<() => void> = []
    const take = (next: SyncConflict[]) => {
      useSyncNoticesStore.getState().setConflicts(next)
      const known = seen.current
      seen.current = new Set(next.map((item) => item.id))
      // The first status is the baseline: a conflict that was already there is not news.
      if (known === null) return
      const fresh = next.filter((item) => !known.has(item.id))
      if (fresh.length > 0) {
        counter.current += 1
        setNotices((list) => [...list, { key: counter.current, conflicts: fresh }])
      }
    }
    port
      .vaultStatus()
      .then((status) => alive && seen.current === null && take(status.conflicts))
      .catch(() => {})
    port
      .onVaultStatus((status) => alive && take(status.conflicts))
      .then((off) => (alive ? unlisten.push(off) : off()))
      .catch(() => {})
    port
      .onRemoteDeleted((paths) => {
        if (!alive) return
        const root = useVaultStore.getState().vault
        if (!root) return
        const open = Object.values(useDocStore.getState().openDocs)
        for (const path of paths) {
          // Only a note that was open gets a message (Р8): an unopened one just goes to the archive.
          if (open.some((doc) => relativeToVault(doc.path, root) === path)) {
            useSyncNoticesStore.getState().markRemoteDeleted(path)
          }
        }
      })
      .then((off) => (alive ? unlisten.push(off) : off()))
      .catch(() => {})
    return () => {
      alive = false
      for (const off of unlisten) off()
    }
  }, [port, vault])

  React.useEffect(() => {
    if (notices.length === 0) return
    const timer = window.setTimeout(() => setNotices((list) => list.slice(1)), NOTICE_MS)
    return () => window.clearTimeout(timer)
  }, [notices])

  React.useEffect(() => {
    if (conflicts.length === 0) setListOpen(false)
  }, [conflicts.length])

  const resolve = (id: string, choice: ConflictChoice) => {
    if (resolving !== null) return
    setResolving(id)
    setError(null)
    port
      .resolveConflict(id, choice)
      .catch((caught) => setError(syncErrorMessage(caught, t)))
      .finally(() => setResolving(null))
  }

  const comparing = conflicts.find((item) => item.id === compareId)

  return (
    <>
      <div className="pointer-events-none fixed bottom-9 right-2 z-50 flex max-w-sm flex-col items-end gap-2">
        {notices.map((notice) => (
          <div
            key={notice.key}
            role="status"
            className="pointer-events-auto flex items-start gap-2 rounded-lg border border-border bg-popover px-3 py-2 text-[12px] text-popover-foreground shadow-lg"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
            <p className="min-w-0 flex-1">
              {notice.conflicts.length === 1
                ? t("sync.notices.newConflict", {
                    name: noteName(notice.conflicts[0]?.originalPath ?? ""),
                  })
                : t("sync.notices.newConflicts", { count: notice.conflicts.length })}
            </p>
            <button
              type="button"
              aria-label={t("sync.notices.dismiss")}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => setNotices((list) => list.filter((item) => item.key !== notice.key))}
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
        {listOpen && conflicts.length > 0 && (
          <div
            data-testid="sync-conflict-popover"
            className="pointer-events-auto max-h-[60vh] w-[min(28rem,calc(100vw-1rem))] space-y-2 overflow-auto rounded-lg border border-border bg-popover p-3 shadow-lg"
          >
            {error && (
              <p role="alert" className="text-[12px] text-destructive">
                {error}
              </p>
            )}
            <ConflictList
              items={conflicts}
              busyId={resolving}
              onResolve={resolve}
              onCompare={(id) => {
                setListOpen(false)
                openCompare(id)
              }}
            />
          </div>
        )}
        {conflicts.length > 0 && (
          <button
            type="button"
            data-testid="sync-conflict-badge"
            aria-label={t("sync.notices.badgeLabel", { count: conflicts.length })}
            title={t("sync.notices.badgeTitle")}
            aria-expanded={listOpen}
            onClick={() => setListOpen((open) => !open)}
            className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 shadow-sm hover:bg-amber-500/25 dark:text-amber-300"
          >
            <AlertTriangle className="size-3" aria-hidden="true" />
            <span>{conflicts.length}</span>
          </button>
        )}
      </div>
      {comparing && vault && (
        <SyncCompareDialog port={port} conflict={comparing} vault={vault} onClose={closeCompare} />
      )}
    </>
  )
}
