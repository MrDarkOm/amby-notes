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

/**
 * The strength of a password in one line: what is still missing, or that it is too simple or
 * known, or how good it is. The block keeps its height so that the form below does not move.
 */
export function PasswordStrength({ check }: { check: PasswordCheck }) {
  const { t } = useTranslation()
  const label =
    check.missing.length > 0
      ? t("sync.password.needs", {
          items: check.missing.map((name) => t(`sync.password.missing.${name}`)).join(", "),
        })
      : !check.ok
        ? t("sync.password.weak")
        : check.score === 3
          ? t("sync.password.good")
          : t("sync.password.great")
  return (
    <div role="status" data-testid="password-strength" className="min-h-[1.75rem] space-y-1">
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] motion-reduce:transition-none",
            STRENGTH_BAR[check.tooShort ? 0 : check.score],
          )}
        />
      </div>
      <p className={cn("text-[12px]", check.ok ? "text-muted-foreground" : "text-destructive")}>
        {label}
      </p>
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
  const { check, shown } = usePasswordVerdict(port, password, username)
  const same = password === repeat
  const valid = Boolean(check?.ok) && same && password.length > 0
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
        {shown && <PasswordStrength check={shown} />}
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
