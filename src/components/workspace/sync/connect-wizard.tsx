import * as React from "react"
import { errorType, logger } from "@/lib/logger"
import { useTranslation } from "react-i18next"
import { CircleCheck, CircleX, CircleHelp, LoaderCircle } from "lucide-react"

import { AMBY_SERVER_URL, isAmbyServer } from "@/lib/sync/amby-server"
import { AmbySelect } from "@/components/ui/amby-select"
import { MotionSpinner } from "@/lib/motion"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { syncErrorMessage } from "@/lib/sync/sync-errors"
import { SyncPortError } from "@/lib/sync/sync-port"
import type { PreparedAccountView, SyncPort, SyncStatus } from "@/lib/sync/sync-port"
import { openWebAddressInBrowser } from "../tiptap/external-open"
import { NewPasswordFields } from "./password-fields"
import { RecoveryCodeStep } from "./recovery-code-step"
import { useSyncServerCheck } from "./use-sync-server-check"

export interface ConnectWizardProps {
  port: SyncPort
  /** Called once the device is connected. */
  onConnected: (status: SyncStatus) => void
  /** Values to start with (a record whose keys were lost keeps the server and the name). */
  initial?: { url?: string; allowHttp?: boolean; username?: string }
  /** The name offered for this device. */
  defaultDeviceName?: string
}

type Step = "create" | "signIn" | "recover" | "recovery"

const SERVER_GUIDE_URL = "https://github.com/MrDarkOm/AmbyNotes-SelfHost"

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: (id: string) => React.ReactNode
}) {
  const id = React.useId()
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-[12px] font-medium">
        {label}
      </label>
      {children(id)}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function ErrorLine({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-[12px] text-destructive">
      {message}
    </p>
  ) : null
}

/**
 * The wizard was left or restarted and the prepared account (keys made in memory, nothing sent yet)
 * could not be forgotten. Nothing was connected and no note is involved; the next attempt replaces it.
 */
function dropPendingFailed(error: unknown): void {
  logger.debug("sync.cancel_pending_failed", { errorType: errorType(error) })
}

/** One authentication form followed by explicit recovery-code acknowledgement on signup. */
export function ConnectWizard({
  port,
  onConnected,
  initial,
  defaultDeviceName,
}: ConnectWizardProps) {
  const { t } = useTranslation()
  const [step, setStep] = React.useState<Step>("signIn")
  // The Amby server is the default; a record of another server starts on "own server".
  const [own, setOwn] = React.useState(Boolean(initial?.url) && !isAmbyServer(initial?.url))
  const [url, setUrl] = React.useState(initial?.url ?? "")
  const [allowHttp, setAllowHttp] = React.useState(initial?.allowHttp ?? false)
  const [username, setUsername] = React.useState(initial?.username ?? "")
  const [enrollCode, setEnrollCode] = React.useState("")
  const [useInvitation, setUseInvitation] = React.useState(false)
  const [password, setPassword] = React.useState("")
  const [repeat, setRepeat] = React.useState("")
  const [recoveryCode, setRecoveryCode] = React.useState("")
  const [deviceName, setDeviceName] = React.useState(
    defaultDeviceName ??
      t("sync.wizard.defaultDeviceName", {
        platform: typeof navigator === "undefined" ? "" : navigator.platform,
      }),
  )
  const [passwordValid, setPasswordValid] = React.useState(false)
  const [prepared, setPrepared] = React.useState<PreparedAccountView | null>(null)
  // The server refused the invitation code: the person types another one and the same
  // prepared account (same keys, same recovery code) is sent again.
  const [enrollRefused, setEnrollRefused] = React.useState(false)
  const [newEnrollCode, setNewEnrollCode] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const busyRef = React.useRef(false)
  const httpId = React.useId()
  const mounted = React.useRef(true)

  // A prepared account lives in the memory of the application until it is confirmed or
  // forgotten: closing the wizard forgets it.
  const hasPrepared = React.useRef(false)
  React.useEffect(() => {
    hasPrepared.current = prepared !== null
  }, [prepared])
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (hasPrepared.current) void port.cancelPending().catch(dropPendingFailed)
    }
  }, [port])

  /** Runs one request at a time and shows its failure. */
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(syncErrorMessage(caught, t))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const goTo = (next: Step) => {
    setError(null)
    setPassword("")
    setRepeat("")
    setRecoveryCode("")
    setPasswordValid(false)
    setStep(next)
  }

  const chosenUrl = own ? url.trim() : AMBY_SERVER_URL
  const chosenAllowHttp = own && allowHttp
  const health = useSyncServerCheck(port, chosenUrl, chosenAllowHttp, !busy && prepared === null)
  const server = health.server
  const needsEnrollCode = Boolean(server && !server.registrationOpen) || useInvitation
  const target = { url: server?.url ?? chosenUrl, allowHttp: chosenAllowHttp }
  React.useEffect(() => {
    setEnrollCode("")
    setUseInvitation(false)
    setError(null)
  }, [chosenUrl, chosenAllowHttp])

  const prepare = () =>
    run(async () => {
      const view = await port.prepareAccount({
        ...target,
        username: username.trim(),
        enrollCode: needsEnrollCode ? enrollCode.trim() : "",
        password,
        deviceName: deviceName.trim(),
      })
      if (!mounted.current) {
        void port.cancelPending().catch(dropPendingFailed)
        return
      }
      hasPrepared.current = true
      setPassword("")
      setRepeat("")
      setPrepared(view)
      setStep("recovery")
    })

  const confirm = (groups: string[]) =>
    run(async () => {
      if (enrollRefused) await port.setEnrollCode(newEnrollCode.trim())
      let status
      try {
        status = await port.confirmRecoveryCode(groups)
      } catch (caught) {
        const refused =
          caught instanceof SyncPortError &&
          ["invalid_enroll_code", "enroll_code_expired"].includes(caught.code)
        setEnrollRefused(refused)
        setNewEnrollCode("")
        throw caught
      }
      hasPrepared.current = false
      setPrepared(null)
      setEnrollRefused(false)
      onConnected(status)
    })

  // "Back" leaves at once; forgetting the prepared account in the application follows.
  const backFromRecovery = () => {
    hasPrepared.current = false
    setPrepared(null)
    setEnrollRefused(false)
    setError(null)
    setStep("create")
    void port.cancelPending().catch(dropPendingFailed)
  }

  const signIn = () =>
    run(async () => {
      const status = await port.signIn({
        ...target,
        username: username.trim(),
        password,
        deviceName: deviceName.trim(),
      })
      setPassword("")
      onConnected(status)
    })

  const recover = () =>
    run(async () => {
      const status = await port.recover({
        ...target,
        username: username.trim(),
        recoveryCode: recoveryCode.trim(),
        newPassword: password,
        deviceName: deviceName.trim(),
      })
      setPassword("")
      setRepeat("")
      setRecoveryCode("")
      onConnected(status)
    })

  const deviceField = (
    <Field label={t("sync.wizard.fields.deviceName")}>
      {(id) => (
        <Input id={id} value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
      )}
    </Field>
  )

  const usernameField = (
    <Field label={t("sync.wizard.fields.username")}>
      {(id) => (
        <Input
          id={id}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      )}
    </Field>
  )

  const serverError = React.useMemo(
    () => (health.error ? syncErrorMessage(health.error, t) : null),
    [health.error, t],
  )

  if (step === "recovery")
    return prepared ? (
      <div className="sync-auth-recovery">
        <RecoveryCodeStep
          port={port}
          host={server?.host ?? ""}
          username={username.trim()}
          recoveryCode={prepared.recoveryCode}
          confirmGroups={prepared.confirmGroups}
          busy={busy}
          error={error}
          askEnrollCode={enrollRefused}
          enrollCode={newEnrollCode}
          onEnrollCodeChange={setNewEnrollCode}
          onConfirm={(groups) => void confirm(groups)}
          onBack={backFromRecovery}
        />
      </div>
    ) : null

  const filled =
    username.trim() !== "" &&
    deviceName.trim() !== "" &&
    (step === "signIn"
      ? password !== ""
      : step === "create"
        ? (!needsEnrollCode || enrollCode.trim() !== "") && passwordValid
        : recoveryCode.trim() !== "" && passwordValid)
  const canSubmit = health.ready && filled && !busy

  const healthKey = health.checking
    ? "checking"
    : health.ready
      ? "available"
      : serverError
        ? "unavailable"
        : "enterAddress"
  const HealthIcon = health.checking
    ? LoaderCircle
    : health.ready
      ? CircleCheck
      : serverError
        ? CircleX
        : CircleHelp
  const primary = step === "create" ? "register" : step === "recover" ? "recover" : "signIn"

  return (
    <form
      className="sync-auth-card"
      onSubmit={(event) => {
        event.preventDefault()
        if (!canSubmit) return
        if (step === "create") void prepare()
        else if (step === "recover") void recover()
        else void signIn()
      }}
    >
      <div className="sync-auth-tabs" role="group" aria-label={t("sync.wizard.auth.mode")}>
        {(["signIn", "create"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            disabled={busy}
            aria-pressed={step === mode}
            onClick={() => goTo(mode)}
          >
            {t(mode === "signIn" ? "sync.wizard.auth.loginTab" : "sync.wizard.auth.registerTab")}
          </button>
        ))}
      </div>
      {step === "recover" && (
        <h3 className="sync-auth-title">{t("sync.wizard.actions.recover")}</h3>
      )}
      <fieldset disabled={busy} className="sync-auth-fields">
        {usernameField}
        {step === "signIn" ? (
          <Field label={t("sync.wizard.fields.password")}>
            {(id) => (
              <Input
                id={id}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            )}
          </Field>
        ) : (
          <>
            {step === "recover" && (
              <Field label={t("sync.wizard.fields.recoveryCode")}>
                {(id) => (
                  <Input
                    id={id}
                    className="font-mono"
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    value={recoveryCode}
                    onChange={(event) => setRecoveryCode(event.target.value)}
                  />
                )}
              </Field>
            )}
            {step === "create" && server?.registrationOpen && (
              <label className="sync-auth-invitation">
                <input
                  type="checkbox"
                  checked={useInvitation}
                  onChange={(event) => setUseInvitation(event.target.checked)}
                />
                {t("sync.wizard.fields.useInvitation")}
              </label>
            )}
            {step === "create" && needsEnrollCode && (
              <Field
                label={t("sync.wizard.fields.enrollCode")}
                hint={t("sync.wizard.fields.enrollCodeHint")}
              >
                {(id) => (
                  <Input
                    id={id}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    value={enrollCode}
                    onChange={(event) => setEnrollCode(event.target.value)}
                  />
                )}
              </Field>
            )}
            <NewPasswordFields
              port={port}
              username={username.trim()}
              passwordLabel={t(
                step === "recover"
                  ? "sync.wizard.fields.newPassword"
                  : "sync.wizard.fields.password",
              )}
              repeatLabel={t(
                step === "recover"
                  ? "sync.wizard.fields.repeatNewPassword"
                  : "sync.wizard.fields.repeatPassword",
              )}
              password={password}
              repeat={repeat}
              onPasswordChange={setPassword}
              onRepeatChange={setRepeat}
              onValidChange={setPasswordValid}
            />
          </>
        )}
        <details className="sync-auth-device">
          <summary>{t("sync.wizard.fields.deviceName")}</summary>
          {deviceField}
        </details>
      </fieldset>
      {step === "signIn" && (
        <button
          type="button"
          className="sync-auth-link"
          disabled={busy}
          onClick={() => goTo("recover")}
        >
          {t("sync.wizard.choice.forgot")}
        </button>
      )}
      {!serverError && <ErrorLine message={error} />}
      <div data-testid="wizard-actions" className="sync-auth-submit">
        <Button type="submit" disabled={!canSubmit} aria-busy={busy}>
          {busy && (
            <MotionSpinner>
              <LoaderCircle className="size-4" />
            </MotionSpinner>
          )}
          {t(`sync.wizard.actions.${primary}`)}
        </Button>
      </div>
      {step === "recover" && (
        <button
          type="button"
          className="sync-auth-link"
          disabled={busy}
          onClick={() => goTo("signIn")}
        >
          {t("sync.wizard.actions.back")}
        </button>
      )}
      <fieldset disabled={busy} className="sync-auth-server">
        <div className="sync-auth-server-row">
          <Field label={t("sync.wizard.server.choiceLabel")}>
            {(id) => (
              <AmbySelect
                id={id}
                aria-label={t("sync.wizard.server.choiceLabel")}
                value={own ? "own" : "amby"}
                disabled={busy}
                onValueChange={(value) => setOwn(value === "own")}
                options={[
                  { value: "amby", label: t("sync.wizard.server.amby") },
                  { value: "own", label: t("sync.wizard.server.own") },
                ]}
              />
            )}
          </Field>
          <span
            className="sync-auth-health"
            data-state={healthKey}
            role="status"
            title={t(`sync.wizard.server.${healthKey}`)}
          >
            {health.checking ? (
              <MotionSpinner>
                <HealthIcon className="size-4" />
              </MotionSpinner>
            ) : (
              <HealthIcon className="size-4" aria-hidden="true" />
            )}
            <span>{t(`sync.wizard.server.${healthKey}`)}</span>
          </span>
        </div>
        {own && (
          <>
            <Field label={t("sync.wizard.server.address")}>
              {(id) => (
                <Input
                  id={id}
                  inputMode="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoComplete="url"
                  placeholder={t("sync.wizard.server.placeholder")}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              )}
            </Field>
            <div className="sync-auth-http">
              <Switch
                id={httpId}
                checked={allowHttp}
                onCheckedChange={setAllowHttp}
                aria-label={t("sync.wizard.server.localNetwork")}
              />
              <label htmlFor={httpId}>{t("sync.wizard.server.localNetwork")}</label>
            </div>
            {allowHttp && (
              <p className="sync-auth-http-warning">
                {t("sync.wizard.server.localNetworkWarning")}
              </p>
            )}
            <a
              className="sync-auth-link"
              href={SERVER_GUIDE_URL}
              onClick={(event) => {
                event.preventDefault()
                void openWebAddressInBrowser(SERVER_GUIDE_URL)
              }}
            >
              {t("sync.wizard.server.guide")}
            </a>
          </>
        )}
        {serverError && <p className="sync-auth-server-error">{serverError}</p>}
      </fieldset>
    </form>
  )
}
