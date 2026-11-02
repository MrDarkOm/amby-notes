import { describe, expect, it } from "vitest"
import { findProvider, resolveAiConfig, isClaudeCodeModel, isCliAgentModel } from "../app-config"
import {
  AI_CONNECTION_PROVIDERS,
  cliProviderId,
  projectAiConnections,
  readAiConnections,
  resolveConnectedAiModel,
  selectableAiModels,
  type AiConnectionsSettings,
} from "./connections"

const claude: AiConnectionsSettings = {
  version: 1,
  activeModelId: "m1",
  connections: [
    {
      id: "c1",
      provider: "anthropic",
      method: "claude-cli",
      label: "Claude Code",
      baseUrl: "",
      credentialId: "claude-session:1",
      apiVersion: "",
    },
    {
      id: "c2",
      provider: "anthropic",
      method: "api",
      label: "API",
      baseUrl: "",
      credentialId: "key",
      apiVersion: "",
    },
  ],
  models: [
    {
      id: "m1",
      connectionId: "c1",
      model: "opus",
      label: "Opus",
      enabled: true,
      available: true,
      origin: "catalog",
      supportsTools: true,
    },
    {
      id: "m2",
      connectionId: "c2",
      model: "claude-sonnet",
      label: "Sonnet",
      enabled: true,
      available: true,
      origin: "catalog",
    },
  ],
}

describe("Claude Code CLI connection", () => {
  it("is offered for Anthropic next to the API, and only there", () => {
    const methods = (id: string) => AI_CONNECTION_PROVIDERS.find((p) => p.id === id)?.methods
    expect(methods("anthropic")).toEqual(["api", "claude-cli"])
    expect(methods("openai")).toEqual(["api", "codex-cli"])
    expect(methods("ollama")).toEqual(["api"])
    expect(AI_CONNECTION_PROVIDERS.some((p) => p.id === "claude-code")).toBe(false)
  })

  it("maps methods to wire provider ids", () => {
    expect(cliProviderId("claude-cli")).toBe("claude-code")
    expect(cliProviderId("codex-cli")).toBe("codex")
    expect(cliProviderId("api")).toBeNull()
  })

  it("accepts the stored shape and keeps the API connection of the same provider apart", () => {
    expect(readAiConnections(JSON.parse(JSON.stringify(claude)))).toEqual(claude)
    expect(selectableAiModels(claude).map((m) => m.id)).toEqual(["m1", "m2"])
  })

  it("rejects an unknown method", () => {
    const bad = JSON.parse(JSON.stringify(claude))
    bad.connections[0].method = "gemini-cli"
    expect(() => readAiConnections(bad)).toThrow("invalidAiSettings")
  })

  it("resolves a CLI model to the claude-code family without endpoint or key use", () => {
    const resolved = resolveConnectedAiModel(claude, "m1")!
    expect(resolved).toMatchObject({ provider: "claude-code", model: "opus", supportsTools: true })
    expect(resolveConnectedAiModel(claude, "m2")).toMatchObject({ provider: "anthropic" })
    const config = resolveAiConfig({ ...resolved, baseUrl: "", apiVersion: "" })
    expect(config).toMatchObject({ provider: "claude-code", model: "opus", baseUrl: "" })
  })

  it("is a catalog model without a tools claim until the catalog says so", () => {
    const off = { ...claude, models: [{ ...claude.models[0], supportsTools: undefined }] }
    expect(resolveConnectedAiModel(off, "m1")?.supportsTools).toBe(false)
  })

  it("is recognised as a CLI agent and not as a local model", () => {
    const model = projectAiConnections(claude).models[0]
    expect(isClaudeCodeModel(model)).toBe(true)
    expect(isCliAgentModel(model)).toBe(true)
    expect(isCliAgentModel(projectAiConnections(claude).models[1])).toBe(false)
    expect(findProvider("claude-code")?.family).toBe("claude-code")
  })
})
