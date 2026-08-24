import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { aiChat, aiErrorMessage, cancelAiChat, AiRequestError, AiUnavailableError } from "./ai"
import { commands } from "./bindings"

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}))

describe("ai client and cancellation (WP-21)", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {},
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("throws AiUnavailableError in web fallback mode", async () => {
    vi.stubGlobal("window", {})
    await expect(
      aiChat({ provider: "ollama", model: "llama3.2", baseUrl: "" }, [
        { role: "user", content: "hello" },
      ]),
    ).rejects.toThrow(AiUnavailableError)
  })

  it("invokes commands.aiChat with serialized config and system prompt", async () => {
    const aiChatSpy = vi.spyOn(commands, "aiChat").mockResolvedValue({
      status: "ok",
      data: "Response text",
    })

    const reply = await aiChat(
      {
        provider: "openai",
        model: "gpt-4o",
        baseUrl: "https://api.openai.com",
        credentialId: "cred-123",
      },
      [{ role: "user", content: "What is Amby?" }],
      { system: "System context" },
    )

    expect(reply).toBe("Response text")
    expect(aiChatSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o",
        credentialId: "cred-123",
      }),
      [{ role: "user", content: "What is Amby?" }],
      "System context",
      expect.any(String),
    )
  })

  it("localizes a typed backend error without exposing request details", async () => {
    vi.spyOn(commands, "aiChat").mockResolvedValue({
      status: "error",
      error: { code: "network", provider: "openai" },
    } as Awaited<ReturnType<typeof commands.aiChat>>)

    await expect(
      aiChat({ provider: "openai", model: "gpt-4o", baseUrl: "https://example.invalid" }, [
        { role: "user", content: "hello" },
      ]),
    ).rejects.toBeInstanceOf(AiRequestError)
    expect(aiErrorMessage(new AiRequestError({ code: "network", provider: "openai" }))).toContain(
      "подключ",
    )
  })

  it("cancels ongoing request when AbortSignal fires", async () => {
    const cancelSpy = vi.spyOn(commands, "cancelAiRequest").mockResolvedValue({
      status: "ok",
      data: true,
    })

    vi.spyOn(commands, "aiChat").mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Request cancelled")), 50)
        }),
    )

    const controller = new AbortController()

    const promise = aiChat(
      { provider: "anthropic", model: "claude-3-5", baseUrl: "" },
      [{ role: "user", content: "Stream this" }],
      {
        signal: controller.signal,
        onToken: () => {},
      },
    )

    controller.abort()

    await expect(promise).rejects.toThrow()
    expect(cancelSpy).toHaveBeenCalled()
  })

  it("cancels request via cancelAiChat directly", async () => {
    const cancelSpy = vi.spyOn(commands, "cancelAiRequest").mockResolvedValue({
      status: "ok",
      data: true,
    })

    const result = await cancelAiChat("stream-uuid-1")
    expect(result).toBe(true)
    expect(cancelSpy).toHaveBeenCalledWith("stream-uuid-1")
  })
})
