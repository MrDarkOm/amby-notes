import * as React from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import type { SyncPort } from "@/lib/sync/sync-port"

interface DisconnectOthersProps {
  port: SyncPort
  /** The question is over: the devices were disconnected or kept; the list is read again. */
  onDone: () => void
}

/**
 * After a password change (docs/sync-plan.md, appendix Ц, Ц5): "Disconnect the other devices?" with their
 * number. Disconnecting revokes every device except this one; the ones that could not be reached are counted
 * and can be tried again. Without other devices nothing is asked.
 */
export function DisconnectOthers({ port, onDone }: DisconnectOthersProps) {
  const { t } = useTranslation()
  const [others, setOthers] = React.useState<string[] | null>(null)
  const [failed, setFailed] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState(false)
  const [closed, setClosed] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    port
      .listDevices()
      .then((devices) => {
        if (alive) setOthers(devices.filter((device) => !device.current).map((d) => d.deviceId))
      })
      .catch(() => {
        if (alive) setOthers([])
      })
    return () => {
      alive = false
    }
  }, [port])

  if (closed || others === null || others.length === 0) return null

  const disconnect = async (ids: string[]) => {
    setBusy(true)
    const left: string[] = []
    for (const id of ids) {
      try {
        await port.disconnectDevice(id)
      } catch {
        left.push(id)
      }
    }
    setBusy(false)
    setFailed(left)
    if (left.length === 0) {
      setClosed(true)
      onDone()
    }
  }

  return (
    <div data-testid="disconnect-others" className="sync-section space-y-2">
      <p className="text-[13px] font-medium">{t("sync.changePassword.others.title")}</p>
      <p className="text-[12px] text-muted-foreground">
        {t("sync.changePassword.others.line", { count: others.length })}
      </p>
      {failed.length > 0 ? (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-[12px] text-destructive">
            {t("sync.changePassword.others.failed", { count: failed.length })}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void disconnect(failed)}
          >
            {t("sync.changePassword.others.retry")}
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => void disconnect(others)}
          >
            {t("sync.changePassword.others.disconnect")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setClosed(true)}
          >
            {t("sync.changePassword.others.keep")}
          </Button>
        </div>
      )}
    </div>
  )
}
