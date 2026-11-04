import * as React from "react"
import { useTranslation } from "react-i18next"
import { KeyRound } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { syncErrorMessage } from "@/lib/sync/sync-errors"
import { SyncPortError, type SyncPort } from "@/lib/sync/sync-port"
import { NewPasswordFields } from "./password-fields"

interface ChangePasswordProps {
  port: SyncPort
  username: string
}

/** "Change password" of the connected account (docs/sync-plan.md, Р5): the old password is needed. */
export function ChangePassword({ port, username }: ChangePasswordProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [oldPassword, setOldPassword] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [repeat, setRepeat] = React.useState("")
  const [valid, setValid] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [done, setDone] = React.useState(false)
  const working = React.useRef(false)
  const oldId = React.useId()

  const close = () => {
    setOpen(false)
    setOldPassword("")
    setPassword("")
    setRepeat("")
    setError(null)
  }

  const submit = async () => {
    if (working.current || !valid || oldPassword === "") return
    working.current = true
    setBusy(true)
    setError(null)
    try {
      await port.changePassword(oldPassword, password)
      close()
      setDone(true)
    } catch (caught) {
      setError(
        caught instanceof SyncPortError && caught.code === "invalid_proof"
          ? t("sync.changePassword.oldWrong")
          : syncErrorMessage(caught, t),
      )
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  return (
    <section className="sync-section space-y-3">
      <h3 className="sync-section-title">
        <KeyRound className="size-4" aria-hidden="true" />
        {t("sync.changePassword.open")}
      </h3>
      {done && (
        <p role="status" className="text-[12px] text-muted-foreground">
          {t("sync.changePassword.done")}
        </p>
      )}
      {!open ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setDone(false)
            setOpen(true)
          }}
        >
          {t("sync.changePassword.open")}
        </Button>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <p className="text-[12px] text-muted-foreground">{t("sync.changePassword.hint")}</p>
          <div className="space-y-1.5">
            <label htmlFor={oldId} className="text-[12px] font-medium">
              {t("sync.changePassword.oldPassword")}
            </label>
            <Input
              id={oldId}
              type="password"
              autoComplete="current-password"
              value={oldPassword}
              onChange={(event) => setOldPassword(event.target.value)}
            />
          </div>
          <NewPasswordFields
            port={port}
            username={username}
            passwordLabel={t("sync.changePassword.newPassword")}
            repeatLabel={t("sync.changePassword.repeatPassword")}
            password={password}
            repeat={repeat}
            onPasswordChange={setPassword}
            onRepeatChange={setRepeat}
            onValidChange={setValid}
          />
          {error && (
            <p role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !valid || oldPassword === ""}>
              {t("sync.changePassword.submit")}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={close}>
              {t("sync.changePassword.cancel")}
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}
