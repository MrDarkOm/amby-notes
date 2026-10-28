import * as React from "react"
import { useTranslation } from "react-i18next"
import { ArchiveRestore, CircleCheck, RefreshCw, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { MotionSpinner } from "@/lib/motion"
import {
  resolveBackupPort,
  BackupOperationError,
  type BackupPort,
  type BackupCatalog,
  type BackupInfo,
} from "@/lib/storage"
import { formatSize } from "@/lib/sync/format-size"
import { requestOpenRestoredVault } from "./backup-navigation"

interface Props {
  vault: string | null
  port?: BackupPort
}
const knownCodes = [
  "backup_invalid",
  "backup_failed",
  "backup_changed",
  "backup_unsafe_entry",
  "backup_unsafe_destination",
  "backup_restore_incomplete",
  "backup_restore_changed",
  "backup_stale_vault",
  "no_vault_open",
  "unavailable",
] as const

/** A catalog is bound to the backend activation it came from. No renderer filesystem I/O. */
export function BackupPanel({ vault, port: given }: Props) {
  const { t, i18n } = useTranslation()
  const port = React.useMemo(() => given ?? resolveBackupPort(), [given])
  const [catalog, setCatalog] = React.useState<BackupCatalog | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [selected, setSelected] = React.useState<BackupInfo | null>(null)
  const [restored, setRestored] = React.useState<string | null>(null)
  const working = React.useRef(false)
  const scope = React.useRef(vault)
  scope.current = vault
  const request = React.useRef(0)
  const errorText = React.useCallback(
    (caught: unknown) => {
      const code = caught instanceof BackupOperationError ? caught.code : "backup_failed"
      return t(
        `backups.errors.${knownCodes.includes(code as (typeof knownCodes)[number]) ? code : "backup_failed"}`,
      )
    },
    [t],
  )
  const load = React.useCallback(async () => {
    if (!vault || !port.available || working.current) return
    const token = ++request.current
    setBusy("list")
    setError(null)
    try {
      const next = await port.list(vault)
      if (scope.current === vault && request.current === token) {
        if (next.vault !== vault) throw new BackupOperationError("backup_stale_vault")
        setCatalog(next)
      }
    } catch (caught) {
      if (scope.current === vault && request.current === token) setError(errorText(caught))
    } finally {
      if (scope.current === vault && request.current === token) setBusy(null)
    }
  }, [vault, port, errorText])
  React.useEffect(() => {
    setCatalog(null)
    setBusy(null)
    setError(null)
    setSelected(null)
    setRestored(null)
    void load()
    const pendingRequest = request
    return () => {
      pendingRequest.current++
    }
  }, [load])

  const reload = React.useRef(load)
  reload.current = load

  const act = async (name: string, action: (current: BackupCatalog) => Promise<void>) => {
    if (working.current || !catalog || catalog.vault !== vault) return
    working.current = true
    setBusy(name)
    setError(null)
    try {
      await action(catalog)
    } catch (caught) {
      if (scope.current === vault) setError(errorText(caught))
    } finally {
      working.current = false
      if (scope.current === vault) setBusy(null)
      else void reload.current()
    }
  }
  const verify = (item: BackupInfo) =>
    void act(`verify:${item.id}`, async (current) => {
      try {
        const checked = await port.verify(current.generation, item.id)
        if (scope.current === vault)
          setCatalog(
            (previous) =>
              previous && {
                ...previous,
                backups: previous.backups.map((row) => (row.id === checked.id ? checked : row)),
              },
          )
      } catch (caught) {
        if (
          scope.current === vault &&
          caught instanceof BackupOperationError &&
          ["backup_invalid", "backup_unsafe_entry"].includes(caught.code)
        )
          setCatalog(
            (previous) =>
              previous && {
                ...previous,
                backups: previous.backups.map((row) =>
                  row.id === item.id ? { ...row, status: "damaged" } : row,
                ),
              },
          )
        throw caught
      }
    })
  const restore = () => {
    if (!selected) return
    const item = selected
    setSelected(null)
    void act(`restore:${item.id}`, async (current) => {
      const result = await port.restore(current.generation, item.id, crypto.randomUUID())
      if (scope.current === vault && result) setRestored(result.path)
    })
  }
  const date = (ms: number) => new Date(ms).toLocaleString(i18n.language)

  return (
    <div className="backup-panel" data-testid="backup-panel">
      <div className="backup-intro">
        <p>{t("backups.intro")}</p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title={t("backups.refresh")}
          aria-label={t("backups.refresh")}
          disabled={busy !== null || !vault || !port.available}
          onClick={() => void load()}
        >
          {busy === "list" ? (
            <MotionSpinner>
              <RefreshCw />
            </MotionSpinner>
          ) : (
            <RefreshCw />
          )}
        </Button>
      </div>
      {!port.available ? (
        <p className="backup-caption">{t("backups.errors.unavailable")}</p>
      ) : !vault ? (
        <p className="backup-caption">{t("backups.errors.no_vault_open")}</p>
      ) : null}
      {error && (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      )}
      {catalog?.backups.length === 0 && <p className="backup-caption">{t("backups.empty")}</p>}
      {catalog && catalog.vault === vault && catalog.backups.length > 0 && (
        <ul className="backup-list">
          {catalog.backups.map((item) => (
            <li key={item.id} className="backup-row">
              <span className="backup-symbol">
                <ArchiveRestore className="size-4" aria-hidden="true" />
              </span>
              <div className="backup-row-text">
                <h4>{date(item.createdMs)}</h4>
                <p>
                  {t("backups.beforeSync")} ·{" "}
                  {["missing", "damaged", "incomplete"].includes(item.status)
                    ? t("backups.sizeUnknown")
                    : `${formatSize(item.bytes, i18n.language)} · ${t("backups.files", { count: item.files })}`}
                </p>
                <span className="backup-condition" data-state={item.status}>
                  {item.status === "verified" && (
                    <CircleCheck className="size-3" aria-hidden="true" />
                  )}
                  {t(`backups.status.${item.status}`)}
                </span>
              </div>
              <div className="backup-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => verify(item)}
                >
                  {busy === `verify:${item.id}` && (
                    <MotionSpinner>
                      <RefreshCw className="size-3.5" />
                    </MotionSpinner>
                  )}
                  {t(busy === `verify:${item.id}` ? "backups.verifying" : "backups.verify")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    busy !== null || ["damaged", "incomplete", "missing"].includes(item.status)
                  }
                  onClick={() => setSelected(item)}
                >
                  {busy === `restore:${item.id}` && (
                    <MotionSpinner>
                      <RefreshCw className="size-3.5" />
                    </MotionSpinner>
                  )}
                  {t(busy === `restore:${item.id}` ? "backups.restoring" : "backups.restore")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {restored && (
        <div className="backup-result" role="status">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4" />
            <strong>{t("backups.restored")}</strong>
          </div>
          <p>{t("backups.restoredHint")}</p>
          <code>{restored}</code>
          <Button
            type="button"
            size="sm"
            onClick={() =>
              void requestOpenRestoredVault(restored).catch((caught: unknown) =>
                setError(errorText(caught)),
              )
            }
          >
            {t("backups.open")}
          </Button>
        </div>
      )}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("backups.confirmTitle")}</DialogTitle>
            <DialogDescription>{t("backups.confirmHint")}</DialogDescription>
          </DialogHeader>
          {selected && (
            <p className="text-[12px] text-muted-foreground">{date(selected.createdMs)}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={restore}>
              {t("backups.chooseDestination")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setSelected(null)}>
              {t("backups.cancel")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
