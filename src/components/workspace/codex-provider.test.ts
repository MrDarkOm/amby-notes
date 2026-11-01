import { describe, expect, it } from "vitest"
import {
  changeProvider,
  codexStatusKey,
  findProvider,
  isCodexModel,
  isLocalAiModel,
  resolveAiConfig,
} from "./app-config"
import type { AiModel } from "./app-config"

const codexModel: AiModel = {
  id: "codex",
  label: "Codex",
  provider: "codex",
  model: "",
  baseUrl: "",
  apiVersion: "",
}

describe("Codex (ChatGPT) provider", () => {
  it("is a cloud provider with its own wire family and no API key", () => {
    const provider = findProvider("codex")
    expect(provider?.family).toBe("codex")
    expect(provider?.kind).toBe("cloud")
    expect(provider?.needsKey).toBe(false)
    expect(provider?.label).toContain("Codex")
  })

  it("is never classified as a local model, whatever base URL is stored", () => {
    expect(isLocalAiModel(codexModel)).toBe(false)
    expect(isLocalAiModel({ ...codexModel, baseUrl: "http://localhost:11434" })).toBe(false)
  })

  it("resolves to the codex family with an empty model meaning the Codex default", () => {
    expect(resolveAiConfig(codexModel)).toMatchObject({
      provider: "codex",
      model: "",
      baseUrl: "",
      apiVersion: null,
    })
  })

  it("recognises Codex models and only those", () => {
    expect(isCodexModel(codexModel)).toBe(true)
    expect(isCodexModel({ ...codexModel, provider: "openai" })).toBe(false)
  })

  it("maps the backend status to one hint for the settings screen", () => {
    expect(codexStatusKey({ installed: false, supported: false, signedIn: false })).toBe("missing")
    expect(codexStatusKey({ installed: true, supported: false, signedIn: false })).toBe(
      "unsupported",
    )
    expect(codexStatusKey({ installed: true, supported: true, signedIn: false })).toBe("signedOut")
    expect(codexStatusKey({ installed: true, supported: true, signedIn: true })).toBe("ready")
  })
})

describe("changing a model's provider", () => {
  const ollama: AiModel = {
    id: "m",
    label: "Mine",
    provider: "ollama",
    model: "llama3.2",
    baseUrl: "http://localhost:11434",
    apiVersion: "",
    supportsTools: true,
  }

  it("drops the previous provider's model name and endpoint when moving to Codex", () => {
    const next = changeProvider(ollama, "codex")
    expect(next).toMatchObject({ provider: "codex", model: "", baseUrl: "" })
    expect(next.id).toBe("m")
    expect(next.label).toBe("Mine")
  })

  it("starts from the new provider's own defaults for any other provider", () => {
    expect(changeProvider(ollama, "openai")).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "",
    })
  })

  it("keeps the credential, which belongs to the model entry, and the tools choice only for the same kind", () => {
    const withKey: AiModel = { ...ollama, credentialId: "cred" }
    expect(changeProvider(withKey, "openai").credentialId).toBe("cred")
    expect(changeProvider(ollama, "codex").supportsTools).toBeUndefined()
  })

  it("does nothing for the provider already chosen or an unknown one", () => {
    expect(changeProvider(ollama, "ollama")).toBe(ollama)
    expect(changeProvider(ollama, "nonsense")).toBe(ollama)
  })
})
