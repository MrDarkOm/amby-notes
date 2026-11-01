import type { AiConnectionsSettings } from "./connections"
import type { AiFamily } from "@/lib/ai"

/** A selectable provider in the model editor. Maps a friendly name to a wire
 *  `family` (what Rust dispatches on) plus sensible connection defaults. */
export interface ProviderInfo {
  id: string
  label: string
  family: AiFamily
  kind: "local" | "cloud"
  defaultBaseUrl: string
  defaultModel: string
  needsKey: boolean
  /** Azure-only: the field is shown and a default offered. */
  azure?: boolean
  /** Local only: the program's official download page, offered when it is not on the computer. */
  installUrl?: string
}

/** Local options first (most popular), then cloud. */
export const AI_PROVIDERS: ProviderInfo[] = [
  {
    id: "ollama",
    label: "Ollama",
    family: "ollama",
    kind: "local",
    defaultBaseUrl: "http://localhost:11434",
    defaultModel: "llama3.2",
    needsKey: false,
    installUrl: "https://ollama.com/download",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    family: "openai",
    kind: "local",
    defaultBaseUrl: "http://localhost:1234",
    defaultModel: "local-model",
    needsKey: false,
    installUrl: "https://lmstudio.ai/download",
  },
  {
    id: "mlx",
    label: "MLX",
    family: "openai",
    kind: "local",
    defaultBaseUrl: "http://localhost:8080",
    defaultModel: "mlx-community/Llama-3.2-3B-Instruct-4bit",
    needsKey: false,
    installUrl: "https://github.com/ml-explore/mlx-lm",
  },
  {
    id: "llamacpp",
    label: "llama.cpp",
    family: "openai",
    kind: "local",
    defaultBaseUrl: "http://localhost:8080",
    defaultModel: "default",
    needsKey: false,
    installUrl: "https://github.com/ggml-org/llama.cpp",
  },
  {
    // The user's own Codex CLI signed in with ChatGPT; no API key, no endpoint.
    id: "codex",
    label: "Codex (ChatGPT)",
    family: "codex",
    kind: "cloud",
    defaultBaseUrl: "",
    defaultModel: "",
    needsKey: false,
  },
  {
    // The user's own Claude Code CLI signed in with a Claude account; no API key, no endpoint.
    id: "claude-code",
    label: "Claude Code",
    family: "claude-code",
    kind: "cloud",
    defaultBaseUrl: "",
    defaultModel: "",
    needsKey: false,
  },
  {
    id: "openai",
    label: "OpenAI",
    family: "openai",
    kind: "cloud",
    defaultBaseUrl: "https://api.openai.com",
    defaultModel: "gpt-4o-mini",
    needsKey: true,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    family: "anthropic",
    kind: "cloud",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModel: "claude-3-5-haiku-latest",
    needsKey: true,
  },
  {
    id: "azure",
    label: "Azure OpenAI",
    family: "azure",
    kind: "cloud",
    defaultBaseUrl: "",
    defaultModel: "",
    needsKey: true,
    azure: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    family: "openai",
    kind: "cloud",
    defaultBaseUrl: "https://openrouter.ai/api",
    defaultModel: "openai/gpt-4o-mini",
    needsKey: true,
  },
  {
    id: "groq",
    label: "Groq",
    family: "openai",
    kind: "cloud",
    defaultBaseUrl: "https://api.groq.com/openai",
    defaultModel: "llama-3.3-70b-versatile",
    needsKey: true,
  },
  {
    id: "mistral",
    label: "Mistral",
    family: "openai",
    kind: "cloud",
    defaultBaseUrl: "https://api.mistral.ai",
    defaultModel: "mistral-small-latest",
    needsKey: true,
  },
]

export function findProvider(id: string): ProviderInfo | undefined {
  return AI_PROVIDERS.find((p) => p.id === id)
}

/** One configured model in the user's library (the chat picks from these). */
export interface AiModel {
  /** Set for projected models so the picker distinguishes connections. */
  connectionId?: string
  connectionLabel?: string
  id: string
  label: string
  /** ProviderInfo.id */
  provider: string
  model: string
  baseUrl: string
  credentialId?: string | null
  /** Azure only. */
  apiVersion: string
  /** Undefined uses the default for the configured endpoint. */
  supportsTools?: boolean
}

/** AI settings = a library of models + which one is active. Secrets are stored
 *  in the OS Keychain / Credential Manager under credentialId. */
export interface AiSettings {
  /** Versioned source; models below are a read-only projection for the chat. */
  connectionSettings?: AiConnectionsSettings
  models: AiModel[]
  activeModelId: string | null
}
