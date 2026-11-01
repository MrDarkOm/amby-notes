import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Star,
  Settings2,
  Trash2,
  Wrench,
} from "lucide-react"
import { AmbySelect } from "@/components/ui/amby-select"
import { cn } from "@/lib/utils"
import { ProviderIcon } from "./provider-icon"
import { Switch } from "@/components/ui/switch"
import {
  aiClaudeLogin,
  aiClaudeLoginCancel,
  aiClaudeLogout,
  aiClaudeStatus,
  aiCodexLogin,
  aiCodexLoginCancel,
  aiCodexLogout,
  aiCodexStatus,
  aiLocalAppInstalled,
  aiModelCatalog,
} from "@/lib/ai"
import {
  confirmAction,
  deleteUnreferencedAiCredential,
  openWebAddress,
  showErrorMessage,
  storeAiCredential,
} from "@/lib/storage"
import { findProvider, resolveAiConfig } from "../app-config"
import {
  addLocalAiModel,
  AI_CONNECTION_PROVIDERS,
  AI_INITIAL_ENABLED_MODELS,
  canAddLocalAiModel,
  cliProviderId,
  isFirstAiCatalog,
  moveAiModel,
  reconcileAiCatalog,
  setAiModelEnabled,
  setAiModelTools,
  setBaseAiModel,
  type AiConnection,
  type AiConnectionsSettings,
  type AiConnectionMethod,
} from "./connections"

const field = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
const button =
  "rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent disabled:opacity-50"

interface CliStatus {
  installed: boolean
  supported: boolean
  signedIn: boolean
}

/** What differs between the two command-line connections; the card around them is shared. */
const CLI_TRANSPORTS = {
  "codex-cli": {
    name: "codex",
    installUrl: "https://developers.openai.com/codex/cli/",
    installCommand: "npm install -g @openai/codex",
    status: aiCodexStatus,
    login: aiCodexLogin,
    cancel: aiCodexLoginCancel,
    logout: aiCodexLogout,
  },
  "claude-cli": {
    name: "claude",
    installUrl: "https://code.claude.com/docs/en/setup",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    status: aiClaudeStatus,
    login: aiClaudeLogin,
    cancel: aiClaudeLoginCancel,
    logout: aiClaudeLogout,
  },
} as const

function cliTransport(method: AiConnectionMethod) {
  return method === "api" ? null : CLI_TRANSPORTS[method]
}

type Commit = (next: AiConnectionsSettings, expected: AiConnectionsSettings) => Promise<void>
/** Change the settings as they are when the change runs; resolves with what was saved. */
type Apply = (
  update: (previous: AiConnectionsSettings) => AiConnectionsSettings,
) => Promise<AiConnectionsSettings>

export function ConnectionsManager({
  settings,
  onCommit,
  onConflict,
}: {
  settings: AiConnectionsSettings
  onCommit: Commit
  /** Told that the saved settings changed elsewhere (another window); gives the saved ones. */
  onConflict?: () => Promise<AiConnectionsSettings | null>
}) {
  const { t } = useTranslation()
  const [adding, setAdding] = React.useState(false)
  const [providerId, setProviderId] = React.useState("openai")
  const [method, setMethod] = React.useState<AiConnectionMethod>("api")
  const [name, setName] = React.useState("")
  const [url, setUrl] = React.useState("")
  const [key, setKey] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const current = React.useRef(settings)
  current.current = settings
  // Cards change the settings at the same time (each loads its own catalog), and a screen that
  // is a moment behind would send a stale base. Every change therefore waits its turn and is
  // built from the settings the previous one saved.
  const latest = React.useRef(settings)
  const queue = React.useRef<Promise<unknown>>(Promise.resolve())
  const waiting = React.useRef(0)
  if (waiting.current === 0) latest.current = settings
  const apply: Apply = (update) => {
    waiting.current++
    const run = async (): Promise<AiConnectionsSettings> => {
      for (let attempt = 0; ; attempt++) {
        const previous = latest.current
        const next = update(previous)
        if (next === previous) return previous
        try {
          await onCommit(next, previous)
          latest.current = next
          return next
        } catch (error) {
          // Another window saved in the meantime: take what it saved and make the change on that.
          if (attempt > 0 || !onConflict || (error as Error)?.message !== "settingsChanged")
            throw error
          const saved = await onConflict()
          if (!saved) throw error
          latest.current = saved
        }
      }
    }
    const result = queue.current.then(run, run)
    queue.current = result.catch(() => {})
    return result.finally(() => {
      waiting.current--
    })
  }
  const provider = AI_CONNECTION_PROVIDERS.find((item) => item.id === providerId)!
  const installUrl = findProvider(providerId)?.installUrl
  // Whether the chosen local program is on this computer; unknown (null) shows nothing.
  const [installed, setInstalled] = React.useState<boolean | null>(null)
  React.useEffect(() => {
    setInstalled(null)
    if (!adding || !installUrl) return
    let current = true
    void aiLocalAppInstalled(providerId).then((found) => {
      if (current) setInstalled(found)
    })
    return () => {
      current = false
    }
  }, [adding, installUrl, providerId])

  const add = async () => {
    setError(null)
    const id = crypto.randomUUID()
    const cli = cliTransport(method)
    const credentialId = cli
      ? `${cli.name}-session:${crypto.randomUUID()}`
      : key.trim()
        ? crypto.randomUUID()
        : null
    if (method === "api" && findProvider(providerId)?.needsKey && !credentialId) {
      setError(t("aiConnections.invalid"))
      return
    }
    setBusy(true)
    try {
      if (method === "api" && credentialId) await storeAiCredential(credentialId, key.trim())
      const connection: AiConnection = {
        id,
        provider: providerId,
        method,
        label: name.trim() || provider.label,
        baseUrl: url.trim(),
        credentialId,
        apiVersion: "",
      }
      await apply((previous) => ({
        ...previous,
        connections: [...previous.connections, connection],
      }))
      setName("")
      setUrl("")
      setKey("")
      setAdding(false)
    } catch {
      setError(t("aiConnections.saveError"))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-3 p-3">
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!settings.connections.length && (
        <p className="text-xs text-muted-foreground">{t("aiConnections.noConnection")}</p>
      )}
      {settings.connections.map((connection) => (
        <ConnectionCard
          key={connection.id}
          connection={connection}
          settings={settings}
          apply={apply}
        />
      ))}
      {!adding ? (
        <button className={button} onClick={() => setAdding(true)}>
          {t("aiConnections.add")}
        </button>
      ) : (
        <div className="space-y-2 rounded-xl border border-border p-3">
          <label className="block text-xs">{t("aiConnections.provider")}</label>
          <AmbySelect
            aria-label={t("aiConnections.provider")}
            value={providerId}
            options={AI_CONNECTION_PROVIDERS.map((item) => ({
              value: item.id,
              label: item.label,
              icon: <ProviderIcon providerId={item.id} kind={item.kind} />,
            }))}
            renderValue={(active) => (
              <span className="flex items-center gap-2">
                <ProviderIcon providerId={providerId} kind={provider.kind} />
                {active?.label}
              </span>
            )}
            onValueChange={(id) => {
              setProviderId(id)
              setMethod("api")
              setUrl("")
              setKey("")
            }}
          />
          {installed === false && installUrl && (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs">
              <span>{t("aiConnections.notInstalled", { name: provider.label })}</span>
              <button
                className={button}
                onClick={() => void openWebAddress(installUrl).catch(() => {})}
              >
                {t("aiConnections.downloadApp", { name: provider.label })}
              </button>
            </div>
          )}
          <label className="block text-xs">{t("aiConnections.method")}</label>
          <AmbySelect
            aria-label={t("aiConnections.method")}
            value={method}
            options={provider.methods.map((item) => ({
              value: item,
              label: t(
                item === "api"
                  ? "aiConnections.api"
                  : item === "claude-cli"
                    ? "aiConnections.claudeCli"
                    : "aiConnections.cli",
              ),
            }))}
            onValueChange={(value) => setMethod(value as AiConnectionMethod)}
          />
          <label className="block text-xs">
            {t("aiConnections.name")}
            <input
              className={field}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {method === "api" && (
            <>
              <label className="block text-xs">
                {t("aiConnections.endpoint")}
                <input
                  className={field}
                  value={url}
                  placeholder={findProvider(providerId)?.defaultBaseUrl}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </label>
              {findProvider(providerId)?.needsKey && (
                <label className="block text-xs">
                  {t("aiConnections.key")}
                  <input
                    className={field}
                    type="password"
                    autoComplete="off"
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                  />
                </label>
              )}
            </>
          )}
          <button className={button} disabled={busy} onClick={() => void add()}>
            {t("aiConnections.addConnection")}
          </button>{" "}
          <button className={button} disabled={busy} onClick={() => setAdding(false)}>
            {t("common.cancel")}
          </button>
        </div>
      )}
    </div>
  )
}

function ConnectionCard({
  connection,
  settings,
  apply,
}: {
  connection: AiConnection
  settings: AiConnectionsSettings
  apply: Apply
}) {
  const { t } = useTranslation()
  const [name, setName] = React.useState(connection.label)
  const [url, setUrl] = React.useState(connection.baseUrl)
  const [key, setKey] = React.useState("")
  const [query, setQuery] = React.useState("")
  const [custom, setCustom] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<CliStatus | null>(null)
  const cli = cliTransport(connection.method)
  const [login, setLogin] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [open, setOpen] = React.useState(true)
  const current = React.useRef({ settings, connection })
  const request = React.useRef<AbortController | null>(null)
  const loginRef = React.useRef(login)
  loginRef.current = login
  const cliRef = React.useRef(cli)
  cliRef.current = cli
  current.current = { settings, connection }
  React.useEffect(
    () => () => {
      request.current?.abort()
      if (loginRef.current) void cliRef.current?.cancel()
    },
    [],
  )
  const check = React.useCallback(async () => {
    const transport = cliTransport(connection.method)
    if (transport) setStatus(await transport.status())
  }, [connection.method])
  React.useEffect(() => {
    if (connection.method !== "api") void check()
  }, [connection.method, check])
  const commit = async (update: Parameters<Apply>[0]) => {
    setBusy(true)
    setError(null)
    try {
      return await apply(update)
    } catch {
      setError(t("aiConnections.saveError"))
      throw new Error("saveFailed")
    } finally {
      setBusy(false)
    }
  }
  const refresh = async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    const initial = current.current.connection
    setBusy(true)
    setError(null)
    try {
      const config = resolveAiConfig({
        id: "",
        label: "",
        provider: cliProviderId(initial.method) ?? initial.provider,
        model: "",
        baseUrl: initial.baseUrl,
        credentialId: initial.credentialId,
        apiVersion: initial.apiVersion,
      })
      const catalog = await aiModelCatalog(config, controller.signal)
      if (
        controller.signal.aborted ||
        JSON.stringify(current.current.connection) !== JSON.stringify(initial)
      )
        return
      const entries = catalog.map((model) => ({
        ...model,
        supportsTools: model.supportsTools ?? undefined,
      }))
      await apply((previous) => {
        const updated = reconcileAiCatalog(
          previous,
          initial.id,
          entries,
          isFirstAiCatalog(previous, initial.id) ? AI_INITIAL_ENABLED_MODELS : 0,
        )
        return {
          ...updated,
          connections: updated.connections.map((item) =>
            item.id === initial.id ? { ...item, catalogUpdatedAt: new Date().toISOString() } : item,
          ),
        }
      })
    } catch {
      if (!controller.signal.aborted) setError(t("aiConnections.catalogError"))
    } finally {
      if (request.current === controller) setBusy(false)
    }
  }
  const autoTried = React.useRef(false)
  React.useEffect(() => {
    if (
      autoTried.current ||
      connection.provider === "azure" ||
      !!connection.catalogUpdatedAt ||
      login ||
      busy
    )
      return
    if (connection.method !== "api" && !status?.signedIn) return
    autoTried.current = true
    void refresh()
    // One initial attempt per card; explicit refresh is available on failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    connection.id,
    connection.method,
    connection.provider,
    connection.catalogUpdatedAt,
    status?.signedIn,
    login,
    busy,
  ])

  const rotateCliSession = async () => {
    const method = current.current.connection.method
    const prefix = cliTransport(method)?.name ?? "cli"
    await commit((previous) => {
      const ids = new Set(
        previous.connections.filter((item) => item.method === method).map((item) => item.id),
      )
      return {
        ...previous,
        connections: previous.connections.map((item) =>
          ids.has(item.id)
            ? {
                ...item,
                credentialId: `${prefix}-session:${crypto.randomUUID()}`,
                catalogUpdatedAt: undefined,
              }
            : item,
        ),
        models: previous.models.map((model) =>
          ids.has(model.connectionId) ? { ...model, available: false } : model,
        ),
      }
    })
    autoTried.current = false
  }
  const save = async () => {
    const initial = current.current.connection
    const changed = url.trim() !== initial.baseUrl || !!key.trim()
    const credentialId = key.trim() ? crypto.randomUUID() : initial.credentialId
    setBusy(true)
    setError(null)
    try {
      if (key.trim() && credentialId) await storeAiCredential(credentialId, key.trim())
      if (changed) autoTried.current = false
      const next = await apply((previous) => ({
        ...previous,
        connections: previous.connections.map((item) =>
          item.id === initial.id
            ? {
                ...item,
                label: name.trim() || item.label,
                baseUrl: url.trim(),
                credentialId,
                catalogUpdatedAt: changed ? undefined : item.catalogUpdatedAt,
              }
            : item,
        ),
        models: previous.models.map((model) =>
          changed && model.connectionId === initial.id && model.origin !== "local"
            ? { ...model, available: false }
            : model,
        ),
      }))
      setKey("")
      if (
        key.trim() &&
        initial.credentialId &&
        !next.connections.some((item) => item.credentialId === initial.credentialId)
      )
        await deleteUnreferencedAiCredential(initial.credentialId).catch(() =>
          showErrorMessage(t("aiConnections.keyError")),
        )
    } catch {
      setError(t("aiConnections.saveError"))
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!(await confirmAction(t("aiConnections.removeConfirm")))) return
    try {
      const next = await commit((previous) => ({
        ...previous,
        activeModelId: previous.models.some(
          (model) => model.connectionId === connection.id && model.id === previous.activeModelId,
        )
          ? null
          : previous.activeModelId,
        baseModelId: previous.models.some(
          (model) => model.connectionId === connection.id && model.id === previous.baseModelId,
        )
          ? null
          : previous.baseModelId,
        connections: previous.connections.filter((item) => item.id !== connection.id),
        models: previous.models.filter((item) => item.connectionId !== connection.id),
      }))
      if (
        connection.method === "api" &&
        connection.credentialId &&
        !next.connections.some((item) => item.credentialId === connection.credentialId)
      )
        await deleteUnreferencedAiCredential(connection.credentialId).catch(() =>
          showErrorMessage(t("aiConnections.keyError")),
        )
    } catch {
      setError(t("aiConnections.saveError"))
    }
  }
  const [params, setParams] = React.useState(false)
  const all = settings.models.filter((model) => model.connectionId === connection.id)
  const models = all.filter((model) =>
    `${model.label} ${model.model}`.toLowerCase().includes(query.toLowerCase()),
  )
  const enabledCount = all.filter((model) => model.enabled).length
  const needsAction =
    cli && status !== null && (!status.installed || !status.supported || !status.signedIn)
  const providerLabel = findProvider(connection.provider)?.label ?? connection.provider
  const methodLabel = t(
    connection.method === "api" ? "aiConnections.api" : "aiConnections.cliShort",
  )
  const cliState =
    cli && status
      ? !status.installed || !status.supported
        ? "missing"
        : !status.signedIn
          ? "signedOut"
          : "ready"
      : null
  const iconButton =
    "rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
  const signIn = () => {
    if (!cli) return
    setLogin(true)
    void rotateCliSession()
      .then(() => cli.login())
      .then(check)
      .catch(() => setError(t("aiConnections.catalogError")))
      .finally(() => setLogin(false))
  }
  const signOut = () => {
    if (!cli) return
    setLogin(true)
    void rotateCliSession()
      .then(() => cli.logout())
      .then(check)
      .catch(() => setError(t("aiConnections.catalogError")))
      .finally(() => setLogin(false))
  }
  return (
    <section className="rounded-xl border border-border">
      <div className="flex items-center gap-1 p-2">
        <button
          type="button"
          className="group flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/50 focus-visible:bg-accent/50"
          aria-expanded={open}
          aria-label={t(open ? "aiConnections.collapse" : "aiConnections.expand", {
            name: connection.label,
          })}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="relative size-5 shrink-0">
            <ProviderIcon
              providerId={connection.provider}
              kind={canAddLocalAiModel(connection) ? "local" : "cloud"}
              className="absolute inset-0 size-5 text-foreground/80 group-hover:opacity-0 group-focus-visible:opacity-0"
            />
            {open ? (
              <ChevronDown className="absolute inset-0 size-5 p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
            ) : (
              <ChevronRight className="absolute inset-0 size-5 p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{connection.label}</span>
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="min-w-0 truncate">
                {providerLabel} · {methodLabel}
                {all.length > 0 &&
                  ` · ${t("aiConnections.enabledCount", { on: enabledCount, all: all.length })}`}
              </span>
              {cliState && (
                <span
                  role="img"
                  aria-label={t(`aiConnections.state_${cliState}`)}
                  title={t(`aiConnections.state_${cliState}`)}
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    cliState === "ready" ? "bg-emerald-500" : "bg-red-500",
                  )}
                />
              )}
            </span>
          </span>
        </button>
        {connection.provider !== "azure" && (
          <button
            type="button"
            className={iconButton}
            aria-label={t("aiConnections.refresh")}
            title={
              connection.catalogUpdatedAt
                ? `${t("aiConnections.refresh")}\n${t("aiConnections.catalogUpdated", {
                    time: new Date(connection.catalogUpdatedAt).toLocaleString(),
                  })}`
                : t("aiConnections.refresh")
            }
            disabled={busy || (connection.method !== "api" && !status?.signedIn)}
            onClick={() => void refresh()}
          >
            {busy ? <Loader2 className="size-4" /> : <RefreshCw className="size-4" />}
          </button>
        )}
        <button
          type="button"
          className={cn(iconButton, params && "bg-accent text-foreground")}
          aria-label={t("aiConnections.parameters")}
          title={t("aiConnections.parameters")}
          aria-expanded={params}
          onClick={() => {
            setOpen(true)
            setParams((value) => !value)
          }}
        >
          <Settings2 className="size-4" />
        </button>
        <button
          type="button"
          className={cn(iconButton, "hover:bg-destructive/10 hover:text-destructive")}
          aria-label={t("aiConnections.remove")}
          title={t("aiConnections.remove")}
          disabled={busy}
          onClick={() => void remove()}
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      <div className={open ? "space-y-3 border-t border-border p-3" : "hidden"}>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {needsAction && cli && status && (
          <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-xs">
            <p>
              {t(
                !status.installed
                  ? `aiConnections.${cli.name}Missing`
                  : !status.supported
                    ? `aiConnections.${cli.name}Unsupported`
                    : `aiConnections.${cli.name}SignedOut`,
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {(!status.installed || !status.supported) && (
                <>
                  <button className={button} onClick={() => void openWebAddress(cli.installUrl)}>
                    {t("aiConnections.install")}
                  </button>
                  <button
                    className={button}
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(cli.installCommand)
                        .then(() => setCopied(true))
                    }
                  >
                    {t(copied ? "aiConnections.copied" : "aiConnections.copyCommand")}
                  </button>
                  <code className="text-muted-foreground">{cli.installCommand}</code>
                </>
              )}
              {status.supported && !status.signedIn && (
                <button className={button} disabled={login} onClick={signIn}>
                  {t(cli.name === "claude" ? "aiConnections.claudeSignIn" : "aiConnections.signIn")}
                </button>
              )}
              {login && (
                <button className={button} onClick={() => void cli.cancel()}>
                  {t("aiConnections.cancel")}
                </button>
              )}
              <button className={button} onClick={() => void check()}>
                {t("aiConnections.check")}
              </button>
            </div>
          </div>
        )}
        {params && (
          <div className="space-y-2 rounded-lg bg-muted/40 p-3">
            <label className="block text-xs">
              {t("aiConnections.name")}
              <input
                className={field}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {connection.method === "api" && (
              <>
                <label className="block text-xs">
                  {t("aiConnections.endpoint")}
                  <input
                    className={field}
                    value={url}
                    placeholder={findProvider(connection.provider)?.defaultBaseUrl}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                </label>
                {findProvider(connection.provider)?.needsKey && (
                  <label className="block text-xs">
                    {t("aiConnections.key")}
                    <input
                      className={field}
                      type="password"
                      autoComplete="off"
                      placeholder={t("aiConnections.keyHint")}
                      value={key}
                      onChange={(event) => setKey(event.target.value)}
                    />
                  </label>
                )}
              </>
            )}
            {cli && (
              <p className="text-xs text-muted-foreground">
                {t(`aiConnections.${cli.name}Isolation`)}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button className={button} disabled={busy} onClick={() => void save()}>
                {t("aiConnections.save")}
              </button>
              {cli && status?.signedIn && (
                <button className={button} disabled={login} onClick={signOut}>
                  {t("aiConnections.signOut")}
                </button>
              )}
              {cli && !needsAction && (
                <button className={button} onClick={() => void check()}>
                  {t("aiConnections.check")}
                </button>
              )}
            </div>
          </div>
        )}
        {connection.provider === "azure" && (
          <p className="text-xs text-muted-foreground">{t("aiConnections.azureHint")}</p>
        )}
        {all.length > 6 && (
          <input
            className={field}
            aria-label={t("aiConnections.search")}
            placeholder={t("aiConnections.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
        {all.length === 0 && !needsAction && (
          <p className="text-xs text-muted-foreground">
            {busy ? t("aiConnections.loading") : t("aiConnections.empty")}
          </p>
        )}
        {models.length > 0 && (
          <div
            className="max-h-72 divide-y divide-border/60 overflow-auto"
            title={t("aiConnections.catalogHint")}
          >
            {models.map((model, index) => (
              <div key={model.id} className="flex items-center gap-1 py-1.5 text-sm">
                <ProviderIcon
                  providerId={connection.provider}
                  modelId={model.model}
                  kind={
                    connection.method === "api" && canAddLocalAiModel(connection)
                      ? "local"
                      : "cloud"
                  }
                  className="mr-1.5 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate">
                  {model.label}
                  {!model.available && (
                    <span className="text-xs text-muted-foreground">
                      {" "}
                      · {t("aiConnections.unavailable")}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className={cn(
                    "rounded p-1 hover:bg-accent disabled:opacity-25",
                    model.supportsTools ? "text-primary" : "text-muted-foreground",
                  )}
                  aria-pressed={!!model.supportsTools}
                  aria-label={t("aiConnections.tools", { model: model.label })}
                  title={t("aiConnections.toolsHint")}
                  disabled={busy}
                  onClick={() => {
                    void commit((previous) =>
                      setAiModelTools(previous, model.id, !model.supportsTools),
                    ).catch(() => {})
                  }}
                >
                  <Wrench className="size-3.5" />
                </button>
                <button
                  type="button"
                  className={cn(
                    "rounded p-1 hover:bg-accent disabled:opacity-25",
                    settings.baseModelId === model.id ? "text-amber-500" : "text-muted-foreground",
                  )}
                  aria-pressed={settings.baseModelId === model.id}
                  aria-label={t("aiConnections.baseModel", { model: model.label })}
                  title={t("aiConnections.baseModelHint")}
                  disabled={busy || !model.enabled}
                  onClick={() => {
                    void commit((previous) => setBaseAiModel(previous, model.id)).catch(() => {})
                  }}
                >
                  <Star
                    className={cn("size-3.5", settings.baseModelId === model.id && "fill-current")}
                  />
                </button>
                {[-1, 1].map((direction) => (
                  <button
                    key={direction}
                    type="button"
                    className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-25"
                    aria-label={t(
                      direction < 0 ? "aiConnections.moveUp" : "aiConnections.moveDown",
                      { model: model.label },
                    )}
                    disabled={
                      busy || !!query || (direction < 0 ? index === 0 : index === models.length - 1)
                    }
                    onClick={() => {
                      void commit((previous) =>
                        moveAiModel(previous, model.id, direction as -1 | 1),
                      ).catch(() => {})
                    }}
                  >
                    {direction < 0 ? (
                      <ArrowUp className="size-3.5" />
                    ) : (
                      <ArrowDown className="size-3.5" />
                    )}
                  </button>
                ))}
                <Switch
                  className="ml-1"
                  aria-label={t("aiConnections.enabled", { model: model.label })}
                  checked={model.enabled}
                  disabled={busy}
                  onCheckedChange={(enabled) => {
                    void commit((previous) => setAiModelEnabled(previous, model.id, enabled)).catch(
                      () => {},
                    )
                  }}
                />
              </div>
            ))}
          </div>
        )}
        {canAddLocalAiModel(connection) && (
          <div className="flex gap-2">
            <input
              className={field}
              aria-label={t("aiConnections.modelId")}
              placeholder={t("aiConnections.modelId")}
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
            />
            <button
              className={button}
              disabled={busy || !custom.trim()}
              onClick={() => {
                try {
                  // Reject a bad or duplicate id here, before anything is queued.
                  addLocalAiModel(current.current.settings, connection.id, custom, custom)
                  void commit((previous) =>
                    addLocalAiModel(previous, connection.id, custom, custom),
                  )
                    .then(() => setCustom(""))
                    .catch(() => {})
                } catch {
                  setError(t("aiConnections.invalid"))
                }
              }}
            >
              {t("aiConnections.addLocal")}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
