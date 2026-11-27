import * as React from "react"
import { useTranslation } from "react-i18next"
import { Loader2, SquareTerminal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { confirm } from "@/lib/confirm"
import { confirmations } from "@/lib/confirmations"
import { MotionSpinner } from "@/lib/motion"
import {
  CliPathOperationError,
  resolveCliPathPort,
  type CliPathPort,
  type CliPathStatus,
  type McpClientsPort,
} from "@/lib/storage"
import { NoticeLine } from "@/components/workspace/notices/notice-line"
import { Row, SettingsGroup } from "./settings-common"
import { McpClientsSettings } from "./settings-mcp-clients"

/**
 * Settings → General → Command line: puts the bundled `amby` on PATH and takes it off. The question before
 * setting it up names every change on the computer; nothing is shown where the app has no CLI.
 */
export function CliPathSettings({
  port: given,
  vault = null,
  clientsPort,
}: {
  port?: CliPathPort
  vault?: string | null
  clientsPort?: McpClientsPort
}) {
  const { t } = useTranslation()
  const port = React.useMemo(() => given ?? resolveCliPathPort(), [given])
  const [status, setStatus] = React.useState<CliPathStatus | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!port.available) return
    let alive = true
    port.status().then(
      (next) => alive && setStatus(next),
      () => alive && setStatus(null),
    )
    return () => {
      alive = false
    }
  }, [port])

  if (!port.available || !status || status.state === "unavailable") return null

  const run = async (action: () => Promise<CliPathStatus>) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await action())
    } catch (caught) {
      const code = caught instanceof CliPathOperationError ? caught.code : "failed"
      setError(t(`settings.cliPath.errors.${code}`))
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    const location = status.location ?? ""
    const change = status.profile
      ? t("settings.cliPath.changeProfile", { location, profile: status.profile })
      : /Win/i.test(navigator.platform)
        ? t("settings.cliPath.changeWindows", { location })
        : t("settings.cliPath.changeLink", { location })
    if (!(await confirm(confirmations.addCliToPath({ change })))) return
    await run(() => port.install())
  }

  const on = status.state === "on" || status.state === "needsPath"
  const hint =
    status.state === "on"
      ? t("settings.cliPath.on")
      : status.state === "needsPath"
        ? t("settings.cliPath.needsPath", { location: status.location ?? "" })
        : status.state === "taken"
          ? t("settings.cliPath.taken", { location: status.location ?? "" })
          : t("settings.cliPath.off")

  return (
    <SettingsGroup title={t("settings.groups.commandLine")} icon={SquareTerminal}>
      <Row
        label={t("settings.cliPath.label")}
        hint={
          <>
            <span data-testid="cli-path-state" data-state={status.state}>
              {hint}
            </span>
            {error && <NoticeLine role="alert" text={error} />}
          </>
        }
      >
        {status.state !== "taken" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void (on ? run(() => port.remove()) : add())}
          >
            {busy && (
              <MotionSpinner>
                <Loader2 />
              </MotionSpinner>
            )}
            {t(on ? "settings.cliPath.remove" : "settings.cliPath.add")}
          </Button>
        )}
      </Row>
      <McpClientsSettings vault={vault} port={clientsPort} />
    </SettingsGroup>
  )
}
