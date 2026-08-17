// Frontend client for the Rust `ai_chat` command. All inference is routed
// through the Rust backend (so the webview CSP stays locked); this wrapper just
// resolves the call and, in browser-only dev mode, fails with a clear message.

import { isTauri } from "./storage"
import i18n from "./i18n"
import { commands } from "./bindings"
import type { AiConfig as GeneratedAiConfig, AiMessage as GeneratedAiMessage } from "./bindings"
import { listen } from "@tauri-apps/api/event"
import { unwrapCommand } from "./storage/ipc-result"

/** Wire "family" the Rust backend dispatches on. */
export type AiFamily = "ollama" | "openai" | "anthropic" | "azure"

/** Flat wire shape expected by the `ai_chat` Rust command (camelCase). */
export interface AiConfig {
  provider: AiFamily
  model: string
  baseUrl: string
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

export interface AiChatOptions {
  /** System prompt (e.g. the scoped note context). */
  system?: string
  /** When provided, response is streamed: each token delta is delivered here. */
  onToken?: (delta: string) => void
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

  if (!opts.onToken) {
    return unwrapCommand(
      commands.aiChat(toGeneratedConfig(config), toGeneratedMessages(messages), system, null),
    )
  }

  const streamId = crypto.randomUUID()
  const unlisten = await listen<{ streamId: string; delta: string }>("ai:token", (e) => {
    if (e.payload.streamId === streamId) opts.onToken!(e.payload.delta)
  })
  try {
    return await unwrapCommand(
      commands.aiChat(toGeneratedConfig(config), toGeneratedMessages(messages), system, streamId),
    )
  } finally {
    unlisten()
  }
}
