"use client"

import { AmbySelect } from "@/components/ui/amby-select"
import * as React from "react"
import { Check, ChevronDown, ChevronRight, Cloud, HardDrive, KeyRound, Plus, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { ProviderIcon } from "./ai/provider-icon"
import { hasProviderMark } from "./ai/provider-marks"
import {
  deleteAiCredential,
  inspectAiCredential,
  storeAiCredential,
  type CredentialInfo,
} from "@/lib/storage"
import {
  aiCodexLogin,
  aiCodexLoginCancel,
  aiCodexLogout,
  aiCodexStatus,
  aiErrorMessage,
} from "@/lib/ai"
import {
  AI_PROVIDERS,
  blankModel,
  changeProvider,
  codexStatusKey,
  findProvider,
  isCodexModel,
  isLocalAiModel,
  modelSupportsTools,
  type AiModel,
  type AiSettings,
} from "./app-config"

// ── Models library manager ────────────────────────────────────────────────────

export function ModelsManager({
  ai,
  onChange,
}: {
  ai: AiSettings
  onChange: (next: AiSettings) => void
}) {
  const { t } = useTranslation()
  const [storageError, setStorageError] = React.useState<string | null>(null)
  const [openId, setOpenId] = React.useState<string | null>(
    () => ai.activeModelId ?? ai.models[0]?.id ?? null,
  )
  const updateModel = (next: AiModel) =>
    onChange({ ...ai, models: ai.models.map((m) => (m.id === next.id ? next : m)) })

  const deleteModel = async (id: string) => {
    const target = ai.models.find((m) => m.id === id)
    if (target?.credentialId) {
      try {
        await deleteAiCredential(target.credentialId)
      } catch {
        setStorageError(t("models.keychainError"))
        return
      }
    }
    const models = ai.models.filter((m) => m.id !== id)
    const activeModelId = ai.activeModelId === id ? (models[0]?.id ?? null) : ai.activeModelId
    onChange({ models, activeModelId })
  }

  const addModel = () => {
    const m = blankModel()
    onChange({ models: [...ai.models, m], activeModelId: ai.activeModelId ?? m.id })
    setOpenId(m.id)
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-2 p-3">
        {storageError && (
          <p role="alert" className="text-[12px] text-destructive">
            {storageError}
          </p>
        )}
        {ai.models.length === 0 && (
          <p className="px-1 py-4 text-center text-[12px] text-muted-foreground">
            {t("models.empty")}
          </p>
        )}
        <div role="radiogroup" aria-label={t("ai.activeModel")} className="flex flex-col gap-2">
          {ai.models.map((m) => {
            const open = m.id === openId
            const active = m.id === ai.activeModelId
            const provider = findProvider(m.provider)
            return (
              <div
                key={m.id}
                className={cn(
                  "overflow-hidden rounded-xl border bg-card",
                  active ? "border-primary/40" : "border-border",
                )}
              >
                <div className="flex items-center gap-1 pl-2 pr-1">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={active}
                    title={t(active ? "models.active" : "models.makeActive")}
                    aria-label={t(active ? "models.active" : "models.makeActive")}
                    onClick={() => {
                      if (!active) onChange({ ...ai, activeModelId: m.id })
                    }}
                    className="flex size-6 shrink-0 items-center justify-center rounded-full hover:bg-accent"
                  >
                    <span
                      className={cn(
                        "flex size-3.5 items-center justify-center rounded-full border",
                        active ? "border-primary bg-primary" : "border-muted-foreground/60",
                      )}
                    >
                      {active && <span className="size-1.5 rounded-full bg-primary-foreground" />}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : m.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-2.5 text-left hover:bg-accent/50"
                  >
                    <ProviderIcon
                      providerId={m.provider}
                      kind={isLocalAiModel(m) ? "local" : "cloud"}
                      className="size-[18px] text-foreground/80"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-foreground">
                        {m.label || t("models.namePlaceholder")}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {provider?.label ?? m.provider}
                      </span>
                    </span>
                    {hasProviderMark(m.provider) &&
                      (isLocalAiModel(m) ? (
                        <HardDrive
                          role="img"
                          aria-label={t("ai.localModel")}
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                      ) : (
                        <Cloud
                          role="img"
                          aria-label={t("ai.cloudModel")}
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                      ))}
                    {open ? (
                      <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                </div>
                {open && (
                  <ModelEditor
                    model={m}
                    onChange={updateModel}
                    onDelete={() => void deleteModel(m.id)}
                  />
                )}
              </div>
            )
          })}
        </div>
        <button
          type="button"
          onClick={addModel}
          className="flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-border px-2 py-2.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5" />
          {t("models.add")}
        </button>
      </div>
    </ScrollArea>
  )
}

function ModelEditor({
  model,
  onChange,
  onDelete,
}: {
  model: AiModel
  onChange: (next: AiModel) => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const provider = findProvider(model.provider)
  const field =
    "h-8 w-full min-w-0 rounded-lg border border-border bg-background px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
  const label = "text-xs text-muted-foreground"
  const set = (patch: Partial<AiModel>) => onChange({ ...model, ...patch })

  const codex = isCodexModel(model)
  const [codexHint, setCodexHint] = React.useState<ReturnType<typeof codexStatusKey> | null>(null)
  const [codexBusy, setCodexBusy] = React.useState<"signIn" | "signOut" | null>(null)
  const [codexError, setCodexError] = React.useState<string | null>(null)
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const refreshCodex = React.useCallback(async () => {
    const status = await aiCodexStatus()
    if (mounted.current) setCodexHint(codexStatusKey(status))
  }, [])
  React.useEffect(() => {
    if (codex) void refreshCodex()
  }, [codex, refreshCodex])
  const codexAction = async (kind: "signIn" | "signOut") => {
    setCodexBusy(kind)
    setCodexError(null)
    try {
      await (kind === "signIn" ? aiCodexLogin() : aiCodexLogout())
    } catch (error) {
      if (mounted.current) setCodexError(aiErrorMessage(error))
    } finally {
      if (mounted.current) setCodexBusy(null)
    }
    await refreshCodex()
  }

  const [inputKey, setInputKey] = React.useState("")
  const [credInfo, setCredInfo] = React.useState<CredentialInfo | null>(null)
  const [savingKey, setSavingKey] = React.useState(false)
  const [keyError, setKeyError] = React.useState<string | null>(null)
  const keyOperation = React.useRef(false)

  React.useEffect(() => {
    let active = true
    if (model.credentialId) {
      void inspectAiCredential(model.credentialId)
        .then((info) => {
          if (active) setCredInfo(info)
        })
        .catch(() => {
          if (active) {
            setCredInfo(null)
            setKeyError(t("models.keychainError"))
          }
        })
    } else {
      setCredInfo(null)
    }
    return () => {
      active = false
    }
  }, [model.credentialId, t])

  const handleSaveKey = async (rawSecret: string) => {
    const secret = rawSecret.trim()
    if (!rawSecret || keyOperation.current) return
    keyOperation.current = true
    setSavingKey(true)
    setKeyError(null)
    try {
      const credId = model.credentialId || crypto.randomUUID()
      await storeAiCredential(credId, secret)
      const info = await inspectAiCredential(credId)
      if (info.exists !== Boolean(secret)) throw new Error("Credential verification failed")
      setCredInfo(info)
      set({ credentialId: secret ? credId : null })
      setInputKey("")
    } catch {
      setKeyError(t("models.keychainError"))
    } finally {
      keyOperation.current = false
      setSavingKey(false)
    }
  }

  const handleClearKey = async () => {
    if (keyOperation.current) return
    keyOperation.current = true
    setSavingKey(true)
    setKeyError(null)
    try {
      if (model.credentialId) await deleteAiCredential(model.credentialId)
      setCredInfo(null)
      setInputKey("")
      set({ credentialId: null })
    } catch {
      setKeyError(t("models.keychainError"))
    } finally {
      keyOperation.current = false
      setSavingKey(false)
    }
  }

  const locals = AI_PROVIDERS.filter((p) => p.kind === "local")
  const clouds = AI_PROVIDERS.filter((p) => p.kind === "cloud")

  const connection = codex ? (
    <div
      data-codex-connection
      className="flex flex-col gap-2 rounded-lg border border-border bg-background p-2.5"
    >
      {codexHint && (
        <div className="flex items-start gap-2">
          <span
            aria-hidden="true"
            className={cn(
              "mt-1 size-2 shrink-0 rounded-full",
              codexHint === "ready" ? "bg-emerald-500" : "bg-amber-500",
            )}
          />
          <p className="text-xs leading-snug text-foreground">
            {t(`models.codexStatus.${codexHint}`)}
          </p>
        </div>
      )}
      {codexError && (
        <p role="alert" className="text-xs leading-snug text-destructive">
          {codexError}
        </p>
      )}
      {codexBusy === "signIn" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">{t("models.codexWaiting")}</span>
          <button
            type="button"
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
            onClick={() => void aiCodexLoginCancel()}
          >
            {t("models.codexCancel")}
          </button>
        </div>
      )}
      {!codexBusy && codexHint === "signedOut" && (
        <button
          type="button"
          className="self-start rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-accent"
          onClick={() => void codexAction("signIn")}
        >
          {t("models.codexSignIn")}
        </button>
      )}
      {!codexBusy && codexHint === "ready" && (
        <button
          type="button"
          className="self-start rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-accent"
          onClick={() => void codexAction("signOut")}
        >
          {t("models.codexSignOut")}
        </button>
      )}
    </div>
  ) : (
    <>
      <div className="flex flex-col gap-1">
        <label className={label}>{provider?.azure ? "Endpoint" : "Base URL"}</label>
        <input
          className={field}
          value={model.baseUrl}
          onChange={(e) => set({ baseUrl: e.target.value })}
          placeholder={
            provider?.defaultBaseUrl ||
            (provider?.azure ? "https://<resource>.openai.azure.com" : t("models.optional"))
          }
        />
      </div>

      {provider?.needsKey && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <label className={label}>{t("models.apiKey")}</label>
            {credInfo?.exists && (
              <span className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                <KeyRound className="size-3" />
                {t("models.keyStoredInKeychain")}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              className={field}
              type="password"
              value={inputKey}
              onChange={(e) => setInputKey(e.target.value)}
              onBlur={() => {
                if (inputKey) void handleSaveKey(inputKey)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && inputKey) {
                  e.preventDefault()
                  void handleSaveKey(inputKey)
                }
              }}
              placeholder={credInfo?.masked || t("models.keyPlaceholder")}
            />
            {inputKey ? (
              <button
                type="button"
                title={t("models.keySaved")}
                disabled={savingKey}
                onClick={() => void handleSaveKey(inputKey)}
                className="shrink-0 rounded-md bg-primary/15 p-1.5 text-primary hover:bg-primary/25"
              >
                <Check className="size-3.5" />
              </button>
            ) : credInfo?.exists ? (
              <button
                type="button"
                title={t("models.clearKey")}
                disabled={savingKey}
                onClick={() => void handleClearKey()}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      )}
      {keyError && (
        <p role="alert" className="text-xs text-destructive">
          {keyError}
        </p>
      )}

      {provider?.azure && (
        <div className="flex flex-col gap-1">
          <label className={label}>{t("models.apiVersion")}</label>
          <input
            className={field}
            value={model.apiVersion}
            onChange={(e) => set({ apiVersion: e.target.value })}
            placeholder="2024-06-01"
          />
        </div>
      )}

      <label className="flex items-center justify-between gap-3 text-[13px] text-foreground">
        <span>{t("models.supportsTools")}</span>
        <Switch
          aria-label={t("models.supportsTools")}
          checked={modelSupportsTools(model)}
          onCheckedChange={(checked) => set({ supportsTools: checked })}
        />
      </label>
    </>
  )

  return (
    <div className="flex flex-col gap-3 border-t border-border px-3 pb-3 pt-3">
      <div className="flex flex-col gap-1">
        <label className={label}>{t("models.namePlaceholder")}</label>
        <input
          className={cn(field, "font-medium")}
          value={model.label}
          onChange={(e) => set({ label: e.target.value })}
          placeholder={t("models.namePlaceholder")}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className={label}>{t("models.provider")}</label>
        <AmbySelect
          value={model.provider}
          aria-label={t("models.provider")}
          options={[
            ...locals.map((p) => ({ value: p.id, label: p.label, group: t("models.local") })),
            ...clouds.map((p) => ({ value: p.id, label: p.label, group: t("models.cloud") })),
          ]}
          onValueChange={(next) => onChange(changeProvider(model, next))}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className={label}>
          {provider?.azure ? t("models.deploymentName") : t("models.model")}
        </label>
        <input
          className={field}
          value={model.model}
          onChange={(e) => set({ model: e.target.value })}
          placeholder={
            codex
              ? t("models.codexModelPlaceholder")
              : provider?.defaultModel || t("models.modelPlaceholder")
          }
        />
      </div>

      {connection}

      {provider?.kind === "cloud" && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(codex ? "models.codexPrivacyNote" : "models.privacyNote")}
        </p>
      )}

      <button
        type="button"
        onClick={onDelete}
        className="self-start rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-destructive"
      >
        {t("models.delete")}
      </button>
    </div>
  )
}
