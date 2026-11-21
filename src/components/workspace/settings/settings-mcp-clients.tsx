import * as React from "react"
import { useTranslation } from "react-i18next"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AmbySelect } from "@/components/ui/amby-select"
import { confirm } from "@/lib/confirm"
import { confirmations } from "@/lib/confirmations"
import { MotionSpinner } from "@/lib/motion"
import {
  McpClientOperationError,
  resolveMcpClientsPort,
  type McpClient,
  type McpClientStatus,
  type McpClientsPort,
} from "@/lib/storage"
import { NoticeLine } from "@/components/workspace/notices/notice-line"
import { Row } from "./settings-common"

/** Product names; they are not translated. */
const CLIENT_NAMES: Record<McpClient, string> = {
  claudeCode: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
}

/**
 * Rows of Settings → General → Command line: connect the open vault to an AI client as the `amby`
 * MCP server, read only or with writes. Amby asks each client through its own command or install
 * window; the question before names the vault, the access and how.
 */
export function McpClientsSettings({
  vault,
  port: given,
}: {
  vault: string | null
  port?: McpClientsPort
}) {
  const { t } = useTranslation()
  const port = React.useMemo(() => given ?? resolveMcpClientsPort(), [given])
  const [clients, setClients] = React.useState<McpClientStatus[] | null>(null)
  const [write, setWrite] = React.useState(false)
  const [busy, setBusy] = React.useState<McpClient | null>(null)
  const [error, setError] = React.useState<{ client: McpClient; text: string } | null>(null)
  const [asked, setAsked] = React.useState<McpClient | null>(null)

  React.useEffect(() => {
    if (!port.available) return
    let alive = true
    port.status().then(
      (next) => alive && setClients(next),
      () => alive && setClients(null),
    )
    return () => {
      alive = false
    }
  }, [port])

  if (!port.available || !clients) return null

  const replace = (next: McpClientStatus) =>
    setClients((current) =>
      (current ?? []).map((item) => (item.client === next.client ? next : item)),
    )

  const run = async (client: McpClient, action: () => Promise<McpClientStatus>) => {
    setBusy(client)
    setError(null)
    try {
      replace(await action())
      return true
    } catch (caught) {
      const code = caught instanceof McpClientOperationError ? caught.code : "failed"
      setError({ client, text: t(`settings.mcpClients.errors.${code}`) })
      return false
    } finally {
      setBusy(null)
    }
  }

  const connect = async (client: McpClient) => {
    if (!vault) {
      setError({ client, text: t("settings.mcpClients.errors.noVault") })
      return
    }
    const question = confirmations.connectMcpClient({
      client: CLIENT_NAMES[client],
      vault,
      access: t(
        write ? "settings.mcpClients.readWrite" : "settings.mcpClients.readOnly",
      ).toLowerCase(),
      how: t(`settings.mcpClients.how.${client}`),
    })
    if (!(await confirm(question))) return
    if (await run(client, () => port.connect(client, vault, write)))
      setAsked(client === "cursor" ? client : null)
  }

  const hint = (item: McpClientStatus) => {
    if (!item.found && !item.connected) return t("settings.mcpClients.notFound")
    if (!item.connected)
      return asked === item.client
        ? t("settings.mcpClients.cursorAsked")
        : t("settings.mcpClients.off")
    const on =
      item.vault === null
        ? t("settings.mcpClients.onUnknown")
        : t(item.write ? "settings.mcpClients.onReadWrite" : "settings.mcpClients.onReadOnly", {
            vault: item.vault,
          })
    return item.client === "cursor" ? `${on} ${t("settings.mcpClients.cursorRemove")}` : on
  }

  return (
    <>
      <Row label={t("settings.mcpClients.access")} hint={t("settings.mcpClients.accessHint")}>
        <AmbySelect
          aria-label={t("settings.mcpClients.access")}
          value={write ? "write" : "read"}
          className="w-44"
          onValueChange={(value) => setWrite(value === "write")}
          options={[
            { value: "read", label: t("settings.mcpClients.readOnly") },
            { value: "write", label: t("settings.mcpClients.readWrite") },
          ]}
        />
      </Row>
      {clients.map((item) => {
        const removable = item.connected && item.client !== "cursor"
        return (
          <Row
            key={item.client}
            label={CLIENT_NAMES[item.client]}
            hint={
              <>
                <span data-testid={`mcp-client-${item.client}`}>{hint(item)}</span>
                {error?.client === item.client && <NoticeLine role="alert" text={error.text} />}
              </>
            }
          >
            {item.found && (
              <div className="flex gap-2">
                {removable && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void run(item.client, () => port.disconnect(item.client))}
                  >
                    {t("settings.mcpClients.disconnect")}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  aria-busy={busy === item.client}
                  onClick={() => void connect(item.client)}
                >
                  {busy === item.client && (
                    <MotionSpinner>
                      <Loader2 />
                    </MotionSpinner>
                  )}
                  {t(
                    item.connected
                      ? "settings.mcpClients.reconnect"
                      : "settings.mcpClients.connect",
                  )}
                </Button>
              </div>
            )}
          </Row>
        )
      })}
    </>
  )
}
