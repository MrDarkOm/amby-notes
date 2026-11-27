import { describe, expect, it } from "vitest"
import "@/lib/i18n"
import { AiRequestError } from "./ai"

describe("Codex rejections", () => {
  it("point at the model name and the ChatGPT limits, not at an API key", () => {
    const message = new AiRequestError({ code: "providerRejected", provider: "codex" }).message
    expect(message).toContain("Codex")
    expect(message).not.toContain("ключ")
  })

  it("keep the ordinary wording for other providers", () => {
    const message = new AiRequestError({ code: "providerRejected", provider: "openai" }).message
    expect(message).toContain("ключ")
  })

  it("tell a signed-out Codex to sign in from the model settings, not to look for a key", () => {
    const message = new AiRequestError({ code: "missingCredential", provider: "codex" }).message
    expect(message).toContain("Войти через ChatGPT")
    expect(message).not.toContain("ключ")
  })

  it("explain a boundary stop in words and not as a raw message key", () => {
    const message = new AiRequestError({ code: "agentBoundary", provider: "codex" }).message
    expect(message).not.toContain("ai.errors")
    expect(message).toContain("Codex")
  })
})
