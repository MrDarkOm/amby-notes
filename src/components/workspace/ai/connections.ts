import { AI_PROVIDERS, type AiSettings } from "./providers"

/** Version 1 is an in-memory proposal until the durable migration is implemented. */
export const AI_CONNECTIONS_VERSION = 1 as const

export type AiConnectionMethod = "api" | "codex-cli" | "claude-cli"

/** The provider id that carries a CLI method on the wire. */
export function cliProviderId(method: AiConnectionMethod): "codex" | "claude-code" | null {
  return method === "codex-cli" ? "codex" : method === "claude-cli" ? "claude-code" : null
}
export interface AiConnection {
  id: string
  provider: string
  method: AiConnectionMethod
  label: string
  baseUrl: string
  credentialId: string | null
  apiVersion: string
  catalogUpdatedAt?: string
}

export interface ConnectedAiModel {
  id: string
  connectionId: string
  model: string
  label: string
  enabled: boolean
  available: boolean
  origin: "legacy" | "catalog" | "local"
  supportsTools?: boolean
}

export interface AiConnectionsSettings {
  version: typeof AI_CONNECTIONS_VERSION
  connections: AiConnection[]
  models: ConnectedAiModel[]
  activeModelId: string | null
  /** The model a new chat starts with; absent or null means the one picked last. */
  baseModelId?: string | null
}

/** Only explicitly implemented transports are offered. Local servers use HTTP. */
export const AI_CONNECTION_PROVIDERS = AI_PROVIDERS.filter(
  (provider) => provider.id !== "codex" && provider.id !== "claude-code",
).map((provider) => ({
  id: provider.id,
  label: provider.label,
  kind: provider.kind,
  methods: (provider.id === "openai"
    ? ["api", "codex-cli"]
    : provider.id === "anthropic"
      ? ["api", "claude-cli"]
      : ["api"]) as AiConnectionMethod[],
}))

export function selectableAiModels(settings: AiConnectionsSettings): ConnectedAiModel[] {
  const ids = new Set(
    settings.connections
      .filter((connection) =>
        AI_CONNECTION_PROVIDERS.some(
          (provider) =>
            provider.id === connection.provider && provider.methods.includes(connection.method),
        ),
      )
      .map((connection) => connection.id),
  )
  return settings.models.filter(
    (model) => model.enabled && model.available && ids.has(model.connectionId),
  )
}

export function setAiModelEnabled(
  settings: AiConnectionsSettings,
  modelId: string,
  enabled: boolean,
): AiConnectionsSettings {
  return {
    ...settings,
    // A model that is switched off cannot start new chats.
    ...(!enabled && settings.baseModelId === modelId ? { baseModelId: null } : {}),
    models: settings.models.map((model) => (model.id === modelId ? { ...model, enabled } : model)),
  }
}

/** Say whether a model can call tools, which the search of the vault in a chat needs. */
export function setAiModelTools(
  settings: AiConnectionsSettings,
  modelId: string,
  supportsTools: boolean,
): AiConnectionsSettings {
  return {
    ...settings,
    models: settings.models.map((model) =>
      model.id === modelId ? { ...model, supportsTools } : model,
    ),
  }
}

/** Make an enabled model the one new chats start with; choosing it again clears the choice. */
export function setBaseAiModel(
  settings: AiConnectionsSettings,
  modelId: string,
): AiConnectionsSettings {
  const model = settings.models.find((candidate) => candidate.id === modelId)
  if (!model || !model.enabled) return settings
  return { ...settings, baseModelId: settings.baseModelId === modelId ? null : modelId }
}

/** The model a new chat starts with: the base one while it can be used, else the last picked. */
export function newChatModelId(ai: AiSettings): string {
  const base = ai.connectionSettings?.baseModelId
  if (base && ai.models.some((model) => model.id === base)) return base
  return ai.activeModelId ?? ""
}

export function canAddLocalAiModel(connection: AiConnection): boolean {
  return AI_CONNECTION_PROVIDERS.some(
    (provider) =>
      provider.id === connection.provider &&
      provider.kind === "local" &&
      connection.method === "api",
  )
}

/** How many models a connection enables by itself when its catalog is first loaded. */
export const AI_INITIAL_ENABLED_MODELS = 10

/** True until the connection has received any catalog model. */
export function isFirstAiCatalog(settings: AiConnectionsSettings, connectionId: string): boolean {
  return !settings.models.some(
    (model) => model.connectionId === connectionId && model.origin === "catalog",
  )
}

/** Move a model one step within its own connection, keeping other connections untouched.
 * The menu lists models in this array order, so the order chosen here is the order shown there. */
export function moveAiModel(
  settings: AiConnectionsSettings,
  modelId: string,
  direction: -1 | 1,
): AiConnectionsSettings {
  const index = settings.models.findIndex((model) => model.id === modelId)
  if (index < 0) return settings
  const connectionId = settings.models[index].connectionId
  let target = index + direction
  while (settings.models[target] && settings.models[target].connectionId !== connectionId) {
    target += direction
  }
  if (!settings.models[target]) return settings
  const models = [...settings.models]
  ;[models[index], models[target]] = [models[target], models[index]]
  return { ...settings, models }
}

/** Reconcile a successful catalog response without changing user choices.
 * `enableFirst` turns on that many newly seen models, for a connection's first catalog. */
export function reconcileAiCatalog(
  settings: AiConnectionsSettings,
  connectionId: string,
  catalog: Array<Pick<ConnectedAiModel, "model" | "label" | "supportsTools">>,
  enableFirst = 0,
): AiConnectionsSettings {
  if (!settings.connections.some((connection) => connection.id === connectionId)) return settings
  const byModel = new Map(catalog.map((model) => [model.model, model]))
  const existing = new Set<string>()
  const models: ConnectedAiModel[] = []
  for (const model of settings.models) {
    if (model.connectionId !== connectionId || model.origin === "local") {
      models.push(model)
      continue
    }
    const entry = byModel.get(model.model)
    // A catalog model that left the catalog and was never switched on is just clutter.
    if (!entry && model.origin === "catalog" && !model.enabled) continue
    existing.add(model.model)
    models.push(
      entry
        ? {
            ...model,
            // A catalog entry names its own model; a legacy or local label is the user's.
            label: model.origin === "catalog" ? entry.label : model.label,
            available: true,
            supportsTools: entry.supportsTools ?? model.supportsTools,
          }
        : { ...model, available: false },
    )
  }
  let remaining = enableFirst
  for (const entry of catalog) {
    if (existing.has(entry.model)) continue
    existing.add(entry.model)
    models.push({
      ...entry,
      id: crypto.randomUUID(),
      connectionId,
      enabled: remaining-- > 0,
      available: true,
      origin: "catalog",
    })
  }
  return { ...settings, models }
}

/** Reject a version or shape we cannot faithfully write back. */
export function readAiConnections(raw: unknown): AiConnectionsSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalidAiSettings")
  const value = raw as Record<string, unknown>
  if (value.version !== AI_CONNECTIONS_VERSION) throw new Error("unsupportedAiVersion")
  if (!Array.isArray(value.connections) || !Array.isArray(value.models)) {
    throw new Error("invalidAiSettings")
  }
  if (value.activeModelId !== null && typeof value.activeModelId !== "string") {
    throw new Error("invalidAiSettings")
  }
  const ids = new Set<string>()
  for (const item of value.connections) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("invalidAiSettings")
    const connection = item as Record<string, unknown>
    if (
      typeof connection.id !== "string" ||
      !connection.id ||
      ids.has(connection.id) ||
      typeof connection.provider !== "string" ||
      typeof connection.label !== "string" ||
      typeof connection.baseUrl !== "string" ||
      typeof connection.apiVersion !== "string" ||
      (connection.credentialId !== null && typeof connection.credentialId !== "string") ||
      (connection.method !== "api" &&
        connection.method !== "codex-cli" &&
        connection.method !== "claude-cli")
    )
      throw new Error("invalidAiSettings")
    ids.add(connection.id)
  }
  const modelIds = new Set<string>()
  for (const item of value.models) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("invalidAiSettings")
    const model = item as Record<string, unknown>
    if (
      typeof model.id !== "string" ||
      !model.id ||
      modelIds.has(model.id) ||
      typeof model.connectionId !== "string" ||
      !ids.has(model.connectionId) ||
      typeof model.model !== "string" ||
      typeof model.label !== "string" ||
      typeof model.enabled !== "boolean" ||
      typeof model.available !== "boolean" ||
      (model.supportsTools !== undefined && typeof model.supportsTools !== "boolean") ||
      (model.origin !== "legacy" && model.origin !== "catalog" && model.origin !== "local")
    )
      throw new Error("invalidAiSettings")
    modelIds.add(model.id)
  }
  if (value.activeModelId !== null && !modelIds.has(value.activeModelId as string)) {
    throw new Error("invalidAiSettings")
  }
  if (
    value.baseModelId !== undefined &&
    value.baseModelId !== null &&
    (typeof value.baseModelId !== "string" || !modelIds.has(value.baseModelId))
  ) {
    throw new Error("invalidAiSettings")
  }
  return value as unknown as AiConnectionsSettings
}

/** Resolve a selected model only when it is still explicitly available. */
export function resolveConnectedAiModel(settings: AiConnectionsSettings, modelId: string) {
  const model = selectableAiModels(settings).find((candidate) => candidate.id === modelId)
  if (!model) return null
  const connection = settings.connections.find((candidate) => candidate.id === model.connectionId)
  if (!connection) return null
  return {
    id: model.id,
    connectionId: connection.id,
    connectionLabel: connection.label,
    label: model.label,
    provider: cliProviderId(connection.method) ?? connection.provider,
    model: model.model,
    baseUrl: connection.baseUrl,
    credentialId: connection.credentialId,
    apiVersion: connection.apiVersion,
    supportsTools: model.supportsTools ?? (model.origin === "catalog" ? false : undefined),
  }
}

export function addLocalAiModel(
  settings: AiConnectionsSettings,
  connectionId: string,
  model: string,
  label: string,
): AiConnectionsSettings {
  const connection = settings.connections.find((candidate) => candidate.id === connectionId)
  const name = model.trim()
  if (!connection || !canAddLocalAiModel(connection) || !name) throw new Error("invalidAiModel")
  if (
    settings.models.some(
      (candidate) => candidate.connectionId === connectionId && candidate.model === name,
    )
  ) {
    throw new Error("duplicateAiModel")
  }
  return {
    ...settings,
    models: [
      ...settings.models,
      {
        id: crypto.randomUUID(),
        connectionId,
        model: name,
        label: label.trim() || name,
        enabled: true,
        available: true,
        origin: "local",
      },
    ],
  }
}

/** Project the versioned source into the existing chat transport shape. */
export function projectAiConnections(settings: AiConnectionsSettings): AiSettings {
  return {
    connectionSettings: settings,
    models: selectableAiModels(settings).flatMap((model) => {
      const resolved = resolveConnectedAiModel(settings, model.id)
      return resolved ? [resolved] : []
    }),
    activeModelId: settings.activeModelId,
  }
}

/** Only the active model may be changed through the legacy projection. */
export function serializeAiSettings(ai: AiSettings): AiSettings | AiConnectionsSettings {
  if (!ai.connectionSettings) return ai
  const current = projectAiConnections(ai.connectionSettings)
  if (JSON.stringify(ai.models) !== JSON.stringify(current.models))
    throw new Error("invalidAiMutation")
  if (
    ai.activeModelId !== ai.connectionSettings.activeModelId &&
    ai.activeModelId !== null &&
    !current.models.some((model) => model.id === ai.activeModelId)
  ) {
    throw new Error("invalidAiModel")
  }
  return { ...ai.connectionSettings, activeModelId: ai.activeModelId }
}
