"use client"

import * as React from "react"
import { Check, KeyRound, Plus, Trash2, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  deleteAiCredential,
  inspectAiCredential,
  storeAiCredential,
  type CredentialInfo,
} from "@/lib/storage"
import { AI_PROVIDERS, blankModel, findProvider, type AiModel, type AiSettings } from "./app-config"

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
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-2.5 p-3">
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
        {ai.models.map((m) => (
          <ModelEditor
            key={m.id}
            model={m}
            active={m.id === ai.activeModelId}
            onChange={updateModel}
            onDelete={() => void deleteModel(m.id)}
          />
        ))}
        <button
          type="button"
          onClick={addModel}
          className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-2 py-2 text-[12px] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
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
  active,
  onChange,
  onDelete,
}: {
  model: AiModel
  active: boolean
  onChange: (next: AiModel) => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const provider = findProvider(model.provider)
  const field =
    "h-7 w-full min-w-0 rounded border border-border bg-card px-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
  const label = "text-[10px] uppercase tracking-wider text-muted-foreground"
  const set = (patch: Partial<AiModel>) => onChange({ ...model, ...patch })

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

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-background p-2.5",
        active ? "border-ring/60" : "border-border",
      )}
    >
      <div className="flex items-center gap-2">
        <input
          className={cn(field, "flex-1 font-medium")}
          value={model.label}
          onChange={(e) => set({ label: e.target.value })}
          placeholder={t("models.namePlaceholder")}
        />
        <button
          type="button"
          title={t("models.delete")}
          onClick={onDelete}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-red-400"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <label className={label}>{t("models.provider")}</label>
        <select
          className={field}
          value={model.provider}
          onChange={(e) => set({ provider: e.target.value })}
        >
          <optgroup label={t("models.local")}>
            {locals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </optgroup>
          <optgroup label={t("models.cloud")}>
            {clouds.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </optgroup>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label className={label}>
          {provider?.azure ? t("models.deploymentName") : t("models.model")}
        </label>
        <input
          className={field}
          value={model.model}
          onChange={(e) => set({ model: e.target.value })}
          placeholder={provider?.defaultModel || t("models.modelPlaceholder")}
        />
      </div>

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
              <span className="flex items-center gap-1 text-[10px] text-emerald-400">
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
                className="shrink-0 rounded bg-primary/20 px-2 py-1 text-[11px] text-primary hover:bg-primary/30"
              >
                <Check className="size-3.5" />
              </button>
            ) : credInfo?.exists ? (
              <button
                type="button"
                title={t("models.clearKey")}
                disabled={savingKey}
                onClick={() => void handleClearKey()}
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-red-400"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      )}
      {keyError && (
        <p role="alert" className="text-[12px] text-destructive">
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

      {provider?.kind === "cloud" && (
        <p className="text-[10px] leading-snug text-muted-foreground">{t("models.privacyNote")}</p>
      )}
    </div>
  )
}
