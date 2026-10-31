// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import "@/lib/i18n"
import { AI_PROVIDERS } from "../app-config"
import { ProviderIcon } from "./provider-icon"
import { hasProviderMark } from "./provider-marks"

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
})
