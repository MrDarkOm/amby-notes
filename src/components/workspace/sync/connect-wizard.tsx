import * as React from "react"
import { useTranslation } from "react-i18next"
import { UserRound, Server, CircleCheck } from "lucide-react"

import { AMBY_SERVER_URL, isAmbyServer } from "@/lib/sync/amby-server"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { syncErrorMessage } from "@/lib/sync/sync-errors"
import { SyncPortError } from "@/lib/sync/sync-port"
import type { PreparedAccountView, ServerCheck, SyncPort, SyncStatus } from "@/lib/sync/sync-port"
import { openWebAddressInBrowser } from "../tiptap/external-open"
import { NewPasswordFields } from "./password-fields"
import { RecoveryCodeStep } from "./recovery-code-step"

export interface ConnectWizardProps {
  port: SyncPort
  /** Called once the device is connected. */
  onConnected: (status: SyncStatus) => void
  /** Values to start with (a record whose keys were lost keeps the server and the name). */
  initial?: { url?: string; allowHttp?: boolean; username?: string }
  /** The name offered for this device. */
  defaultDeviceName?: string
}

type Step = "server" | "choice" | "create" | "signIn" | "recover" | "recovery"

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

/** The connect wizard: address → create an account / sign in / recover → password → code. */
export function ConnectWizard({
  port,
  onConnected,
  initial,
  defaultDeviceName,
}: ConnectWizardProps) {
  const { t } = useTranslation()
  const [step, setStep] = React.useState<Step>("server")
  const [accountMode, setAccountMode] = React.useState<"create" | "signIn" | "recover" | null>(null)
  // The Amby server is the default; a record of another server starts on "own server".
  const [own, setOwn] = React.useState(Boolean(initial?.url) && !isAmbyServer(initial?.url))
  const [url, setUrl] = React.useState(initial?.url ?? "")
  const [allowHttp, setAllowHttp] = React.useState(initial?.allowHttp ?? false)
  const [server, setServer] = React.useState<ServerCheck | null>(null)
  const [username, setUsername] = React.useState(initial?.username ?? "")
  const [enrollCode, setEnrollCode] = React.useState("")
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

  // A prepared account lives in the memory of the application until it is confirmed or
  // forgotten: closing the wizard forgets it.
  const hasPrepared = React.useRef(false)
  React.useEffect(() => {
    hasPrepared.current = prepared !== null
  }, [prepared])
  React.useEffect(
    () => () => {
      if (hasPrepared.current) void port.cancelPending().catch(() => {})
    },
    [port],
  )

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
    setStep(next)
  }

  const chosenUrl = own ? url.trim() : AMBY_SERVER_URL
  const chosenAllowHttp = own && allowHttp
  const target = { url: server?.url ?? chosenUrl, allowHttp: chosenAllowHttp }

  const checkServer = () =>
    run(async () => {
      const found = await port.checkServer({ url: chosenUrl, allowHttp: chosenAllowHttp })
      setServer(found)
      setStep(accountMode ?? "choice")
    })

  const prepare = () =>
    run(async () => {
      const view = await port.prepareAccount({
        ...target,
        username: username.trim(),
        enrollCode: enrollCode.trim(),
        password,
        deviceName: deviceName.trim(),
      })
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
    void port.cancelPending().catch(() => {})
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

  const form = (children: React.ReactNode, submit: () => void) => (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {children}
    </form>
  )

  const backButton = (to: Step) => (
    <Button type="button" variant="link" size="sm" disabled={busy} onClick={() => goTo(to)}>
      {t("sync.wizard.actions.back")}
    </Button>
  )

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

  const accountChoice = (
    <section className="sync-connect-account">
      <div className="sync-connect-heading">
        <span className="sync-connect-symbol">
          <UserRound className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h3>{t("sync.layout.accountTitle")}</h3>
          <p>{t("sync.layout.accountHint")}</p>
        </div>
      </div>
      <div
        data-testid={step === "choice" ? "wizard-actions" : undefined}
        className="sync-connect-options"
      >
        {(["create", "signIn", "recover"] as const).map((mode) => (
          <Button
            key={mode}
            type="button"
            size="sm"
            variant={accountMode === mode ? "default" : mode === "recover" ? "link" : "outline"}
            aria-pressed={accountMode === mode}
            disabled={busy}
            onClick={() => {
              if (step === "server") setAccountMode(mode)
              else goTo(mode)
            }}
          >
            {t(
              mode === "create"
                ? "sync.wizard.choice.create"
                : mode === "signIn"
                  ? "sync.wizard.choice.signIn"
                  : "sync.wizard.choice.forgot",
            )}
          </Button>
        ))}
        {step === "choice" && backButton("server")}
      </div>
    </section>
  )

  if (step === "server") {
    const serverForm = form(
      <>
        <fieldset className="space-y-2">
          <legend className="sync-connect-server-title">
            <Server className="size-4" aria-hidden="true" />
            {t("sync.wizard.server.choiceLabel")}
          </legend>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="radio" name="sync-server" checked={!own} onChange={() => setOwn(false)} />
            {t("sync.wizard.server.amby")}
          </label>
          {!own && (
            <p className="pl-6 text-[12px] text-muted-foreground">
              {t("sync.wizard.server.ambyHint")}
            </p>
          )}
          <label className="flex items-center gap-2 text-[13px]">
            <input type="radio" name="sync-server" checked={own} onChange={() => setOwn(true)} />
            {t("sync.wizard.server.own")}
          </label>
        </fieldset>
        {own && (
          <>
            <Field label={t("sync.wizard.server.address")}>
              {(id) => (
                <Input
                  id={id}
                  inputMode="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={t("sync.wizard.server.placeholder")}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              )}
            </Field>
            <div className="flex items-center gap-2">
              <Switch
                id="sync-allow-http"
                checked={allowHttp}
                onCheckedChange={setAllowHttp}
                aria-label={t("sync.wizard.server.localNetwork")}
              />
              <label htmlFor="sync-allow-http" className="text-[12px]">
                {t("sync.wizard.server.localNetwork")}
              </label>
            </div>
            {allowHttp && (
              <p className="text-[12px] text-destructive">
                {t("sync.wizard.server.localNetworkWarning")}
              </p>
            )}
          </>
        )}
        <ErrorLine message={error} />
        <div data-testid="wizard-actions" className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={busy || (own && url.trim() === "")}>
            {busy ? t("sync.wizard.server.checking") : t("sync.wizard.server.check")}
          </Button>
          {own && (
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => void openWebAddressInBrowser(SERVER_GUIDE_URL)}
            >
              {t("sync.wizard.server.guide")}
            </Button>
          )}
        </div>
      </>,
      () => void checkServer(),
    )
    return (
      <div className="sync-connect-stack">
        {accountChoice}
        <section className="sync-connect-server">{serverForm}</section>
      </div>
    )
  }

  if (step === "choice") {
    return (
      <div className="sync-connect-stack">
        {accountChoice}
        <section className="sync-connect-server sync-connect-verified">
          <CircleCheck className="size-5" aria-hidden="true" />
          <div>
            <h3>{t("sync.wizard.server.choiceLabel")}</h3>
            <p className="text-[12px] text-muted-foreground">
              {t("sync.wizard.server.found", { version: server?.serverVersion ?? "" })}
            </p>
            <p className="text-[11px] text-muted-foreground">{server?.host}</p>
          </div>
        </section>
      </div>
    )
  }

  if (step === "create") {
    const filled = username.trim() !== "" && enrollCode.trim() !== "" && deviceName.trim() !== ""
    return form(
      <>
        {usernameField}
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
        <NewPasswordFields
          port={port}
          username={username.trim()}
          passwordLabel={t("sync.wizard.fields.password")}
          repeatLabel={t("sync.wizard.fields.repeatPassword")}
          password={password}
          repeat={repeat}
          onPasswordChange={setPassword}
          onRepeatChange={setRepeat}
          onValidChange={setPasswordValid}
        />
        {deviceField}
        <ErrorLine message={error} />
        <div data-testid="wizard-actions" className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={busy || !filled || !passwordValid}>
            {t("sync.wizard.actions.continue")}
          </Button>
          {backButton("choice")}
        </div>
      </>,
      () => {
        if (filled && passwordValid) void prepare()
      },
    )
  }

  if (step === "signIn") {
    const filled = username.trim() !== "" && password !== "" && deviceName.trim() !== ""
    return form(
      <>
        {usernameField}
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
        {deviceField}
        <ErrorLine message={error} />
        <div data-testid="wizard-actions" className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={busy || !filled}>
            {t("sync.wizard.actions.signIn")}
          </Button>
          {backButton("choice")}
        </div>
      </>,
      () => {
        if (filled) void signIn()
      },
    )
  }

  if (step === "recover") {
    const filled = username.trim() !== "" && recoveryCode.trim() !== "" && deviceName.trim() !== ""
    return form(
      <>
        {usernameField}
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
        <NewPasswordFields
          port={port}
          username={username.trim()}
          passwordLabel={t("sync.wizard.fields.newPassword")}
          repeatLabel={t("sync.wizard.fields.repeatNewPassword")}
          password={password}
          repeat={repeat}
          onPasswordChange={setPassword}
          onRepeatChange={setRepeat}
          onValidChange={setPasswordValid}
        />
        {deviceField}
        <ErrorLine message={error} />
        <div data-testid="wizard-actions" className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={busy || !filled || !passwordValid}>
            {t("sync.wizard.actions.recover")}
          </Button>
          {backButton("choice")}
        </div>
      </>,
      () => {
        if (filled && passwordValid) void recover()
      },
    )
  }

  // step === "recovery"
  return prepared ? (
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
  ) : null
}
