// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { ModelsManager } from "./models-manager"
import type { AiModel, AiSettings } from "./app-config"
import * as ai from "@/lib/ai"
import * as storage from "@/lib/storage"

vi.mock("@/lib/ai", async (original) => ({
  ...(await original<typeof import("@/lib/ai")>()),
  aiCodexStatus: vi.fn(),
  aiCodexLogin: vi.fn(),
  aiCodexLoginCancel: vi.fn(),
  aiCodexLogout: vi.fn(),
}))

const ollama: AiModel = {
  id: "a",
  label: "Домашняя",
  provider: "ollama",
  model: "llama3.2",
  baseUrl: "",
  apiVersion: "",
}
const openai: AiModel = {
  id: "b",
  label: "Облачная",
  provider: "openai",
  model: "gpt-4o-mini",
  baseUrl: "",
  apiVersion: "",
}
const settings: AiSettings = { models: [ollama, openai], activeModelId: "a" }

function show(next: AiSettings = settings) {
  const onChange = vi.fn()
  render(<ModelsManager ai={next} onChange={onChange} />)
  return onChange
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ai.aiCodexStatus).mockResolvedValue({
    installed: true,
    supported: true,
    signedIn: false,
  })
})
afterEach(cleanup)

describe("Models screen as a list", () => {
  it("opens only the active model's settings and lists the others as rows", () => {
    show()
    expect(screen.getAllByLabelText("Провайдер")).toHaveLength(1)
    expect(screen.getByRole("button", { name: /Облачная/ })).toBeTruthy()
    expect(screen.getByDisplayValue("Домашняя")).toBeTruthy()
  })

  it("opens another row on click and closes the first", () => {
    show()
    fireEvent.click(screen.getByRole("button", { name: /Облачная/ }))
    expect(screen.getAllByLabelText("Провайдер")).toHaveLength(1)
    expect(screen.getByDisplayValue("Облачная")).toBeTruthy()
    expect(screen.queryByDisplayValue("Домашняя")).toBeNull()
  })

  it("marks the active model and lets another one be made active from the list", () => {
    const onChange = show()
    const group = screen.getByRole("radiogroup")
    const radios = within(group).getAllByRole("radio")
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"])
    fireEvent.click(radios[1])
    expect(onChange).toHaveBeenCalledWith({ ...settings, activeModelId: "b" })
  })

  it("shows the provider's mark left of the name, the provider under it, and where it runs", () => {
    show()
    const cloud = screen.getByRole("button", { name: /Облачная/ })
    const local = screen.getByRole("button", { name: /Домашняя/ })
    expect(within(cloud).getByRole("img", { name: "облако" })).toBeTruthy()
    expect(within(local).getByRole("img", { name: "локально" })).toBeTruthy()
    expect(within(cloud).queryByRole("img", { name: "локально" })).toBeNull()
    expect(cloud.textContent).toContain("OpenAI")
    expect(cloud.textContent).not.toContain("·")
    const mark = cloud.querySelector("svg[aria-hidden]")
    const name = within(cloud).getByText("Облачная")
    const provider = within(cloud).getByText("OpenAI")
    const where = within(cloud).getByRole("img", { name: "облако" })
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(mark).not.toBeNull()
    expect(follows(mark!, name)).toBe(true)
    expect(follows(name, provider)).toBe(true)
    expect(follows(provider, where)).toBe(true)
  })

  it("deletes a model with a plain text button inside its settings", () => {
    const onChange = show()
    fireEvent.click(screen.getByRole("button", { name: "Удалить модель" }))
    return vi.waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ models: [openai], activeModelId: "b" }),
    )
  })

  it("keeps a credential still used by another model", async () => {
    const remove = vi.spyOn(storage, "deleteAiCredential").mockResolvedValue()
    const first = { ...ollama, credentialId: "shared" }
    const second = { ...openai, credentialId: "shared" }
    const onChange = show({ models: [first, second], activeModelId: first.id })
    fireEvent.click(screen.getByRole("button", { name: "Удалить модель" }))
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(remove).not.toHaveBeenCalled()
    remove.mockRestore()
  })

  it("switches tools with a switch instead of a checkbox", () => {
    const onChange = show()
    const toggle = screen.getByRole("switch", { name: "Модель поддерживает инструменты" })
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith({
      ...settings,
      models: [{ ...ollama, supportsTools: true }, openai],
    })
  })
})

describe("Codex connection block", () => {
  const codex: AiModel = {
    id: "c",
    label: "Terra",
    provider: "codex",
    model: "",
    baseUrl: "",
    apiVersion: "",
  }

  it("keeps status and the sign-in button together in one block", async () => {
    show({ models: [codex], activeModelId: "c" })
    const button = await screen.findByRole("button", { name: "Войти через ChatGPT" })
    const block = button.closest("[data-codex-connection]")
    expect(block).not.toBeNull()
    expect(block!.textContent).toContain("Вы не вошли")
  })

  it("has no URL, key or tools settings for Codex", async () => {
    show({ models: [codex], activeModelId: "c" })
    await screen.findByRole("button", { name: "Войти через ChatGPT" })
    expect(screen.queryByText("Base URL")).toBeNull()
    expect(screen.queryByRole("switch")).toBeNull()
  })
})
