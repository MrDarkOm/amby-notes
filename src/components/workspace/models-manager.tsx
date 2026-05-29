"use client"

import { Plus, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AI_PROVIDERS, blankModel, findProvider, type AiModel, type AiSettings } from "./app-config"

// ── Models library manager ────────────────────────────────────────────────────

export function ModelsManager({ ai, onChange }: { ai: AiSettings; onChange: (next: AiSettings) => void }) {
  const { t } = useTranslation()
  const updateModel = (next: AiModel) =>
    onChange({ ...ai, models: ai.models.map(m => (m.id === next.id ? next : m)) })

  const deleteModel = (id: string) => {
    const models = ai.models.filter(m => m.id !== id)
    const activeModelId = ai.activeModelId === id ? models[0]?.id ?? null : ai.activeModelId
    onChange({ models, activeModelId })
  }

  const addModel = () => {
    const m = blankModel()
    onChange({ models: [...ai.models, m], activeModelId: ai.activeModelId ?? m.id })
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-2.5 p-3">
        {ai.models.length === 0 && (
          <p className="px-1 py-4 text-center text-[12px] text-zinc-600">
            {t("models.empty")}
          </p>
        )}
        {ai.models.map(m => (
          <ModelEditor
            key={m.id}
            model={m}
            active={m.id === ai.activeModelId}
            onChange={updateModel}
            onDelete={() => deleteModel(m.id)}
          />
        ))}
        <button
          type="button"
          onClick={addModel}
          className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-zinc-700 px-2 py-2 text-[12px] text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
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
    "h-7 w-full min-w-0 rounded border border-zinc-800 bg-zinc-900 px-2 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-sky-700"
  const label = "text-[10px] uppercase tracking-wider text-zinc-500"
  const set = (patch: Partial<AiModel>) => onChange({ ...model, ...patch })

  const locals = AI_PROVIDERS.filter(p => p.kind === "local")
  const clouds = AI_PROVIDERS.filter(p => p.kind === "cloud")

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-zinc-950 p-2.5",
        active ? "border-sky-800/60" : "border-zinc-800",
      )}
    >
      <div className="flex items-center gap-2">
        <input
          className={cn(field, "flex-1 font-medium")}
          value={model.label}
          onChange={e => set({ label: e.target.value })}
          placeholder={t("models.namePlaceholder")}
        />
        <button
          type="button"
          title={t("models.delete")}
          onClick={onDelete}
          className="shrink-0 rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-red-400"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <label className={label}>{t("models.provider")}</label>
        <select className={field} value={model.provider} onChange={e => set({ provider: e.target.value })}>
          <optgroup label={t("models.local")}>
            {locals.map(p => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </optgroup>
          <optgroup label={t("models.cloud")}>
            {clouds.map(p => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </optgroup>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label className={label}>{provider?.azure ? t("models.deploymentName") : t("models.model")}</label>
        <input
          className={field}
          value={model.model}
          onChange={e => set({ model: e.target.value })}
          placeholder={provider?.defaultModel || t("models.modelPlaceholder")}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className={label}>{provider?.azure ? "Endpoint" : "Base URL"}</label>
        <input
          className={field}
          value={model.baseUrl}
          onChange={e => set({ baseUrl: e.target.value })}
          placeholder={
            provider?.defaultBaseUrl || (provider?.azure ? "https://<resource>.openai.azure.com" : t("models.optional"))
          }
        />
      </div>

      {provider?.needsKey && (
        <div className="flex flex-col gap-1">
          <label className={label}>{t("models.apiKey")}</label>
          <input
            className={field}
            type="password"
            value={model.apiKey}
            onChange={e => set({ apiKey: e.target.value })}
            placeholder={t("models.keyPlaceholder")}
          />
        </div>
      )}

      {provider?.azure && (
        <div className="flex flex-col gap-1">
          <label className={label}>API version</label>
          <input
            className={field}
            value={model.apiVersion}
            onChange={e => set({ apiVersion: e.target.value })}
            placeholder="2024-06-01"
          />
        </div>
      )}

      {provider?.kind === "cloud" && (
        <p className="text-[10px] leading-snug text-zinc-600">
          {t("models.privacyNote")}
        </p>
      )}
    </div>
  )
}
