import { describe, expect, it } from "vitest"
import {
  isLocalAiModel,
  modelSupportsTools,
  migrateLegacyAiKeys,
  type AiModel,
} from "../app-config"

const model = (baseUrl: string): AiModel => ({
  id: "test",
  label: "Test",
  provider: "openai",
  model: "model",
  baseUrl,
  apiVersion: "",
})

describe("AI model tool defaults", () => {
  // AI1-P2, AI1-U7: explicit settings override conservative endpoint defaults.
  it("classifies local addresses and defaults tool use by endpoint", () => {
    expect(isLocalAiModel(model("http://localhost:1234"))).toBe(true)
    expect(isLocalAiModel(model("http://192.168.2.3:1234"))).toBe(true)
    expect(isLocalAiModel(model("http://[::1]:1234"))).toBe(true)
    expect(isLocalAiModel(model("https://api.example.com"))).toBe(false)
    expect(isLocalAiModel(model("https://host.local"))).toBe(false)
    expect(modelSupportsTools(model("http://localhost:1234"))).toBe(false)
    expect(modelSupportsTools(model("https://api.example.com"))).toBe(true)
    expect(modelSupportsTools({ ...model("https://api.example.com"), supportsTools: false })).toBe(
      false,
    )
  })

  it("retains an explicitly configured tool capability when settings load", async () => {
    const original = { ...model("https://api.example.com"), supportsTools: false }
    const result = await migrateLegacyAiKeys({ models: [original], activeModelId: original.id })
    expect(result.ai.models[0].supportsTools).toBe(false)
  })
})
