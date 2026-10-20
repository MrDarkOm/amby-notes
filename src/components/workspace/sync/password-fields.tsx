import * as React from "react"
import { useTranslation } from "react-i18next"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { PasswordCheck, SyncPort } from "@/lib/sync/sync-port"
import { usePasswordVerdict } from "./use-password-verdict"

const STRENGTH_BAR = [
  "w-1/5 bg-destructive",
  "w-2/5 bg-destructive",
  "w-3/5 bg-destructive",
  "w-4/5 bg-primary",
  "w-full bg-primary",
]

/** The strength of a password in words, with the main weakness and one piece of advice. */
export function PasswordStrength({ check }: { check: PasswordCheck }) {
  const { t, i18n } = useTranslation()
  const label = check.tooShort
    ? t("sync.password.tooShort")
    : check.score <= 2
      ? t("sync.password.weak")
      : check.score === 3
        ? t("sync.password.good")
        : t("sync.password.great")
  const hint = (kind: "warnings" | "suggestions", name: string | undefined) => {
    const key = `sync.password.${kind}.${name}`
    return name && i18n.exists(key) ? t(key) : null
  }
  const warning = check.ok ? null : hint("warnings", check.warning ?? undefined)
  const advice = check.ok ? null : hint("suggestions", check.suggestions[0])
  return (
    <div role="status" data-testid="password-strength" className="space-y-1">
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", STRENGTH_BAR[check.tooShort ? 0 : check.score])}
        />
      </div>
      <p className={cn("text-[12px]", check.ok ? "text-muted-foreground" : "text-destructive")}>
        {label}
      </p>
      {(warning || advice) && (
        <p className="text-[11px] text-muted-foreground">
          {[warning, advice].filter(Boolean).join(" ")}
        </p>
      )}
    </div>
  )
}

interface NewPasswordFieldsProps {
  port: SyncPort
  username: string
  passwordLabel: string
  repeatLabel: string
  password: string
  repeat: string
  onPasswordChange: (value: string) => void
  onRepeatChange: (value: string) => void
  /** Reports whether the pair is acceptable: strong enough and typed twice the same. */
  onValidChange: (valid: boolean) => void
}

/** A new password typed twice, with its strength. */
export function NewPasswordFields({
  port,
  username,
  passwordLabel,
  repeatLabel,
  password,
  repeat,
  onPasswordChange,
  onRepeatChange,
  onValidChange,
}: NewPasswordFieldsProps) {
  const { t } = useTranslation()
  const verdict = usePasswordVerdict(port, password, username)
  const same = password === repeat
  const valid = Boolean(verdict?.ok) && same && password.length > 0
  React.useEffect(() => onValidChange(valid), [onValidChange, valid])
  const passwordId = React.useId()
  const repeatId = React.useId()
  return (
    <>
      <div className="space-y-1.5">
        <label htmlFor={passwordId} className="text-[12px] font-medium">
          {passwordLabel}
        </label>
        <Input
          id={passwordId}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => onPasswordChange(event.target.value)}
        />
        {verdict && <PasswordStrength check={verdict} />}
      </div>
      <div className="space-y-1.5">
        <label htmlFor={repeatId} className="text-[12px] font-medium">
          {repeatLabel}
        </label>
        <Input
          id={repeatId}
          type="password"
          autoComplete="new-password"
          value={repeat}
          onChange={(event) => onRepeatChange(event.target.value)}
        />
        {repeat !== "" && !same && (
          <p className="text-[12px] text-destructive">{t("sync.wizard.passwordsDiffer")}</p>
        )}
      </div>
    </>
  )
}
