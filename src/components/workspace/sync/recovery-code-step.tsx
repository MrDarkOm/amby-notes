import * as React from "react"
import { useTranslation } from "react-i18next"
import { Copy, Printer, Save } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { recoveryFileText } from "@/lib/sync/recovery-file"
import { syncErrorMessage } from "@/lib/sync/sync-errors"
import type { SyncPort } from "@/lib/sync/sync-port"

const PRINTING_CLASS = "sync-printing"

interface RecoveryCodeStepProps {
  port: SyncPort
  host: string
  username: string
  recoveryCode: string
  /** The 1-based positions of the groups to type back. */
  confirmGroups: number[]
  busy: boolean
  error: string | null
  /** The server refused the invitation code: ask for another one. */
  askEnrollCode: boolean
  enrollCode: string
  onEnrollCodeChange: (value: string) => void
  onConfirm: (groups: string[]) => void
  onBack: () => void
}

/**
 * Shows the recovery code once and does not let the person go on until they have typed back some
 * groups of it (docs/sync-plan.md, Р5, О3). There is no "skip": the only ways out are the
 * confirmation and "Back", which forgets the prepared account.
 */
export function RecoveryCodeStep({
  port,
  host,
  username,
  recoveryCode,
  confirmGroups,
  busy,
  error,
  askEnrollCode,
  enrollCode,
  onEnrollCodeChange,
  onConfirm,
  onBack,
}: RecoveryCodeStepProps) {
  const { t } = useTranslation()
  const [typed, setTyped] = React.useState<string[]>(() => confirmGroups.map(() => ""))
  const [savedPath, setSavedPath] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)
  const [fileError, setFileError] = React.useState<string | null>(null)
  const ready =
    typed.every((group) => group.trim() !== "") && (!askEnrollCode || enrollCode.trim() !== "")

  React.useEffect(
    () => () => {
      document.documentElement.classList.remove(PRINTING_CLASS)
    },
    [],
  )

  const save = async () => {
    setFileError(null)
    try {
      const path = await port.saveRecoveryCode(
        recoveryFileText({ host, username, recoveryCode }, t),
      )
      setSavedPath(path)
    } catch (caught) {
      setFileError(syncErrorMessage(caught, t))
    }
  }

  const copy = async () => {
    setFileError(null)
    setCopied(false)
    try {
      await navigator.clipboard.writeText(recoveryCode)
      setCopied(true)
    } catch {
      setFileError(t("sync.recovery.copyFailed"))
    }
  }

  const print = () => {
    // The sheet below is hidden on screen; this class shows it alone while the page is printed.
    const root = document.documentElement
    const finish = () => root.classList.remove(PRINTING_CLASS)
    root.classList.add(PRINTING_CLASS)
    window.addEventListener("afterprint", finish, { once: true })
    void Promise.resolve(window.print()).catch(finish)
  }

  const shownError = error ?? fileError

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[15px] font-semibold">{t("sync.recovery.title")}</h3>
        <p className="mt-1 text-[12px] text-muted-foreground">{t("sync.recovery.intro")}</p>
      </div>

      <div
        data-testid="recovery-code"
        className="select-text break-all rounded-lg border border-border bg-card px-4 py-3 text-center font-mono text-xl tracking-wider"
      >
        {recoveryCode}
      </div>

      <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-[12px] leading-5">
        {t("sync.recovery.warning")}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void save()}>
          <Save />
          {t("sync.recovery.save")}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          <Copy />
          {t("sync.recovery.copy")}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={print}>
          <Printer />
          {t("sync.recovery.print")}
        </Button>
      </div>
      {copied && (
        <p role="status" className="text-[12px] text-muted-foreground">
          {t("sync.recovery.copied")}
        </p>
      )}
      {savedPath && (
        <p className="break-all text-[12px] text-muted-foreground">
          {t("sync.recovery.saved", { path: savedPath })}
        </p>
      )}

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (ready && !busy) onConfirm(typed.map((group) => group.trim()))
        }}
      >
        <p className="text-[12px]">
          {t("sync.recovery.confirmPrompt", {
            first: confirmGroups[0],
            second: confirmGroups[1],
          })}
        </p>
        <div className="flex gap-3">
          {confirmGroups.map((position, index) => (
            <div key={position} className="space-y-1.5">
              <label htmlFor={`sync-group-${position}`} className="text-[12px] font-medium">
                {t("sync.recovery.group", { n: position })}
              </label>
              <Input
                id={`sync-group-${position}`}
                className="w-28 font-mono uppercase"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={8}
                value={typed[index]}
                onChange={(event) =>
                  setTyped((groups) =>
                    groups.map((group, at) => (at === index ? event.target.value : group)),
                  )
                }
              />
            </div>
          ))}
        </div>
        {askEnrollCode && (
          <div className="space-y-1.5">
            <label htmlFor="sync-new-enroll-code" className="text-[12px] font-medium">
              {t("sync.recovery.newEnrollCode")}
            </label>
            <Input
              id="sync-new-enroll-code"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={enrollCode}
              onChange={(event) => onEnrollCodeChange(event.target.value)}
            />
          </div>
        )}
        {shownError && (
          <p role="alert" className="text-[12px] text-destructive">
            {shownError}
          </p>
        )}
        <div data-testid="wizard-actions" className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={!ready || busy}>
            {t("sync.recovery.confirm")}
          </Button>
          <Button type="button" variant="link" size="sm" onClick={onBack} disabled={busy}>
            {t("sync.wizard.actions.back")}
          </Button>
        </div>
      </form>

      <div className="sync-print-sheet" aria-hidden="true">
        <h1>{t("sync.recovery.printTitle")}</h1>
        <p>
          {host} · {username}
        </p>
        <p className="sync-print-code">{recoveryCode}</p>
        <p>{t("sync.recovery.warning")}</p>
      </div>
    </div>
  )
}
