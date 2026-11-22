import * as React from "react"
import { useTranslation } from "react-i18next"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { confirm } from "@/lib/confirm"
import { confirmations } from "@/lib/confirmations"
import { MotionSpinner } from "@/lib/motion"
import { cn } from "@/lib/utils"
import {
  McpClientOperationError,
  resolveMcpClientsPort,
  type McpClient,
  type McpClientStatus,
  type McpClientsPort,
} from "@/lib/storage"
import { NoticeLine } from "@/components/workspace/notices/notice-line"
import { ProviderIcon } from "@/components/workspace/ai/provider-icon"

/** Product names; they are not translated. */
const CLIENT_NAMES: Record<McpClient, string> = {
  claudeCode: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "Antigravity",
}

/** The bundled mark each client is drawn with (see `provider-marks.ts`). */
const CLIENT_MARKS: Record<McpClient, string> = {
  claudeCode: "claude-code",
  codex: "codex",
  cursor: "cursor",
  antigravity: "antigravity",
}

/**
 * Settings → General → Command line: the open vault as the `amby` MCP server of each AI client, in
 * a row of tiles. Each client keeps its own access (read only, or with edits); Amby asks the client
 * through its own command or install window, and the question before names the vault, the access
 * and how.
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
  // The access a client is connected with next; a connected client starts from what it has.
  const [edits, setEdits] = React.useState<Partial<Record<McpClient, boolean>>>({})
  const [busy, setBusy] = React.useState<McpClient | null>(null)
  const [error, setError] = React.useState<{ client: McpClient; text: string } | null>(null)
  const [asked, setAsked] = React.useState<McpClient | null>(null)
  const headingId = React.useId()

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

  const editsOf = (item: McpClientStatus) => edits[item.client] ?? item.write ?? false

  const connect = async (client: McpClient, write: boolean) => {
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
    if (await run(client, () => port.connect(client, vault, write))) {
      setEdits((current) => ({ ...current, [client]: write }))
      setAsked(client === "cursor" ? client : null)
    }
  }

  const changeEdits = (item: McpClientStatus, write: boolean) => {
    // A connected client is connected again with the new access, after the same question.
    if (item.connected) void connect(item.client, write)
    else setEdits((current) => ({ ...current, [item.client]: write }))
  }

  /** A short state with its dot, and an optional longer note under it. */
  const status = (item: McpClientStatus) => {
    if (!item.found && !item.connected)
      return { text: t("settings.mcpClients.notFound"), tone: "none" as const }
    if (!item.connected)
      return {
        text: t("settings.mcpClients.off"),
        tone: "off" as const,
        note: asked === item.client ? t("settings.mcpClients.cursorAsked") : undefined,
      }
    if (item.vault !== null && vault !== null && item.vault !== vault)
      return { text: t("settings.mcpClients.onOther"), tone: "other" as const }
    return {
      text: t("settings.mcpClients.on"),
      tone: "on" as const,
      note: item.client === "cursor" ? t("settings.mcpClients.cursorRemove") : undefined,
    }
  }

  return (
    <div role="group" aria-labelledby={headingId} className="settings-row px-4 py-3">
      <div id={headingId} className="text-[13px] text-foreground">
        {t("settings.mcpClients.title")}
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">
        {t("settings.mcpClients.hint")}
      </div>
      <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2">
        {clients.map((item) => {
          const name = CLIENT_NAMES[item.client]
          const elsewhere = item.connected && item.vault !== null && item.vault !== vault
          const removable = item.connected && item.client !== "cursor" && !elsewhere
          const write = editsOf(item)
          const state = status(item)
          const action = removable
            ? "settings.mcpClients.disconnect"
            : elsewhere
              ? "settings.mcpClients.connectHere"
              : item.connected
                ? "settings.mcpClients.reconnect"
                : "settings.mcpClients.connect"
          return (
            <div
              key={item.client}
              role="group"
              aria-label={name}
              data-testid={`mcp-client-tile-${item.client}`}
              className={cn(
                "flex flex-col items-center rounded-lg border border-border/70 px-2.5 pt-3 pb-2.5 text-center",
                !item.found && !item.connected && "opacity-60",
              )}
            >
              <ProviderIcon
                providerId={CLIENT_MARKS[item.client]}
                kind="cloud"
                className="size-6"
              />
              <div className="mt-2 text-[13px] font-medium text-foreground">{name}</div>
              <div
                data-testid={`mcp-client-${item.client}`}
                title={item.connected && item.vault ? item.vault : undefined}
                className="mt-0.5 text-[11px] leading-snug text-muted-foreground"
              >
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      state.tone === "on" && "bg-[color:var(--notice-success-fg)]",
                      state.tone === "other" && "bg-[color:var(--notice-warning-fg)]",
                      (state.tone === "off" || state.tone === "none") && "bg-muted-foreground/40",
                    )}
                  />
                  {state.text}
                </span>
                {state.note && <span className="mt-1 block">{state.note}</span>}
              </div>
              {error?.client === item.client && (
                <div className="mt-1.5 w-full">
                  <NoticeLine role="alert" text={error.text} />
                </div>
              )}
              <div className="mt-auto flex w-full flex-col items-center gap-2 pt-3">
                {item.found && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 w-full text-[12px] font-normal"
                    disabled={busy !== null}
                    aria-busy={busy === item.client}
                    aria-label={`${t(action)}: ${name}`}
                    onClick={() =>
                      void (removable
                        ? run(item.client, () => port.disconnect(item.client))
                        : connect(item.client, write))
                    }
                  >
                    {busy === item.client && (
                      <MotionSpinner>
                        <Loader2 />
                      </MotionSpinner>
                    )}
                    {t(action)}
                  </Button>
                )}
                <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Switch
                    checked={write}
                    disabled={!item.found || busy !== null}
                    aria-label={`${t("settings.mcpClients.edits")}: ${name}`}
                    onCheckedChange={(next) => changeEdits(item, next)}
                  />
                  {t("settings.mcpClients.edits")}
                </label>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
