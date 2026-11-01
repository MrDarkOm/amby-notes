// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import "@/lib/i18n"
import { AI_PROVIDERS } from "../app-config"
import { ProviderIcon } from "./provider-icon"
import { hasProviderMark, markMarkup, modelMark, PROVIDER_MARK } from "./provider-marks"

afterEach(cleanup)

describe("Provider icons", () => {
  it("has a mark for the well-known providers and none for the rest", () => {
    for (const id of [
      "openai",
      "anthropic",
      "ollama",
      "lmstudio",
      "azure",
      "openrouter",
      "groq",
      "mistral",
      "codex",
    ])
      expect(hasProviderMark(id), id).toBe(true)
    for (const id of ["mlx", "llamacpp", "my-own", ""]) expect(hasProviderMark(id), id).toBe(false)
  })

  it("covers every provider that is offered, or falls back to the cloud or disk icon", () => {
    for (const provider of AI_PROVIDERS) {
      const { container, unmount } = render(
        <ProviderIcon providerId={provider.id} kind={provider.kind} />,
      )
      expect(container.querySelector("svg"), provider.id).not.toBeNull()
      unmount()
    }
  })

  it("draws a mark with the current text color and hides it from screen readers by default", () => {
    const { container } = render(<ProviderIcon providerId="openai" kind="cloud" />)
    const svg = container.querySelector("svg")!
    expect(svg.getAttribute("fill")).toBe("currentColor")
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24")
    expect(svg.getAttribute("aria-hidden")).toBe("true")
    expect(svg.querySelector("title")).toBeNull()
  })

  it("names the provider when asked to", () => {
    render(<ProviderIcon providerId="ollama" kind="local" label="Ollama" />)
    expect(screen.getByRole("img", { name: "Ollama" })).toBeTruthy()
  })

  it("falls back to the kind icon, which names where the model runs", () => {
    render(<ProviderIcon providerId="mlx" kind="local" />)
    expect(screen.getByRole("img", { name: "локально" })).toBeTruthy()
    cleanup()
    render(<ProviderIcon providerId="custom" kind="cloud" />)
    expect(screen.getByRole("img", { name: "облако" })).toBeTruthy()
  })

  it("uses nothing but static, trusted markup: no scripts, handlers or links", () => {
    for (const id of [
      "openai",
      "anthropic",
      "ollama",
      "lmstudio",
      "azure",
      "openrouter",
      "groq",
      "mistral",
    ]) {
      const { container, unmount } = render(<ProviderIcon providerId={id} kind="cloud" />)
      const html = container.innerHTML.toLowerCase()
      expect(html).not.toContain("<script")
      expect(html).not.toMatch(/\son[a-z]+=/)
      expect(html).not.toContain("href")
      unmount()
    }
  })
  it("recognizes the family of a model by its id", () => {
    const cases: Array<[string, string | null]> = [
      ["gpt-5.6-sol", "openai"],
      ["o3-mini", "openai"],
      ["openai/gpt-4o", "openai"],
      ["claude-opus-5-5", "claude"],
      ["opus", "claude"],
      ["anthropic/claude-3.5-sonnet", "claude"],
      ["gemini-2.5-pro", "gemini"],
      ["gemma3:4b", "gemma"],
      ["llama3.2:3b", "meta"],
      ["meta-llama/llama-3.3-70b", "meta"],
      ["deepseek-r1", "deepseek"],
      ["qwen2.5-coder", "qwen"],
      ["grok-4", "grok"],
      ["mixtral-8x7b", "mistral"],
      ["command-r-plus", "cohere"],
      ["glm-4.6", "zhipu"],
      ["kimi-k2", "kimi"],
      ["my-own-model", null],
      ["promo-1", null],
      ["", null],
    ]
    for (const [id, mark] of cases) expect(modelMark(id), id).toBe(mark)
  })

  it("draws the Claude mark, not the company mark, for Anthropic", () => {
    expect(PROVIDER_MARK.anthropic).toBe("claude")
    const { container } = render(<ProviderIcon providerId="anthropic" kind="cloud" />)
    expect(container.querySelector("svg")?.innerHTML).toBe(markMarkup("claude"))
  })

  it("prefers the mark of the model's family over its provider's", () => {
    const { container } = render(
      <ProviderIcon providerId="openrouter" modelId="google/gemini-2.5-pro" kind="cloud" />,
    )
    expect(container.querySelector("svg")?.innerHTML).toBe(markMarkup("gemini"))
    const fallback = render(
      <ProviderIcon providerId="openrouter" modelId="unknown-model" kind="cloud" />,
    )
    expect(fallback.container.querySelector("svg")?.innerHTML).toBe(markMarkup("openrouter"))
  })
})
