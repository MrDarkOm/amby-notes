// Frontend client for the Rust `ai_chat` command. All inference is routed
// through the Rust backend (so the webview CSP stays locked); this wrapper just
// resolves the call and, in browser-only dev mode, fails with a clear message.

import { isTauri, resolveAiChatRepository } from "./storage"
import i18n from "./i18n"
import { commands } from "./bindings"
import type {
  AiChatError as GeneratedAiChatError,
  AiConfig as GeneratedAiConfig,
  AiMessage as GeneratedAiMessage,
  AiTurnResult,
  CatalogModel,
  ChatSource,
  ClaudeStatus,
  CodexStatus,
} from "./bindings"
import { listen } from "@tauri-apps/api/event"
import { unwrapCommand } from "./storage/ipc-result"

/** Wire "family" the Rust backend dispatches on. */
export type AiFamily = "ollama" | "openai" | "anthropic" | "azure" | "codex" | "claude-code"

/** Flat wire shape expected by the `ai_chat` Rust command (camelCase). */
export interface AiConfig {
  provider: AiFamily
  internalModelId?: string | null
  model: string
  baseUrl: string
  credentialId?: string | null
  apiKey?: string | null
  maxTokens?: number | null
  /** Azure only: API version. */
  apiVersion?: string | null
}

export interface AiMessage {
  role: "user" | "assistant"
  content: string
}

function toGeneratedConfig(config: AiConfig): GeneratedAiConfig {
  return {
    ...config,
    internalModelId: config.internalModelId ?? null,
    credentialId: config.credentialId ?? null,
    apiKey: config.apiKey ?? null,
    maxTokens: config.maxTokens ?? null,
    apiVersion: config.apiVersion ?? null,
  }
}

function toGeneratedMessages(messages: AiMessage[]): GeneratedAiMessage[] {
  return messages
}

/** Thrown when AI is invoked outside the desktop app (no Rust backend). */
export class AiUnavailableError extends Error {
  constructor() {
    super(i18n.t("ai.unavailable"))
    this.name = "AiUnavailableError"
  }
}

export type AiErrorCode = GeneratedAiChatError["code"]
export type AiChatErrorPayload = GeneratedAiChatError

/** A localized error generated only from the backend's safe IPC error code. */
export class AiRequestError extends Error {
  readonly code: AiErrorCode
  readonly provider: string

  constructor({ code, provider }: AiChatErrorPayload) {
    super(
      provider === "codex" && code === "providerRejected"
        ? i18n.t("ai.errors.codexRejected")
        : provider === "codex" && code === "missingCredential"
          ? i18n.t("ai.errors.codexSignedOut")
          : provider === "claude-code" && code === "agentBoundary"
            ? i18n.t("ai.errors.claudeBoundary")
            : provider === "claude-code" && code === "providerRejected"
              ? i18n.t("ai.errors.claudeRejected")
              : provider === "claude-code" && code === "missingCredential"
                ? i18n.t("ai.errors.claudeSignedOut")
                : i18n.t(`ai.errors.${code}`),
    )
    this.name = "AiRequestError"
    this.code = code
    this.provider = provider
  }
}

export function aiErrorMessage(error: unknown): string {
  if (error instanceof AiUnavailableError || error instanceof AiRequestError) return error.message
  return i18n.t("ai.errors.requestFailed")
}

export interface AiChatOptions {
  /** System prompt (e.g. the scoped note context). */
  system?: string
  /** When provided, response is streamed: each token delta is delivered here. */
  onToken?: (delta: string) => void
  /** Abort signal to cancel the ongoing request on the backend. */
  signal?: AbortSignal
}

export interface AiTurnEvent {
  streamId: string
  sequence: number
  kind: "token" | "toolStart" | "toolEnd" | "done" | "error"
  payload: {
    delta?: string
    tool?: string
    query?: string
    noteIds?: string[]
    source?: ChatSource | null
    error?: unknown
  }
}

export interface AiTurnOptions extends AiChatOptions {
  generation: number
  noteIds: string[]
  folders: string[]
  initialSources: ChatSource[]
  searchEnabled: boolean
  supportsTools: boolean
  onEvent?: (event: AiTurnEvent) => void
}

export async function aiSearchConsent(generation: number, config: AiConfig): Promise<string> {
  return resolveAiChatRepository().consent(generation, toGeneratedConfig(config))
}

export async function aiSetSearchConsent(
  generation: number,
  config: AiConfig,
  allowed: boolean,
): Promise<void> {
  return resolveAiChatRepository().setConsent(generation, toGeneratedConfig(config), allowed)
}

/**
 * Whether the program of a local provider is on this computer; `null` when it cannot be told
 * (browser development, or a provider the app does not know).
 */
export async function aiLocalAppInstalled(provider: string): Promise<boolean | null> {
  if (!isTauri()) return null
  try {
    const result = await commands.aiLocalAppInstalled(provider)
    return result.status === "ok" ? result.data : null
  } catch {
    return null
  }
}

/** Whether the user's own Codex can be used; outside the desktop app it is "missing". */
export async function aiCodexStatus(): Promise<CodexStatus> {
  if (!isTauri()) return { installed: false, supported: false, signedIn: false }
  try {
    return await commands.aiCodexStatus()
  } catch {
    return { installed: false, supported: false, signedIn: false }
  }
}

/** Sign in to ChatGPT inside Amby's own Codex: opens the browser and resolves when done. */
export async function aiCodexLogin(): Promise<void> {
  if (!isTauri()) throw new AiUnavailableError()
  const result = await commands.aiCodexLogin()
  if (result.status !== "ok") throw new AiRequestError(result.error)
}

/** Stops a sign-in that is waiting for the browser. */
export async function aiCodexLoginCancel(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await commands.aiCodexLoginCancel()
  } catch {
    return false
  }
}

export async function aiCodexLogout(): Promise<void> {
  if (!isTauri()) throw new AiUnavailableError()
  const result = await commands.aiCodexLogout()
  if (result.status !== "ok") throw new AiRequestError(result.error)
}

/** Whether the user's own Claude Code can be used; outside the desktop app it is "missing". */
export async function aiClaudeStatus(): Promise<ClaudeStatus> {
  if (!isTauri()) return { installed: false, supported: false, signedIn: false }
  try {
    return await commands.aiClaudeStatus()
  } catch {
    return { installed: false, supported: false, signedIn: false }
  }
}

/** Sign in to Claude inside Amby's own Claude Code: the browser opens, resolves when done. */
export async function aiClaudeLogin(): Promise<void> {
  if (!isTauri()) throw new AiUnavailableError()
  const result = await commands.aiClaudeLogin()
  if (result.status !== "ok") throw new AiRequestError(result.error)
}

/** Stops a sign-in that is waiting for the browser. */
export async function aiClaudeLoginCancel(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await commands.aiClaudeLoginCancel()
  } catch {
    return false
  }
}

export async function aiClaudeLogout(): Promise<void> {
  if (!isTauri()) throw new AiUnavailableError()
  const result = await commands.aiClaudeLogout()
  if (result.status !== "ok") throw new AiRequestError(result.error)
}

/** Run one turn against a specific vault activation. */
export async function aiRunTurn(
  config: AiConfig,
  messages: AiMessage[],
  opts: AiTurnOptions,
): Promise<AiTurnResult> {
  if (!isTauri()) throw new AiUnavailableError()
  const streamId = crypto.randomUUID()
  const onAbort = () => {
    void cancelAiChat(streamId)
  }
  if (opts.signal?.aborted) throw new Error("Request cancelled")
  opts.signal?.addEventListener("abort", onAbort, { once: true })
  let unlisten: (() => void) | null = null
  let sequence = 0
  try {
    unlisten = await listen<AiTurnEvent>("ai:event", ({ payload }) => {
      if (opts.signal?.aborted || payload.streamId !== streamId || payload.sequence <= sequence)
        return
      sequence = payload.sequence
      if (payload.kind === "token" && typeof payload.payload.delta === "string")
        opts.onToken?.(payload.payload.delta)
      opts.onEvent?.(payload)
    })
    if (opts.signal?.aborted) throw new Error("Request cancelled")
    const result = await commands.aiRunTurn({
      generation: opts.generation,
      config: toGeneratedConfig(config),
      messages: toGeneratedMessages(messages),
      system: opts.system ?? null,
      noteIds: opts.noteIds,
      folders: opts.folders,
      initialSources: opts.initialSources,
      searchEnabled: opts.searchEnabled,
      supportsTools: opts.supportsTools,
      streamId,
    })
    if (opts.signal?.aborted) throw new Error("Request cancelled")
    if (result.status === "ok") return result.data
    throw new AiRequestError(result.error)
  } finally {
    opts.signal?.removeEventListener("abort", onAbort)
    unlisten?.()
  }
}

/** Fetch a transport catalogue; a later request may abort this one. */
export async function aiModelCatalog(
  config: AiConfig,
  signal?: AbortSignal,
): Promise<CatalogModel[]> {
  if (!isTauri()) throw new AiUnavailableError()
  if (signal?.aborted) throw new Error("Request cancelled")
  const streamId = crypto.randomUUID()
  const onAbort = () => {
    void cancelAiChat(streamId)
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const result = await commands.aiModelCatalog(toGeneratedConfig(config), streamId)
    if (signal?.aborted) throw new Error("Request cancelled")
    if (result.status === "ok") return result.data
    throw new AiRequestError(result.error)
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}

/**
 * Cancel an ongoing AI request by its stream ID.
 */
export async function cancelAiChat(streamId: string): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await unwrapCommand(commands.cancelAiRequest(streamId))
  } catch {
    return false
  }
}

/**
 * Send a chat completion request. Returns the full assistant text. When
 * `onToken` is given the answer is streamed (token deltas arrive via the
 * `ai:token` event) and the resolved value is the final accumulated text.
 */
export async function aiChat(
  config: AiConfig,
  messages: AiMessage[],
  opts: AiChatOptions = {},
): Promise<string> {
  if (!isTauri()) throw new AiUnavailableError()
  const system = opts.system ?? null
  const streamId = crypto.randomUUID()

  const onAbort = () => {
    void cancelAiChat(streamId)
  }

  if (opts.signal) {
    if (opts.signal.aborted) {
      void cancelAiChat(streamId)
      throw new Error("Request cancelled")
    }
    opts.signal.addEventListener("abort", onAbort, { once: true })
  }

  let unlisten: (() => void) | null = null
  try {
    if (opts.onToken) {
      unlisten = await listen<{ streamId: string; delta: string }>("ai:token", (e) => {
        if (!opts.signal?.aborted && e.payload.streamId === streamId) opts.onToken!(e.payload.delta)
      })
    }
    // Cancellation can happen while the event listener is being registered, before
    // the backend has a request to cancel. Never start that request afterwards.
    if (opts.signal?.aborted) throw new Error("Request cancelled")
    const result = await commands.aiChat(
      toGeneratedConfig(config),
      toGeneratedMessages(messages),
      system,
      streamId,
    )
    if (opts.signal?.aborted) throw new Error("Request cancelled")
    if (result.status === "ok") return result.data
    throw new AiRequestError(result.error)
  } finally {
    if (opts.signal) {
      opts.signal.removeEventListener("abort", onAbort)
    }
    if (unlisten) {
      unlisten()
    }
  }
}
