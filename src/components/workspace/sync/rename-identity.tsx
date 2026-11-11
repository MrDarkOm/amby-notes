import * as React from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { syncErrorMessage } from "@/lib/sync/sync-errors"
import { SyncPortError, type SyncPort } from "@/lib/sync/sync-port"

export type RenameIdentityFormProps = {
  port: SyncPort
  onClose: (changed: boolean) => void
  onConnectionLost?: (error: SyncPortError) => void
} & ({ mode: "account"; username: string } | { mode: "device"; deviceId: string; name: string })

const USERNAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/

function validUsername(value: string, current: string): boolean {
  return value !== current && value.length <= 64 && USERNAME.test(value)
}

function validDeviceName(value: string, current: string): boolean {
  const bytes = new TextEncoder().encode(value).length
  return (
    value !== current &&
    value.length > 0 &&
    bytes <= 64 &&
    ![...value].some((c) => /\p{Cc}/u.test(c))
  )
}

/** A small inline editor for account and device names; passwords never remain after submission. */
export function RenameIdentityForm(props: RenameIdentityFormProps) {
  const { t } = useTranslation()
  const [value, setValue] = React.useState(props.mode === "device" ? props.name : "")
  const [password, setPassword] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const busyRef = React.useRef(false)
  const nameId = React.useId()
  const passwordId = React.useId()
  const current = props.mode === "account" ? props.username : props.name
  const valid =
    props.mode === "account"
      ? validUsername(value, current) && password.length > 0
      : validDeviceName(value.trim(), current)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!valid || busy || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      if (props.mode === "account") await props.port.renameAccount(value, password)
      else await props.port.renameDevice(props.deviceId, value.trim())
      setPassword("")
      setValue("")
      props.onClose(true)
    } catch (caught) {
      if (
        caught instanceof SyncPortError &&
        ["token_revoked", "unauthorized", "not_connected"].includes(caught.code)
      ) {
        setPassword("")
        props.onConnectionLost?.(caught)
      }
      setError(
        caught instanceof SyncPortError && caught.code === "invalid_proof"
          ? t("sync.changePassword.oldWrong")
          : syncErrorMessage(caught, t),
      )
      setPassword("")
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <form className="sync-identity-form" onSubmit={submit}>
      <div className="sync-identity-fields">
        <div>
          <label htmlFor={nameId}>
            {t(props.mode === "account" ? "sync.identity.newUsername" : "sync.identity.deviceName")}
          </label>
          <Input
            id={nameId}
            value={value}
            placeholder={current}
            autoComplete="off"
            autoCapitalize="none"
            onChange={(event) => setValue(event.target.value)}
            disabled={busy}
          />
        </div>
        {props.mode === "account" && (
          <div>
            <label htmlFor={passwordId}>{t("sync.identity.currentPassword")}</label>
            <Input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
            />
          </div>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="sync-identity-actions">
        <Button type="submit" disabled={!valid || busy}>
          {t("sync.identity.save")}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => props.onClose(false)}>
          {t("sync.identity.cancel")}
        </Button>
      </div>
    </form>
  )
}
