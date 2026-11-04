import * as React from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { syncErrorMessage } from "@/lib/sync/sync-errors"
import { SyncPortError, type SyncPort } from "@/lib/sync/sync-port"
import { NewPasswordFields } from "./password-fields"

interface ChangePasswordFormProps {
  port: SyncPort
  username: string
  /** Called with `true` when the password was changed, `false` on cancel. */
  onClose: (changed: boolean) => void
}

/** The form of "Change password" (docs/sync-plan.md, Р5): the old password is needed. */
export function ChangePasswordForm({ port, username, onClose }: ChangePasswordFormProps) {
  const { t } = useTranslation()
  const [oldPassword, setOldPassword] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [repeat, setRepeat] = React.useState("")
  const [valid, setValid] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const working = React.useRef(false)
  const oldId = React.useId()

  const submit = async () => {
    if (working.current || !valid || oldPassword === "") return
    working.current = true
    setBusy(true)
    setError(null)
    try {
      await port.changePassword(oldPassword, password)
      onClose(true)
    } catch (caught) {
      setError(
        caught instanceof SyncPortError && caught.code === "invalid_proof"
          ? t("sync.changePassword.oldWrong")
          : syncErrorMessage(caught, t),
      )
      working.current = false
      setBusy(false)
    }
  }

  return (
    <form
      className="sync-section space-y-3"
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
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => onClose(false)}
        >
          {t("sync.changePassword.cancel")}
        </Button>
      </div>
    </form>
  )
}
